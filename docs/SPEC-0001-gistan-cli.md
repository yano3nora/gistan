# SPEC-0001: gistan CLI

## Overview

gistan は、gist を普通の git repo で管理するための Deno + TypeScript 製 CLI。repo が Source of
Truth、gist は公開面であり、同期は明示コマンドのみ行う。設計背景は
[ADR-0001](./ADR-0001-repo-as-source-of-truth.md) / [ADR-0002](./ADR-0002-one-directory-one-gist.md)
/ [ADR-0003](./ADR-0003-gist-id-directory-and-description-metadata.md) を正とする。

## Goals

- 数百件規模の gist を local repo で検索・編集できる
- single-file / multi-file の区別なく、gist 単位で publish / pull / unpublish できる
- local / remote drift を status / push / pull が同じ照合エンジンで判定する
- 他人の starred gist は read-only cache として検索対象にできる

## Non-Goals

- バックグラウンド同期・自動双方向同期
- Obsidian / Evernote 代替、TUI、独自エディタ
- 他人 gist への書き戻し
- gh を迂回した GitHub API client / token 管理
- tags 機能。v2 では全面廃止し、必要になったら再検討する
- dirname によるユーザー分類。dirname はツール管理領域であり、ユーザーに命名・grouping させない
  (ADR-0003)

## Terms

- `gist repo`: gists を集約する local git repo。Source of Truth。直接編集してよい
- `gist dir`: `gists/<dirname>/`。**1 directory = 1 gist**。dirname はツール管理領域で、published
  なら gist-id、未 publish なら local-id
- `local-id`: 未 publish の gist dir に振る `_` 始まりの採番文字列 (例 `_a1b2c3d4`)。gist-id
  と衝突しない。`new` が採番するが、ユーザーが手で作った任意名の dir も「index に載っていない = 未
  publish」として同様に扱う
- `gist file`: gist dir 直下の通常ファイル。remote gist の file と byte 一致する (例外なし)
- `description`: gist の description。repo 内にファイルとしては置かず、index
  のメタデータとして持つ。`new -d` / `publish -d` で設定し、`pull` が remote に追従する
- `index`: `.gistan/state.json`。published gist の visibility / description / 同期時点の hash
  等と、description を持つ未 publish dir のメタデータを保持し、repo に commit する
- `star mirror`: `stars/` 配下の read-only cache
- `drift`: 最終同期時点から local または remote が変更された状態

## Layout

```text
<gist-repo>/
├ gists/<gist-id>/<files...>   # published。1 dir = 1 gist、depth 1 only
├ gists/<local-id>/<files...>  # 未 publish (`_` 始まり)。publish 成功時に <gist-id> へ rename
├ stars/<owner>/<gist-id>/     # read-only mirror。gitignore 対象
├ .gistan/state.json           # index v3。commit 対象
└ .gistan/cache/stars.json     # star mirror cache (`star sync`/`star add` が更新)。gitignore 対象
```

- `gists/` 直下の裸ファイルは非管理。`status` が warn する
- `gists/a/b/c.md` のような depth 2+ は gist 化不可。`status` が warn し、`publish` は拒否する
- published 判定は index が正。dirname の形式そのものには意味を持たせない (手動で `gists/_drafts/`
  を作ってもよい)

### Config (`~/.config/gistan/config.toml`)

- `repo` (必須): gist repo の絶対 path
- `viewer` (任意): search / grep の ctrl-v が選択 file を渡すコマンド (例:
  `viewer = "leaf"`)。手で追記する。`root init` の再実行では保持される。fzf の execute()
  制約により括弧を含むコマンドは不可

## Index v3

```jsonc
{
  "version": 3,
  "gists": {
    "abc123...": { // key = dirname = gist id
      "visibility": "public",
      "description": "", // 最終同期時点の remote description
      "remote_updated_at": "2026-07-08T00:00:00Z",
      "files": {
        "filename.md": "sha256:..."
      }
    }
  },
  "locals": {
    "_a1b2c3d4": { "description": "..." } // description を持つ未 publish dir のみ
  }
}
```

- `gists` は published のみ。`locals` は `new -d` で description を付けた未 publish dir
  のみ載せ、description なしの未 publish dir は filesystem だけで表現する
- description は「最終同期時点の値」を持つ。local 側で description だけが drift する状態は存在しない
  (`publish -d` が即時反映するため)
- key はソートして保存する
- v1 / v2 state を読んだら migration せず、再 import を案内して停止する (ADR-0003 Migration Notes)

