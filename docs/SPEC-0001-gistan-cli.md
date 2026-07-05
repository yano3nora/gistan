# SPEC-0001: gistan CLI

## Overview

gist 向け snippets を集約する markdown repo (= gist repo) の構成・運用を補助する CLI「gistan」の仕様。
アーキテクチャ上の決定は [ADR-0001](./ADR-0001-repo-as-source-of-truth.md) を前提とする。

体験の目標は「Zenn の GitHub 連携の gist 版」:
普段は repo に雑に書き捨て、公開したい snippet だけ gist へ publish し、公開停止・可視性・remote 編集の取り込みまで repo を起点に管理できる。

## Goals

- 大量 (数百〜) の snippets を local で高速に検索・閲覧・編集できる
- snippet 単位で gist への publish / unpublish / 更新が冪等にでき、URL がすぐ手に入る
- 今見ている snippet が gist 化されているか・drift していないかが分かる
- 他人の starred gist を read-only mirror して検索対象に含められる
- 新マシンで `install → gistan init` だけで環境が再現できる

## Non-Goals

- バックグラウンド・自動での双方向同期 (同期は明示的コマンドのみ)
- 汎用メモツール化 (Obsidian / Evernote 代替、独自エディタ・ビューア・TUI)
- 他人の gist への編集・書き戻し
- チーム向けアクセス制御 (gist の public / secret 以上のことはしない)
- gist API の認証・token 管理の自前実装 (gh に相乗り)

## Milestones

個人開発の最大リスクは完成前の失速であるため、価値が出る最短の縦切りを v1 とし、日常利用を先に始める。

- **v1 (MVP)**: `init` / `import` / `search` / `publish` / `status` — 「既存 753 gist を取り込み、探し、公開できる」まで
- **v2**: `pull` / `doctor` (v1 で作る照合エンジンの拡張) + 運用糖衣 (`new` / `edit` / `list` / `rm` / `unpublish` / `sync` / `root`)
- **v3**: `star` (楽しいが価値の中心ではないため最後に回す)

## Terms

- `gist repo`
    - snippets を集約する git repo。Source of Truth。普通のディレクトリとして直接操作してよい
- `snippet`
    - gist repo 内の 1 ファイル。markdown に限らない (`.md`, `.tsx`, `.sh`, ...)
- `published snippet`
    - index 上で gist ID と紐付いた snippet。ファイル内容と gist 内容は byte 一致が原則
- `index`
    - `.gistan/state.json`。snippet のメタデータ (gist ID, tags, 可視性, 同期時点の hash 等) を保持する。repo にコミットする
- `star mirror`
    - `stars/` 配下に取り込んだ他人の gist の read-only コピー
- `drift`
    - 最終同期時点と比べて local または remote が変更されている状態

## Behavior

### セットアップ: `gistan init`

1. `gh auth status` を確認 (未認証なら `gh auth login` を案内して終了)
2. gist repo を GitHub 上に作成 (default: private) または既存 repo を clone (2 台目のマシンはこちら)
3. `~/.config/gistan/config.toml` に repo の local path を記録
4. repo 内に `snippets/` `stars/` `.gistan/` と template、`.gitignore` (`stars/` と `.gistan/cache/` を除外) を配置 (既存なら何もしない)

### 作成: `gistan new [--tags <t1,t2>] <filename>`

- 引数はパスではなく**ファイル名のみ**。`snippets/` プレフィックスは付けず、gistan が `snippets/<filename>` に解決する
    - 例: `gistan new --tags react,example countdown-timer.tsx` → `snippets/countdown-timer.tsx` を作成し、index に tags を登録して `$EDITOR` で開く
- `/` を含む引数 (ディレクトリ指定) はエラー。フラット構造の強制が規律の源泉 (gist の「構造を考えなくていい」体験の再現)
- 同名ファイルが既に存在する場合はエラーとし、`gistan edit <filename>` を案内する
- 拡張子は任意。`.md` の場合のみ template を適用する
- なお repo を隠さない原則 (ADR-0001) により、人間が手で掘った階層があっても他コマンド (search / publish / status 等) は repo 相対パスとして正しく扱う。フラットの強制は「gistan が作らない」という導線レベルに留め、検査や警告はしない

### 検索・閲覧・編集: `gistan search [query]` / `gistan edit [query]` / `gistan list`

- `search`: rg + fzf によるライブ全文検索。`snippets/` と `stars/` の両方を対象とし、選択したら `$EDITOR` (stars は read-only 表示) で開く
- `edit`: ファイル名 fuzzy 選択 → `$EDITOR`
- `list [--tag <t>] [--published | --local | --stars]`: 一覧表示。published なら gist URL・可視性も表示
- これらは糖衣であり、`cd $(gistan root)` して直接 rg / vim を使う操作を常に許容する

