# TASK-260708: root コマンド再編 (init 移動 / sync 廃止 / git ヘルパー)

260708 root コマンド再編 (init 移動 / sync 廃止 / git ヘルパー)
===

> **Status: 完了 (2026-07-08)**。`root status` の追加も含めた最終仕様は [SPEC-0001](./SPEC-0001-gistan-cli.md) を正とする。

## asis

- `gistan init [dir]` がトップレベルコマンド
- `gistan root` は repo path を stdout に出すだけ (`cd $(gistan root)` 用)
- `gistan sync` が git add -A → commit (固定メッセージ) → pull --rebase → push を一括実行する。名前から挙動が想像できず、gist との同期 (publish / pull) と紛らわしい

## tobe

**設計コンセプト: gistan の日常操作は「local gist repo をどこからでも触り、publish / drift 状況を一覧する」こと。root repo 自体の git 操作 (GitHub origin との push / pull) は日常操作ではなく「準備作業」なので、`gistan root` 名前空間へ隔離したヘルパーとしてのみ提供する。**

```
gistan root init [dir]        # 旧 gistan init (挙動は現行のまま移動)
gistan root path              # repo の絶対 path を stdout へ (旧 gistan root の挙動を移動)
gistan root commit [-m <msg>] # git add -A + commit。-m 無指定時は自動メッセージ (現行 sync の固定文言を踏襲)
gistan root push              # git push
gistan root pull              # git pull --rebase (固定)
gistan sync                   # 廃止
```

- `gistan root` 単体 (サブコマンドなし) は root 系の usage を表示する
- 旧コマンドを打ったユーザーへの案内:
    - `gistan init` → エラーで `did you mean 'gistan root init'?` を出す
    - `gistan sync` → エラーで `'gistan sync' was removed — use 'gistan root commit / push / pull'` を出す
- 各サブコマンドは `git -C <repo>` 相当で repo を対象に実行し、git の exit code / stderr をそのまま伝播する。remote 未設定時の push / pull は git 自身のエラーに任せる (再ラップしない)
- `root commit` は stage 対象が無ければ `nothing to commit` を出して正常終了 (現行 sync 踏襲)

## todo

- [x] `src/commands/root.ts`: サブコマンドディスパッチ (init / path / commit / push / pull) へ書き換え
- [x] `src/commands/init.ts` のロジックを `root init` 配下へ移動 (実装は流用、入口だけ変更)
- [x] `src/commands/sync.ts` と `sync_test.ts` を削除
- [x] `src/main.ts` (コマンド登録): init / sync のトップレベル登録を外し、上記の案内エラーを追加
- [x] `docs/SPEC-0001-gistan-cli.md` 更新: コマンド一覧、「git 操作: gistan sync / gistan root」セクション、Edge Cases の local 系コマンド列挙 (`search / edit / list / root`)
- [x] `README.md` 更新: セットアップ手順 (`gistan init` → `gistan root init`) と日常操作の説明

## testcases

- [x] `root path` が config の repo path を出力する
- [x] `root commit`: 変更あり → add -A + commit (-m 指定文言 / 無指定は自動文言)、変更なし → nothing to commit で exit 0
- [x] `root push` / `root pull` が repo を cwd に git を呼び、失敗時に git のエラーを伝播する
- [x] `gistan init` / `gistan sync` が案内メッセージ付きエラー (exit code 非 0) になる
- [x] `deno fmt` / `deno lint` / `deno test` 全通過

## notes

- 260708 の会話での決定: 個別サブコマンド方式を採用 (passthrough 案・path のみ案は不採用)。`commit -m` は採用、`pull --merge` は YAGNI で見送り (単独ユーザーの notes repo では履歴分岐がほぼ発生せず、必要になれば 1 行で足せる) — 将来オプション候補としてここに残す
- `search --path (-p)` と status / doctor 統合は TASK-260708-gists-multi-file-restructure 側に含めた (search / status は同タスクで書き換えられるため、二度触りを避ける)
- 本タスクは multi-file 再編タスクと SPEC 編集が被るため、multi-file 側の完了後に直列で実施すること