## Reconcile

status / push / pull / publish の drift 判断は `src/core/reconcile.ts` に集約する。

- dir: `unpublished`, `dir-missing`, `remote-deleted`
- file: `local-drift`, `remote-drift`, `conflict`, `in-sync`, `remote-unknown`
- local drift は file hash の追加・変更・削除で判定する。description の drift は remote 側のみ
  (remote description != index description → remote-drift の一部として `pull` が追従)

## Commands

```text
gistan new [-d <desc>] [--id <id>] [--publish [--public]] <filename>
gistan search [query] [--path|-p]
gistan grep [query] [--path|-p]
gistan edit [query]
gistan list [--published|--local|--stars]
gistan publish <id|url> [--secret|--public] [-d <desc>]
gistan unpublish <id|url>
gistan rm [query]
gistan push
gistan pull
gistan status [--remote] [--fix] [--all] [id]
gistan import [--limit <n>]
gistan root init [dir]
gistan root path
gistan root commit [-m <msg>]
gistan root push
gistan root pull
gistan root status
gistan star sync
gistan star add <gist-url>
```

### Key behavior

- `new filename.md` は local-id を採番して `gists/<local-id>/filename.md` を作る。`new dir/file.md`
  は受け付けない (gist に階層が存在しないため)。制御文字 (tab / newline 等) を含む filename
  も拒否する (行・フィールドベースの検索表示を壊すため)。既存 gist へのファイル追加は
  `--id <id|local-id>` で行う。`-d` の値は index (`locals`) に保存する。`--id` が published gist
  を指す場合、`-d` は `--publish` 併用時のみ受け付け、単独なら `publish -d` を案内してエラー (index
  の description は 常に最終同期値であるため)。`--publish` は作成 → editor → gist 化まで行う
  (可視性は default secret、`--public` で public)。終了時に実体 path と id (published なら gist URL)
  を必ず表示する
- `publish <id|url>` は dir 全体を gist として作成・更新する。**id / URL 指定のみ**
  (dirname・filename query は受け付けない。id は search の ctrl-y
  で取得する)。確認プロンプトに対象の filename 一覧と内容の軽い preview を表示する。新規作成成功時は
  local-id → gist-id へ dir を rename する。update は変更ファイルだけ送り、削除ファイルは `null`
  を送る。`-d` は description を index に保存した上で remote へ反映する。可視性変更は recreate =
  **URL が変わる** ため確認必須。順序は create → local 切替 (rename + index) → 旧 gist 削除で、
  途中失敗しても「重複が残る」だけで削除済みだけの状態にはならない (旧 gist の削除失敗は warn +
  手動削除の案内)。remote 反映後の local 切替に失敗した場合は成功を装わず、復旧手順 (`status --fix`
  / `import`) を明示してエラー終了する。新規作成のデフォルト可視性は secret。public は `--public`
  の明示指定のみ (誤公開防止。`gh gist create` のデフォルトとも一致)
- `unpublish <id|url>` は remote gist を削除し、dir を新しい local-id へ rename する (削除済み gist
  の id は dangling URL なので使い回さない)。description は `locals` へ引き継ぐ
- `rm` はファイル単位。published gist の最後の 1 ファイルなら gist ごと削除する確認を出す
- `push` は published gist の local drift を全列挙 → 対話確認 (yes で一括 publish)。未 publish dir
  は対象外 (誤公開防止。gist 化は `new --publish` か個別 `publish` の明示操作)。conflict は skip
  して `status` へ誘導する
- `pull` は remote drift を全列挙 → 対話確認 (yes で一括取り込み)。conflict / remote-deleted は skip
  して `status` へ誘導する。truncated (>1MB) file を含む gist は **何も適用せず** skip して手動取得
  (git clone) を案内する — 部分的な remote 像で local file を消して同期済みにしない (`status --fix`
  の remote 適用も同じ)。旧仕様の per-dir `pull [dirname]` は廃止
- `status` は既定 offline。`--remote` で remote drift を見る。`--fix` は対話修復 (conflict の diff
  提示 + 選択 / dir-missing / remote-deleted の解決先) で、doctor コマンドは存在しない。git status
  同様、既定では対応が必要な condition (`unpublished` / `local-drift` / `remote-drift` / `conflict`
  / `remote-deleted` / `dir-missing`) だけ列挙し、`in-sync` と `remote-unknown` (= published)
  は隠す。`--all` で従来の全件列挙に戻る。id を指定した場合はその item を condition
  に関わらず表示する。summary 行 (`N gist(s): ...`) は常に出る (TASK-260708)
