# SPEC-0001: gistan CLI

## Overview

gistan は、gist を普通の git repo で管理するための Deno + TypeScript 製 CLI。repo が Source of Truth、gist は公開面であり、同期は明示コマンドのみ行う。設計背景は [ADR-0001](./ADR-0001-repo-as-source-of-truth.md) と [ADR-0002](./ADR-0002-one-directory-one-gist.md) を正とする。

## Goals

- 数百件規模の gist を local repo で検索・編集できる
- single-file / multi-file の区別なく、gist 単位で publish / pull / unpublish できる
- local / remote drift を status / pull / publish が同じ照合エンジンで判定する
- 他人の starred gist は read-only cache として検索対象にできる

## Non-Goals

- バックグラウンド同期・自動双方向同期
- Obsidian / Evernote 代替、TUI、独自エディタ
- 他人 gist への書き戻し
- gh を迂回した GitHub API client / token 管理
- tags 機能。v2 では全面廃止し、必要になったら再検討する

## Terms

- `gist repo`: gists を集約する local git repo。Source of Truth。直接編集してよい
- `gist dir`: `gists/<dirname>/`。**1 directory = 1 gist**
- `gist file`: gist dir 直下の通常ファイル。remote gist の file と byte 一致する
- `.description.txt`: gist description 専用の予約ファイル。trim 後の内容を description に使うが、gist file としては絶対に upload しない
- `index`: `.gistan/state.json`。published gist の id / visibility / synced hash 等を保持し、repo に commit する
- `star mirror`: `stars/` 配下の read-only cache
- `drift`: 最終同期時点から local または remote が変更された状態

## Layout

```text
<gist-repo>/
├ gists/<dirname>/<files...>   # depth 1 only。1 dir = 1 gist
├ stars/                       # read-only cache。gitignore 対象
└ .gistan/state.json           # index v2。commit 対象
```

- `gists/` 直下の裸ファイルは非管理。`status` が warn する
- `gists/a/b/c.md` のような depth 2+ は gist 化不可。`status` が warn し、`publish` は拒否する
- `.description.txt` は予約名。import 対象 gist が同名ファイルを含む場合は warn して skip する

### Config (`~/.config/gistan/config.toml`)

- `repo` (必須): gist repo の絶対 path
- `viewer` (任意): search / grep の ctrl-v が選択 file を渡すコマンド (例: `viewer = "leaf"`)。手で追記する。`root init` の再実行では保持される。fzf の execute() 制約により括弧を含むコマンドは不可

## Index v2

```jsonc
{
  "version": 2,
  "gists": {
    "dirname": {
      "id": "abc123",
      "visibility": "public",
      "remote_updated_at": "2026-07-08T00:00:00Z",
      "synced_description_hash": null,
      "files": {
        "filename.md": "sha256:..."
      }
    }
  }
}
```

- index には published gist のみ載せる。未 publish の dir は filesystem だけで表現する
- key はソートして保存する
- v1 state を読んだら migration せず、再 import を案内して停止する

## Reconcile

status / pull / publish の drift 判断は `src/core/reconcile.ts` に集約する。

- dir: `unpublished`, `dir-missing`, `remote-deleted`
- file / description: `local-drift`, `remote-drift`, `conflict`, `in-sync`, `remote-unknown`
- local drift は file hash の追加・変更・削除、または `.description.txt` trim 後 hash の差分で判定する

## Commands

```text
gistan new [-d <desc>] <filename|dirname/filename>
gistan search [query] [--path|-p]
gistan grep [query] [--path|-p]
gistan edit [query]
gistan list [--published|--local|--stars]
gistan publish [query] [--secret|--public]
gistan unpublish [query]
gistan rm [query]
gistan pull [dirname]
gistan status [--remote] [--fix] [--all] [dirname]
gistan import [--limit <n>]
gistan root init [dir]
gistan root path
gistan root commit [-m <msg>]
gistan root push
gistan root pull
gistan root status
```

