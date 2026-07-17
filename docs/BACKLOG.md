# BACKLOG — 未解決タスクの棚卸し

> **Status: 常設 (クローズしない)**。未着手・保留・トリガー待ちのタスクを一元管理する唯一の置き場。
> 各 TASK の残項目はここに集約済みなので、過去 TASK を漁る必要はない。

## 運用ルール

1. 次の作業を始めるときは、ここから 1 件 pick して `TASK-YYMMDD-<slug>.md` を新規作成する
   (テンプレは [TASK-YYMMDD-template](./TASK-YYMMDD-template.md))
2. pick した項目は新 TASK へのリンクに差し替え、完了したらリンクごと項目を削除する
3. 新しい未解決事項が出たら、他の TASK に残さずここへ追記する
4. SPEC-0001 の Open Questions と重複する項目は、決着時に SPEC 側も更新すること

## 実機確認 (軽い、人間実行)

v0.7.0 (ADR-0003 / dirname 廃止) と star 機能の実機フィードバック。unit テストでは同等シナリオを
網羅済み ([TASK-260712-gist-id-restructure](./TASK-260712-gist-id-restructure.md) /
[TASK-260706-gistan-v3-star](./TASK-260706-gistan-v3-star.md)) だが、実 gist・実 fzf
セッションでの確認が未実施。コマンドごとに確認する。

- [ ] **`import`**
  - [ ] 日本語 description の gist を import して `gists/<gist-id>/` に入り、description が index
        に載る
- [ ] **`new`**
  - [ ] `new hello.md` → `gists/_xxxx/hello.md` 生成、path と local-id が表示される
  - [ ] `new hello.md --publish` → gist 作成 + dir が gist-id へ rename + URL 表示。`--public`
        なしなら secret
  - [ ] `new memo.md --id <既存id>` で同一 gist に 2 file 目が作られ、publish で multi-file gist
        として更新される
  - [ ] `new dir/file.md` が拒否される
- [ ] **`publish` / `unpublish`**
  - [ ] `publish <local-id>` / `publish <gist URL>` が通り、dirname / filename 指定は受け付けない
  - [ ] `unpublish <id>` で remote 削除 + 新 local-id へ rename + description 引き継ぎ
- [ ] **`push`**
  - [ ] local-drift 複数件が列挙され、yes で一括更新
  - [ ] conflict item は skip され status 誘導が出る
  - [ ] 未 publish dir が列挙されない
- [ ] **`pull`**
  - [ ] remote-drift 複数件の一括取り込み
  - [ ] remote の description 変更が index に追従する
- [ ] **`status`**
  - [ ] `--fix` で conflict の diff 提示・選択ができる
  - [ ] `--fix` で dir-missing / remote-deleted の修復ができる
  - [ ] star mirror が commit されない (`gistan root status` に現れない)
- [ ] **`search`**
  - [ ] 同名 filename が複数 gist にあるとき description で判別できる
  - [ ] description への query hit が上段に出る
  - [ ] ctrl-y で URL / local-id がコピーされる
  - [ ] ctrl-o が stars / gists 両方で開く
  - [ ] stars が read-only 表示される
- [ ] **`edit`**
  - [ ] stars が read-only 表示される
- [ ] **`rm`**
  - [ ] stars/ 配下の指定が拒否される
- [ ] **コマンド横断**
  - [ ] v2 の state.json を検出したら再 import 案内で停止する
  - [ ] 手動で `gists/_drafts/` を作っても status / search が壊れない (unpublished 扱い)
  - [ ] 同期後の gist file が remote と byte 一致し、`.description.txt` がどこにも生成されない

## 判断待ち・トリガー待ち (実害や必要性が出たら着手)

配布まわり:

- [ ] mise 上流 registry 登録 (`mise use -g gistan` の短縮形が欲しくなったら) —
      [TASK-260708-mise-github-release-distribution](./TASK-260708-mise-github-release-distribution.md)
- [ ] tag-trigger のリリース自動化 (手動リリースを数回重ねてから)
- [ ] GitHub Artifact Attestations / provenance (任意)

SPEC-0001 Open Questions と同期している項目:

- [ ] index の複数マシン間 merge conflict → per-gist sidecar 分割 (実害が出たら)
- [ ] tags の再導入 (v2 で全廃。必要性が明確になるまで戻さない)
- [ ] integration / e2e で実 gist を使う範囲の決定
- [ ] `push` の対象に未 publish dir を含めるか (現状含めない。誤公開防止が理由。ADR-0003)
- [ ] description のマッチ・補助表示が search レイテンシを悪化させる場合の縮退
      (マッチ対象から外して表示のみに。上記レイテンシ TASK の再計測結果で判断)

保留 (再検討トリガー付き):

- [ ] **Option C: search の常駐レンダラ化** — FIFO 経由で親プロセスが描画する案 (~20-40ms 狙い)。
      保留理由と設計は [TASK-260712-search-latency](./TASK-260712-search-latency.md) notes 参照。
      再検討トリガー: A+B 後も体感が悪い、またはコーパスが現在の 10 倍規模になったとき
- [ ] **grep の rg exit 2 (invalid regex 等) が「結果なし」に見える件の告知手段** — fzf header
      等での表示。キー入力途中の不完全 regex が毎キーストローク発生するため意図的に黙認中
      ([TASK-260712-gist-id-restructure](./TASK-260712-gist-id-restructure.md) codex レビュー見送り)

## notes

- 2026-07-12 に [TASK-260712-wrap-up-and-next](./TASK-260712-wrap-up-and-next.md) のクローズに伴い、
  同 TASK の todo と各 TASK の未チェック項目をここへ棚卸しした
- 2026-07-13 に search レイテンシ改善を
  [TASK-260712-search-latency](./TASK-260712-search-latency.md) として実施。rg
  並列化を採用し、dynamic import は実測条件を満たさず不採用
- 「filename 内 tab の完全なエスケープ機構」は won't-do として棚卸しから除外 (`new`
  での制御文字拒否 + renderer 側の tab 入り path 除外で実害を塞いだ。プロトコルは 複雑化しない —
  TASK-260712-gist-id-restructure codex レビュー見送り)
- スコープ管理の原則 (AGENTS.md Non-Goals): 自動同期・TUI・他人 gist への書き戻しには広げない