- `import` は multi-file gist をそのまま `gists/<gist-id>/` に取り込み、description は index
  に保存する (ファイルは作らない)。同じ gist id が index にあれば skip する
- `star sync` は starred gist 一覧を `stars/<owner>/<gist-id>/` へ差分 mirror する
  (TASK-260706)。判定は `.gistan/cache/stars.json` の `updated_at` とミラー dir
  の存在で行い、両方揃っていれば `gists/{id}` の GET をスキップする冪等設計。starred から外れた gist
  の mirror dir / cache entry は確認なしで削除する — mirror は GitHub から再取得可能な cache
  であり、gist repo 本体 (index) とは削除の重みが違うため。`star add <gist-url|id>` は指定 gist を
  star (`PUT gists/{id}/star`) してその場で 1 件 mirror する。URL は
  `https://gist.github.com/<owner>/<id>`、`https://gist.github.com/<id>`、裸の `<id>`
  のいずれも末尾セグメントを id として受理する。star の description は cache にのみ持つ
- `search` は document (= file) 単位の検索 (TASK-260708 followup 3)。fzf は `--disabled` +
  `--ansi` + `--layout=reverse` で動き、キーストローク毎の reload が gistan 自身の隠しサブコマンド
  `__search-render {q}` を呼んで一覧を TypeScript で描画する (sh 断片の quoting / zsh
  依存を排除)。一覧の並びは renderer が決める (path ヒット群 → 本文のみ群、各段 path 昇順)
  ため、layout は明示的に top-down 固定 — fzf 素の bottom-up だと先頭 (= 上位)
  が画面最下段に来てしまう。query 仕様は search 独自の Google 風で fzf の演算子ではない:
  - **空白区切り = file 単位の順不同 AND**、`!term` = その term を含む file を除外。term は常に
    case-insensitive の literal (regex ではない。`'` `^` `$` も普通の文字)
  - **display path から gist-id / local-id を隠す**: `gists/<id>/file.md` は
    `file.md`、`stars/<owner>/<id>/file.md` は `stars/<owner>/file.md` と表示する。ユーザーには
    flatten な filename 管理として見せる (ADR-0003)。id が必要な操作は ctrl-y (後述) で賄う
  - マッチ対象は内容 + display path + **description** (index / stars cache から引く)。一覧は 2
    段構成: **display path または description に正 term を含む file 群が先、本文のみヒットの file
    群が後**。各段内は display path 昇順 — これ以上のスコアリング (出現回数等)
    は決定性・クラスタ性を壊すため行わない。行の形式は `display_path:line: ヒット前後の抜粋` (前後
    ~60 文字、切れた端は `…`)。path のみヒットの file は path だけの行。description がある file
    は行末に dim で補助表示し、同名 filename の判別に使う (description 未設定同士の同名は preview
    で判別する)。term のヒット箇所は色付けされる
  - 空 query (または正 term なし) は全 file の一覧
  - Enter は選択行の `:line:` へそのまま jump して editor を開く。editor は `$EDITOR` (未設定時
    `vi`) を使い、invocation-wide の `--editor <command>` / `-e <command>` で一時上書きできる。
    preview も自己呼び出し
    (`<self> __preview`) で TypeScript 描画: `bat` があれば syntax highlight を敷き (無ければ
    plain)、全 term の一致箇所を reverse video (SGR 7)
    で強調して最初の一致行付近へ位置合わせ、実ファイルの行番号を各行に表示する。反転は色状態に
    触れないため bat の配色と共存できる
    (色での強調は ANSI と干渉するので不可)。preview pane は wrap がデフォルト (fzf の preview に横
    scroll は存在しないため、折り返さないと長行の続きを読む手段がない)。shift-up / shift-down で
    scroll、ctrl-/ で wrap の toggle (コードや表の桁揃えを見たいとき用)。ctrl-u は query
    の全消去。ctrl-o は選択中 item の gist URL をブラウザで開く (fzf は抜けない)。未 publish dir
    だけが no-op
  - **ctrl-y は選択中 item の id / URL を clipboard へコピーする** (published / star は gist URL、未
    publish は local-id)。`publish <id>` / `unpublish <id>` / `new --id` への導線。ctrl-c は fzf の
    abort と衝突するため使わない
  - ctrl-v は選択中 file を config の `viewer` コマンド (例: markdown viewer) に渡す。viewer を quit
    すると fzf に戻る。`viewer` 未設定なら bind 自体を張らない
