# TASK-260712: gists/<gist-id>/ 再構成 + description の index 化 (ADR-0003)

# 260712 gist-id restructure

## asis

- `gists/<dirname>/` の dirname は import 時 `slugify(description)` (ascii のみ対応。日本語
  description は `gist--<id8>` に落ちる)、new 時は filename 由来。以降はユーザーの自由命名
- description は予約ファイル `.description.txt` で表現。search / grep のマッチ対象外。編集導線 (編集
  → local-drift → publish) は動くが SPEC 未記載で発見不能
- index v2 は published のみを dirname key で管理。`synced_description_hash` で description の local
  drift も判定
- 個別 `publish [query]` / `unpublish [query]` / `pull [dirname]` / `status` が日常コマンド。一括
  push / pull は存在しない
- search / grep / list の display path は `gists/` を除去するのみ (dirname は見える)。stars は
  `stars/<owner>/<gist-id>/file` がそのまま見える

## tobe

SPEC-0001 (改訂済) と ADR-0003 を正とする。要点:

- `gists/<gist-id>/<files...>` (published) / `gists/<local-id>/<files...>` (未 publish、`_`
  始まり採番)。publish で local-id → gist-id へ rename、unpublish で新 local-id へ rename
- `.description.txt` 廃止。description は index v3 のメタデータ (`gists.<id>.description` =
  最終同期値 / `locals.<local-id>.description`)。local 側の description drift 概念は消滅
- search / grep / list は id を隠した display path (`file.md`, `stars/<owner>/file.md`) +
  description 補助表示 (dim)。description もマッチ対象。ctrl-y で id / URL コピー
- `push` / `pull` 新設 (drift 全列挙 → 対話確認 → 一括同期。conflict は skip して status
  へ誘導)。`status` は温存 (`--fix` 含む)。`publish` / `unpublish` は id / URL 指定のみ
- `new` は `--id` (既存 dir へ追加) / `--publish [--public]` (即 gist 化)
  をサポート。`new dir/file.md` は拒否
- index v2 検出時は migration せず fresh re-import を案内して停止

## todo

実装順は依存関係順。各 phase 完了ごとに `deno task check` / `deno task test` を通すこと。

- [ ] **P1 core: index v3 + local-id**
  - [ ] `src/core/state.ts`: v3 schema (`gists` key = gist-id / `locals` セクション)。v1 / v2
        検出時は再 import 案内で停止
  - [ ] local-id 採番 (`_` + 衝突しないランダム英数字)。既存 dir との衝突チェック
  - [ ] `src/core/description.ts`: `slugify` 削除。description の読み書きを index 経由に変更
        (`.description.txt` の read / write / hash を全廃)
- [ ] **P2 core: reconcile 簡素化**
  - [ ] description の local drift 判定 (`synced_description_hash`) を削除。remote description !=
        index description は remote-drift として報告
- [ ] **P3 commands: new / publish / unpublish**
  - [ ] `new`: local-id 採番して dir 作成。`--id` / `--publish [--public]` / `-d` (index
        保存)。`dir/file.md` 形式は拒否。終了時に path + id (URL) を表示
  - [ ] `publish`: id / URL 指定のみに変更 (query 廃止)。確認プロンプトに filename 一覧 + 軽い
        preview。新規作成成功時に dir rename。`-d` で description 更新
  - [ ] `unpublish`: id / URL 指定のみ。削除後に新 local-id へ rename、description を `locals`
        へ引き継ぐ
- [ ] **P4 commands: push / pull / status**
  - [ ] `push` 新設: published の local-drift 全列挙 → 確認 → 一括 publish。conflict skip + status
        誘導。未 publish dir は対象外
  - [ ] `pull` 置換: remote-drift 全列挙 → 確認 → 一括取り込み。conflict / remote-deleted skip +
        status 誘導。旧 `pull [dirname]` 廃止
  - [ ] `status`: dirname 引数 → id 引数へ。`--fix` に conflict の diff 提示 + 選択を担わせる (push
        / pull が skip した項目の受け皿)
  - [ ] help / エラーメッセージで gist の push / pull と `root push` / `root pull` を相互案内