### 公開: `gistan publish <path> [--secret] [--description <text>]`

- 未 publish なら gist を新規作成し、gist ID・可視性・content hash・remote `updated_at` を index に記録
- publish 済みなら gist を更新 (冪等)
- gist の description は `[tag1][tag2]: <filename>` 形式で tags から自動生成 (既存 gist の命名慣習を踏襲)
- 成功時に gist URL を標準出力 + クリップボードへコピー
- **可視性の変更 (public ⇔ secret) は gist API 非対応のため delete + 再作成となる。URL が変わることを警告し確認を取る**

### 公開停止: `gistan unpublish <path>`

- remote gist を削除し、index から gist 紐付けを除去。local ファイルは残す
- URL・コメント・fork が失われることを警告し確認を取る

### 取り込み: `gistan pull [path]`

- published snippets について remote の変更を取得する (スマホ等で gist を直接編集したケースの回収)
- remote のみ変更 → local へ反映。local のみ変更 → 何もしない (publish を案内)
- **両方変更 (conflict) → diff を提示し、local 優先 / remote 優先 / skip を人間が選ぶ。自動マージはしない**
- `--stars` 付きで star mirror も更新する

### 状態確認: `gistan status [path]`

- snippet ごとに「未公開 / 公開中 (public|secret, URL) / local drift / remote drift / conflict」を表示
- path 省略時は repo 全体のサマリ

### 整合性検査: `gistan doctor`

- index・local ファイル・remote gist の三者を突き合わせ、以下を検出して対話的に修復する
    - repo から消えたのに gist に残っている「孤児 gist」→ unpublish or ファイル復元
    - index にあるが実体がないエントリ → content hash による mv 先の再リンク提案 or エントリ削除
    - remote で削除済みの gist を指すエントリ → 紐付け解除
    - index の破損・重複

### star mirror: `gistan star sync` / `gistan star add <gist-url>`

- `sync`: GitHub 上で star 済みの gist (`GET /gists/starred`) を `stars/<owner>/<gist-id>/` へ mirror する
- `add`: 指定 gist を API で star し、続けて mirror する
- mirror は read-only。publish / doctor の修復対象外
- `stars/` は **commit しない** (gitignore 対象)。他人のコンテンツを repo 履歴に恒久保存しない (ライセンス面)・repo を肥大させないため、GitHub の star 一覧から常に再構築できる cache として扱う。別マシンでは `star sync` し直す
- mirror の管理情報 (fetched_at 等) も committed index ではなく `.gistan/cache/stars.json` (gitignore 対象) に置く

### 移行: `gistan import` (一度きり)

- 自分の全 gist (約 753 件) を paging しながら取得し、`snippets/` と index へ取り込む
- 単一ファイル gist → 1 snippet。multi-file gist → `snippets/<description-slug>/` 配下にディレクトリとして保持 (v1 では閲覧・検索のみ対象)
- description の `[tag]` 群を tags として index に逆輸入する
- **取り込み後、commit 前に secret スキャン (gitleaks) を実行し、検出があれば commit をブロックして報告する。スキャン通過を import の完了条件とする**

### git 操作: `gistan sync` / `gistan root`

- `sync`: `git add -A && git commit -m "docs: auto sync" && git pull --rebase && git push` の糖衣
- `root`: gist repo の絶対パスを出力 (`cd $(gistan root)` 用)

## Invariants

- gist repo が常に Source of Truth。gistan は config (`~/.config/gistan/`) 以外の状態を repo 外に持たない
- published snippet のファイル内容と gist 内容は、同期直後において byte 一致する (メタデータをファイルへ埋め込まない)
- 直接のファイル操作 (rm / mv / 編集) で repo は壊れない。index との乖離は doctor で必ず検出・修復できる
- remote の変更が local へ入る経路は `pull` (と doctor の対話的修復) のみ
- `stars/` は read-only mirror であり publish 対象にならない
- 破壊的操作 (unpublish、可視性変更による URL 変更、doctor の修復) は必ず事前に警告と確認を挟む

## Edge Cases / Failure Modes

- **可視性変更**: API 非対応のため delete + 再作成。URL 変更・コメント喪失を警告 (再掲、最重要)
- **gist 側で手動削除済み**: publish / status / doctor が 404 を検出し、index の紐付け解除を提案
- **publish 済みファイルの直接 rm / mv**: その時点では何も起きない。doctor が孤児 gist / 迷子エントリとして検出
- **conflict (local と remote が両方変更)**: 自動解決しない。pull 時に diff 提示 → 人間が選択
- **rate limit**: import / star sync は paging + backoff で対応。それ以外のコマンドは単発 API 呼び出しのため実質問題にならない
- **gh 未認証・ネットワーク断**: remote を触るコマンドのみ失敗し、明確なエラーを出す。local 系コマンド (search / edit / list / root) は常に動く
- **index の merge conflict (複数マシン)**: 発生時は git conflict として人間が解決。頻発するなら per-file sidecar 化を検討 (ADR-0001 Open Questions)
- **secret スキャン検出 (import 時)**: commit をブロックし、該当ファイル・該当行を報告。除外・マスク後に再実行