- `grep` は旧 search の行レベル regex 検索 (query 全体が 1 本の rg
  regex、キーストローク毎に再実行)。「一致行を正確に探す」場面用に温存。表示 (id 除去 + path
  sort)、preview (一致 span は `rg --json` から取得し、選択行 `{2}`
  付近へ位置合わせ)、ctrl-o、ctrl-y、ctrl-v、`--path|-p` は search と同等
- `list` の表示も search と同じ display path (id 除去) + description 補助表示とする

### git 操作: gistan root

repo 自体の git 操作 (setup / GitHub origin との push・pull) は日常操作 (検索・publish・drift 確認)
と挙動が混同されやすいため、`gistan root` 名前空間へ隔離している (TASK-260708)。旧 `gistan init` は
`gistan root init` に、旧 `gistan sync` (add + commit + pull --rebase + push を一括実行) は
`gistan root commit / push / pull` の個別コマンドに置き換わった。

- `root init [dir]`: 旧 `gistan init` と同じ挙動 (repo scaffold + config 書き込み)
- `root path`: repo の絶対 path を stdout へ (`cd $(gistan root path)` 用)
- `root commit [-m <msg>]`: `git add -A` + commit。`-m`
  無指定時は固定の自動メッセージ。ステージ対象が無ければ `nothing to commit` で正常終了する
- `root push` / `root pull`: それぞれ `git push` / `git pull --rebase` を repo
  に対して実行する。remote 未設定などの失敗は git 自身の exit code / stderr
  をそのまま伝播し、再ラップしない
- `root status`: `git status` を repo に対して実行する。push / pull と同じ「再ラップしない
  passthrough」(TASK-260708)
- gist の `push` / `pull` (drift 同期) と repo の `root push` / `root pull` (git 操作) は別物。help
  とエラーメッセージで相互に案内する
- 旧コマンド名を打った場合は案内エラーを出す: `gistan init` → `gistan root init` を、`gistan sync` →
  `gistan root commit / push / pull` を案内する

### 完全糖衣: `gistan <query>` = `gistan search <query>`

`gistan` の第一引数が `-h|--help` / `--version` / 既知の command 名 / removed command hint (`init` /
`sync`) のいずれでもなければ、argv 全体をそのまま `gistan search` へ委譲する (TASK-260708)。flag
も含めて素通しするため `gistan -p foo` は `gistan search -p foo` として動く — 旧実装は `parseArgs`
が先に `-p` を食ってしまい、search まで届かなかった。

- 判定順序: (1) 引数なし → `search []`、(2) `-h|--help` / `--version`、(3) removed command hint、(4)
  既知 command 名 → dispatch、(5) それ以外 → argv 全体を `search` へ
- tradeoff: command の typo (`gistan pubish`) も search fallback になる。search は対話的 fzf
  なので誤爆に即気づけると判断し許容する。query が command 名と衝突するときは `gistan search list`
  と明示する (`s` alias は一時導入したが command を増やしすぎないため廃止した)

## Invariants

- repo が Source of Truth。repo 外の永続状態は config のみ
- 同期直後、gist file と remote gist file は byte 一致する (v3 で `.description.txt`
  の例外が消え、例外なし)
- repo を隠さない。直接 rm / mv / 編集してよく、乖離は `status --fix` で検出・修復する
- GitHub API は `gh api` subprocess 経由のみ
- `stars/` は publish / fix 対象外の read-only cache
- 破壊的操作は確認を挟む。conflict は push / pull で自動解決せず `status --fix` で人間が選ぶ

## Edge Cases

- **gh 未認証・ネットワーク断**: remote を触るコマンドのみ失敗し、明確なエラーを出す。local
  系コマンド (`search` / `grep` / `edit` / `list` / `root`) は常に動く。`root push` / `root pull`
  は例外で、GitHub origin と通信するため git 自身のネットワークエラーで失敗しうる

## Open Questions

- tags を本当に戻すか。v2 では廃止済み
- index merge conflict が実害化した場合、per-gist sidecar に分割するか
- integration / e2e で実 gist を使う範囲
- `push` に未 publish dir を含めるか (現状含めない。ADR-0003 Open Questions)
- description のマッチ・補助表示が search レイテンシ (TASK-260712-search-latency)
  を悪化させる場合の縮退
