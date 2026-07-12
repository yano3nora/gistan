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

- [x] **P1 core: index v3 + local-id**
  - [x] `src/core/state.ts`: v3 schema (`gists` key = gist-id / `locals` セクション)。v1 / v2
        検出時は再 import 案内で停止
  - [x] local-id 採番 (`_` + 衝突しないランダム英数字)。既存 dir との衝突チェック
  - [x] `src/core/description.ts`: `slugify` 削除。description の読み書きを index 経由に変更
        (`.description.txt` の read / write / hash を全廃)
- [x] **P2 core: reconcile 簡素化**
  - [x] description の local drift 判定 (`synced_description_hash`) を削除。remote description !=
        index description は remote-drift として報告
- [x] **P3 commands: new / publish / unpublish**
  - [x] `new`: local-id 採番して dir 作成。`--id` / `--publish [--public]` / `-d` (index
        保存)。`dir/file.md` 形式は拒否。終了時に path + id (URL) を表示
  - [x] `publish`: id / URL 指定のみに変更 (query 廃止)。確認プロンプトに filename 一覧 + 軽い
        preview。新規作成成功時に dir rename。`-d` で description 更新
  - [x] `unpublish`: id / URL 指定のみ。削除後に新 local-id へ rename、description を `locals`
        へ引き継ぐ
- [x] **P4 commands: push / pull / status**
  - [x] `push` 新設: published の local-drift 全列挙 → 確認 → 一括 publish。conflict skip + status
        誘導。未 publish dir は対象外
  - [x] `pull` 置換: remote-drift 全列挙 → 確認 → 一括取り込み。conflict / remote-deleted skip +
        status 誘導。旧 `pull [dirname]` 廃止
  - [x] `status`: dirname 引数 → id 引数へ。`--fix` に conflict の diff 提示 + 選択を担わせる (push
        / pull が skip した項目の受け皿)
  - [x] help / エラーメッセージで gist の push / pull と `root push` / `root pull` を相互案内
- [x] **P5 commands: search / grep / list 表示**
  - [x] display path から id segment を除去 (gists / stars 両方)。display → 実 path の対応を
        renderer 内部で保持 (fzf 行から実 path を引けるように。delimiter か hidden field を検討)
  - [x] description をマッチ対象 + 行末 dim 補助表示に追加 (index / stars cache
        から引く)。段構成は「path or description ヒット群 → 本文のみ群」
  - [x] ctrl-y bind: published / star は gist URL、未 publish は local-id を clipboard へ
        (`src/core/clipboard.ts` 再利用)
  - [x] ctrl-o の gist-id 解決を display path 依存から実 path 依存へ変更
  - [x] `list` も同じ display path + description 表示に統一
- [x] **P6 commands: import**
  - [x] `gists/<gist-id>/` へ直接取り込み。description は index へ。`.description.txt` 生成と予約名
        warn を削除
- [x] **P7 docs**
  - [x] README: 「gists/ 配下の 1 directory = 1 gist (dirname =
        gist-id、ツール管理領域)」を明示。push / pull 中心の日常フロー、fresh re-import
        の移行手順を記載
  - [x] AGENTS.md の Critical Architecture / Domains を ADR-0003 に合わせて更新 (`.description.txt`
        記述の削除など)
  - [x] SPEC-0001 冒頭の「TASK-260712 で実装中」注記を削除

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

### 実装記録 (2026-07-12)

- 全 phase 実装完了。`deno task check` / `deno task test` (302 tests) green
- fzf 連携は「3 フィールド行プロトコル」で解決: renderer が `実path TAB 行番号 TAB 表示内容` を
  出力し `--delimiter TAB` + `--with-nth 3..` で表示だけ id を隠す。`{1}` = 実 path が preview /
  Enter / ctrl-o / ctrl-y / ctrl-v すべての入力になる。旧 `writeGistMapFile` + awk lookup は廃止し、
  id 解決は隠しコマンド `__open` / `__copy` (TypeScript, cwd = repo で index を読む) へ移動
- grep も同じ理由で sh パイプラインを廃止し `__grep-render` (TypeScript) 化。regex 判定は従来通り rg
  subprocess に委ね、path ヒット判定は display path リストを rg へ stdin で流す方式
- edit / rm の fzf picker (`pickFile`) も `__list` renderer で同じ id 秘匿表示に統一 (SPEC 外の
  ついで対応。description が fzf native match の対象になる副次効果あり)
- 上記 testcases は unit テストで同等シナリオを網羅済み。実 gist / 実 fzf セッションでの動作確認
  (実機フィードバック) は未実施 — 次のアクション

### codex レビュー対応 (2026-07-12)

codex exec による change set レビューで 7 件の指摘。5 件を修正、2 件は判断の上で見送り:

- **修正 (P0)** truncated file を含む gist の pull がローカル file を削除して同期済みにしていた
  (旧実装から移植した潜在バグ) → `applyRemote` を all-or-nothing 化し、pull / `--fix` で skip + 手動
  取得案内
- **修正 (P0)** publish の可視性変更が delete → create の順で、create 失敗時に旧 gist だけ消えた →
  create → local 切替 → delete に逆転。削除失敗は「重複が残る」warn で終了
- **修正 (P1)** publish / unpublish の remote 操作成功後に rename / index 保存が失敗すると成功表示の
  まま不整合が残った → finalize を try に入れ、成功表示は保存後、失敗時は復旧手順を明示
- **修正 (P1)** `status --fix` が全修復を最後に一括保存しており、途中例外で先行修復が index
  未反映になった → per-item 保存 + per-item try/catch。また「dir 無し + remote 無し」(unpublish
  途中失敗の残骸) を deleteGist なしの index unlink で修復できるように
- **修正 (P2)** tab を含む filename が fzf 行プロトコルを壊す → `new` で制御文字拒否 + renderer 側で
  tab 入り path を除外
- **見送り** rg exit 2 (invalid regex 等) を「結果なし」に見せる件 → キー入力途中の不完全 regex が
  毎キーストローク発生する grep の性質上、旧 sh パイプライン (`|| true`) から一貫した意図的挙動。
  検索漏れの告知手段 (fzf header 等) は将来の改善候補
- **見送り** filename 内 tab の完全なエスケープ機構 → 上記の拒否 + 除外で実害を塞ぎ、プロトコルの
  複雑化はしない