### Key behavior

- `new filename.md` は `gists/filename/filename.md` を作る。`new dir/file.md` は `gists/dir/file.md` を作る。`-d` 指定時だけ `.description.txt` を生成する
- `publish` は dir 全体を gist として作成・更新する。`.description.txt` は description にのみ使い、files payload に含めない。可視性変更は delete + recreate のため確認必須
- 新規作成のデフォルト可視性は secret。public は `--public` の明示指定のみ (誤公開防止。`gh gist create` のデフォルトとも一致)
- update は変更ファイルだけ送る。削除ファイルは `null` を送る。`.description.txt` 削除は remote description clear として扱う
- `rm` はファイル単位。published gist の最後の 1 ファイルなら gist ごと削除する確認を出す
- `pull` は remote 内容で dir を上書きする。conflict は確認する。全件一括 pull は提供しない
- `status` は既定 offline。`--remote` で remote drift を見る。`--fix` は旧 doctor 相当の対話修復で、doctor コマンドは存在しない。git status 同様、既定では対応が必要な condition (`unpublished` / `local-drift` / `remote-drift` / `conflict` / `remote-deleted` / `dir-missing`) だけ列挙し、`in-sync` と `remote-unknown` (= published) は隠す。`--all` で従来の全件列挙に戻る。dirname を指定した場合はその item を condition に関わらず表示する。summary 行 (`N gist(s): ...`) は常に出る (TASK-260708)
- `import` は multi-file gist をそのまま `gists/<dirname>/` に取り込み、description が非空なら `.description.txt` を必ず作る。同じ gist id が index にあれば skip する
- `search` は document (= file) 単位の検索 (TASK-260708 followup 3)。fzf は `--disabled` + `--ansi` + `--layout=reverse` で動き、キーストローク毎の reload が gistan 自身の隠しサブコマンド `__search-render {q}` を呼んで一覧を TypeScript で描画する (sh 断片の quoting / zsh 依存を排除)。一覧の並びは renderer が決める (path ヒット群 → 本文のみ群、各段 path 昇順) ため、layout は明示的に top-down 固定 — fzf 素の bottom-up だと先頭 (= 上位) が画面最下段に来てしまう。query 仕様は search 独自の Google 風で fzf の演算子ではない:
  - **空白区切り = file 単位の順不同 AND**、`!term` = その term を含む file を除外。term は常に case-insensitive の literal (regex ではない。`'` `^` `$` も普通の文字)
  - マッチ対象は内容 + display path (dirname / filename)。一覧は 2 段構成: **display path に正 term を含む file 群が先、本文のみヒットの file 群が後** (dirname / filename ヒットの方が強いシグナル)。各段内は display path 昇順 — これ以上のスコアリング (出現回数等) は決定性・クラスタ性を壊すため行わない。行の形式は `display_path:line: ヒット前後の抜粋` (前後 ~60 文字、切れた端は `…`)。path のみヒットの file は path だけの行。display path は `gists/` を除去し `stars/` は残す。term のヒット箇所は色付けされる
  - 空 query (または正 term なし) は全 file の一覧
  - Enter は選択行の `:line:` へそのまま jump して editor を開く。preview も自己呼び出し (`<self> __preview`) で TypeScript 描画: `bat` があれば syntax highlight を敷き (無ければ plain)、全 term の一致箇所を reverse video (SGR 7) で強調して最初の一致行付近へ位置合わせる。反転は色状態に触れないため bat の配色と共存できる (色での強調は ANSI と干渉するので不可)。preview pane は wrap がデフォルト (fzf の preview に横 scroll は存在しないため、折り返さないと長行の続きを読む手段がない)。shift-up / shift-down で scroll、ctrl-/ で wrap の toggle (コードや表の桁揃えを見たいとき用)。ctrl-u は query の全消去。ctrl-o は選択中 item の gist URL をブラウザで開く (fzf は抜けない。未 publish dir と `stars/*` は no-op)
  - ctrl-v は選択中 file を config の `viewer` コマンド (例: markdown viewer) に渡す。viewer を quit すると fzf に戻る。`viewer` 未設定なら bind 自体を張らない