## API / Interface

### コマンド一覧

```
gistan init                                   # セットアップ (作成 or clone)
gistan new [--tags <t1,t2>] <filename>        # snippet 作成
gistan search [query]                         # rg + fzf ライブ全文検索 (stars 含む)
gistan edit [query]                           # fuzzy 選択して $EDITOR
gistan list [--tag <t>] [--published|--local|--stars]
gistan publish <path> [--secret] [--description <text>]
gistan unpublish <path>
gistan pull [path] [--stars]
gistan status [path]
gistan doctor
gistan star sync | gistan star add <gist-url>
gistan import                                 # 既存 gist 一括移行 (一度きり)
gistan sync                                   # git add/commit/pull/push
gistan root                                   # repo パス出力
```

### gist repo レイアウト

```
<gist-repo>/
├ snippets/               # 自分の snippets (フラット。import 由来の multi-file gist のみディレクトリ)
├ stars/<owner>/<id>/     # 他人の gist の read-only mirror (gitignore 対象の再取得可能な cache)
└ .gistan/
   ├ state.json           # index (コミットする)
   ├ cache/               # star manifest 等の local cache (gitignore 対象)
   └ templates/           # new 用 template
```

### index (`.gistan/state.json`) スキーマ

```jsonc
{
  "version": 1,
  "snippets": {
    "snippets/countdown-timer.tsx": {
      "tags": ["react", "example"],
      "gist": {                      // 未 publish なら null
        "id": "abc123...",
        "visibility": "public",      // "public" | "secret"
        "synced_hash": "sha256:...", // 最終同期時点のファイル内容 hash (local drift 検出用)
        "remote_updated_at": "2026-07-05T00:00:00Z" // 最終同期時点の remote 更新時刻 (remote drift 検出用)
      }
    }
  }
}
```

- key はファイルの repo 相対パス。エントリは key でソートして書き出す (diff 安定化・merge conflict 緩和)
- star mirror の管理情報は committed index には含めず `.gistan/cache/stars.json` に分離する (stars は cache であり repo の状態ではないため)

### config (`~/.config/gistan/config.toml`)

```toml
repo = "/Users/yano3/notes"   # gist repo の local path
# editor / clipboard コマンドは $EDITOR / OS 標準 (pbcopy 等) を利用
```

### 実装・依存

- 実装: Deno + TypeScript。サブコマンド構成は Deno 標準 (`@std/cli`) を基本とし、依存は最小限に保つ
- 配布: `deno compile` による単一バイナリ (または開発機では `deno install -g`)
- 外部依存 CLI: `gh` (認証・API), `git`, `rg`, `fzf`, `gitleaks` (import 時のみ)
    - GitHub API は自前 HTTP client を持たず `gh api` の subprocess 経由で呼ぶ (`Deno.Command`)
    - `init` 実行時に外部 CLI の存在を検査し、不足があればインストール方法を案内する
- **照合エンジンの単一化**: `status` / `pull` / `doctor` は「index・local・remote の三者照合」という同一ロジックの別ビューである。単一の reconcile モジュールとして実装し、3 コマンドは判定結果の表示・適用方法だけを変える。drift 判定がコマンド間で食い違うことを禁止する (このプロジェクト唯一の難所であり、分散実装は品質崩壊の起点になるため)

## Trouble Shooting

- **publish が 401/403 で失敗する** → `gh auth status` を確認。scope に `gist` が必要 (`gh auth refresh -s gist`)
- **status が drift を誤検出する** → 改行コード差の可能性。`.gitattributes` と gist 側の正規化を確認
- **search に snippet が出てこない** → `stars/` 更新忘れなら `gistan pull --stars`。index 破損疑いなら `gistan doctor`
- **URL が変わってしまった** → 可視性変更 / unpublish→再 publish は仕様上 URL が変わる (ADR-0001 参照)。旧 URL の共有先には再送が必要

## Open Questions

- gist repo の default 名・配置 (`~/notes` か `~/git/<user>/notes` か)
- multi-file gist を first-class で publish 可能にするか (v1 は import 時の保持のみ)
- クリップボード連携のクロスプラットフォーム対応範囲 (v1 は macOS `pbcopy` のみで良いか)
- `sync` を launchd 等で定期実行する仕組みを gistan 側で持つか (v1 は持たない想定)