- [ ] **P5 commands: search / grep / list 表示**
  - [ ] display path から id segment を除去 (gists / stars 両方)。display → 実 path の対応を
        renderer 内部で保持 (fzf 行から実 path を引けるように。delimiter か hidden field を検討)
  - [ ] description をマッチ対象 + 行末 dim 補助表示に追加 (index / stars cache
        から引く)。段構成は「path or description ヒット群 → 本文のみ群」
  - [ ] ctrl-y bind: published / star は gist URL、未 publish は local-id を clipboard へ
        (`src/core/clipboard.ts` 再利用)
  - [ ] ctrl-o の gist-id 解決を display path 依存から実 path 依存へ変更
  - [ ] `list` も同じ display path + description 表示に統一
- [ ] **P6 commands: import**
  - [ ] `gists/<gist-id>/` へ直接取り込み。description は index へ。`.description.txt` 生成と予約名
        warn を削除
- [ ] **P7 docs**
  - [ ] README: 「gists/ 配下の 1 directory = 1 gist (dirname =
        gist-id、ツール管理領域)」を明示。push / pull 中心の日常フロー、fresh re-import
        の移行手順を記載
  - [ ] AGENTS.md の Critical Architecture / Domains を ADR-0003 に合わせて更新 (`.description.txt`
        記述の削除など)
  - [ ] SPEC-0001 冒頭の「TASK-260712 で実装中」注記を削除

## testcases

- [ ] 日本語 description の gist を import して `gists/<gist-id>/` に入り、description が index
      に載る
- [ ] `new hello.md` → `gists/_xxxx/hello.md` 生成、path と local-id が表示される
- [ ] `new hello.md --publish` → gist 作成 + dir が gist-id へ rename + URL 表示。`--public`
      なしなら secret
- [ ] `new memo.md --id <既存id>` で同一 gist に 2 file 目が作られ、publish で multi-file gist
      として更新される
- [ ] `new dir/file.md` が拒否される
- [ ] `publish <local-id>` / `publish <gist URL>` が通り、dirname / filename 指定は受け付けない
- [ ] `unpublish <id>` で remote 削除 + 新 local-id へ rename + description 引き継ぎ
- [ ] `push`: local-drift 複数件が列挙され、yes で一括更新。conflict item は skip され status
      誘導が出る。未 publish dir が列挙されない
- [ ] `pull`: remote-drift 複数件の一括取り込み。remote の description 変更が index に追従する
- [ ] `status --fix` で conflict の diff 提示・選択、dir-missing / remote-deleted の修復ができる
- [ ] search: 同名 filename が複数 gist にあるとき description で判別できる。description への query
      hit が上段に出る。ctrl-y で URL / local-id がコピーされる。ctrl-o が stars / gists 両方で開く
- [ ] v2 の state.json を検出したら再 import 案内で停止する
- [ ] 手動で `gists/_drafts/` を作っても status / search が壊れない (unpublished 扱い)
- [ ] 同期後の gist file が remote と byte 一致し、`.description.txt` がどこにも生成されない

## notes

- 設計判断は ADR-0003 で確定済み: status 温存 / description 補助表示で同名衝突を判別 / description
  更新は `new -d` + `publish -d` のみ / 移行は fresh re-import (v2 migration なし)
- ctrl-c は fzf の abort と衝突するため copy bind は ctrl-y
- P5 の「display から id を隠しつつ実 path を引く」が実装上いちばん繊細 (現行は fzf の行 = display
  path で、ctrl-o が stars の 3rd segment を id として使っている)。fzf の `--delimiter` +
  `--with-nth` で「実 path を行に含めて表示だけ隠す」方式を第一候補に
- description 補助表示・マッチが search レイテンシ (TASK-260712-search-latency)
  に響く場合は、マッチ対象から外して表示のみに縮退してよい (ADR-0003 Open Questions)
- P1〜P3 / P6 は完了条件が明確で下位モデルへ委譲可。P4 (対話フロー設計) と P5 (fzf 連携)
  は実装しながらの判断が要るため上位モデル推奨