- `grep` は旧 search の行レベル regex 検索 (query 全体が 1 本の rg regex、キーストローク毎に再実行)。「一致行を正確に探す」場面用に温存。表示 (`gists/` 除去 + path sort)、preview (一致 span は `rg --json` から取得し、選択行 `{2}` 付近へ位置合わせ)、ctrl-o、ctrl-v、`--path|-p` は search と同等 (TASK-260708 followup 2)

### git 操作: gistan root

repo 自体の git 操作 (setup / GitHub origin との push・pull) は日常操作 (検索・publish・drift 確認) と挙動が混同されやすいため、`gistan root` 名前空間へ隔離している (TASK-260708)。旧 `gistan init` は `gistan root init` に、旧 `gistan sync` (add + commit + pull --rebase + push を一括実行) は `gistan root commit / push / pull` の個別コマンドに置き換わった。

- `root init [dir]`: 旧 `gistan init` と同じ挙動 (repo scaffold + config 書き込み)
- `root path`: repo の絶対 path を stdout へ (`cd $(gistan root path)` 用)
- `root commit [-m <msg>]`: `git add -A` + commit。`-m` 無指定時は固定の自動メッセージ。ステージ対象が無ければ `nothing to commit` で正常終了する
- `root push` / `root pull`: それぞれ `git push` / `git pull --rebase` を repo に対して実行する。remote 未設定などの失敗は git 自身の exit code / stderr をそのまま伝播し、再ラップしない
- `root status`: `git status` を repo に対して実行する。push / pull と同じ「再ラップしない passthrough」(TASK-260708)
- 旧コマンド名を打った場合は案内エラーを出す: `gistan init` → `gistan root init` を、`gistan sync` → `gistan root commit / push / pull` を案内する

### 完全糖衣: `gistan <query>` = `gistan search <query>`

`gistan` の第一引数が `-h|--help` / `--version` / 既知の command 名 / removed command hint (`init` / `sync`) のいずれでもなければ、argv 全体をそのまま `gistan search` へ委譲する (TASK-260708)。flag も含めて素通しするため `gistan -p foo` は `gistan search -p foo` として動く — 旧実装は `parseArgs` が先に `-p` を食ってしまい、search まで届かなかった。

- 判定順序: (1) 引数なし → `search []`、(2) `-h|--help` / `--version`、(3) removed command hint、(4) 既知 command 名 → dispatch、(5) それ以外 → argv 全体を `search` へ
- tradeoff: command の typo (`gistan pubish`) も search fallback になる。search は対話的 fzf なので誤爆に即気づけると判断し許容する。query が command 名と衝突するときは `gistan search list` と明示する (`s` alias は一時導入したが command を増やしすぎないため廃止した)

## Invariants

- repo が Source of Truth。repo 外の永続状態は config のみ
- 同期直後、gist file と remote gist file は byte 一致する。ただし `.description.txt` は予約メタデータであり remote file ではない
- repo を隠さない。直接 rm / mv / 編集してよく、乖離は `status --fix` で検出・修復する
- GitHub API は `gh api` subprocess 経由のみ
- `stars/` は publish / fix 対象外の read-only cache
- 破壊的操作は確認を挟む

## Edge Cases

- **gh 未認証・ネットワーク断**: remote を触るコマンドのみ失敗し、明確なエラーを出す。local 系コマンド (`search` / `grep` / `edit` / `list` / `root`) は常に動く。`root push` / `root pull` は例外で、GitHub origin と通信するため git 自身のネットワークエラーで失敗しうる

## Open Questions

- tags を本当に戻すか。v2 では廃止済み
- index merge conflict が実害化した場合、per-gist sidecar に分割するか
- integration / e2e で実 gist を使う範囲
