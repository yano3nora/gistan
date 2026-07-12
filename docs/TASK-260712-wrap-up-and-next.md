# TASK-260712: 開発一区切り (v0.5.0) — 現状サマリと再開ポイント

260712 wrap up and next
===

## asis

v0.5.0 で当初計画 (v1 / v2 / v3 + UX 改善) の全機能が実装済み。日常運用中で安定している。

- コマンド 13 種 + 隠し renderer 2 種 (`__search-render` / `__preview`) が全て動作。`--help` と [SPEC-0001](./SPEC-0001-gistan-cli.md) Commands 節が一致
- 実データ (約 753 gists) の import 済み・日常利用中。実機フィードバックは TASK-260708-cli-ux-improvements の followup 1〜4 として反映済み
- 配布は GitHub Release + mise (`mise use -g github:yano3nora/gistan`)。リリースは `scripts/release.ts` の prepare / publish 2 段構え (publish は人間のみ)
- ドキュメントは 2026-07-12 に棚卸し済み: ADR-0001 は Accepted 化 + 旧記述 (doctor / tags) を更新、SPEC-0001 は現状と一致、過去 TASK は全てクローズ or ステータス注記済み

過去の経緯を追うときの読み順: [ADR-0001](./ADR-0001-repo-as-source-of-truth.md) (なぜ作るか) →
[ADR-0002](./ADR-0002-one-directory-one-gist.md) (v2 再設計) → [SPEC-0001](./SPEC-0001-gistan-cli.md) (現行仕様の正) →
各 TASK (作業記録)。

## tobe

このファイルを読めば、次の作業をどこから始めればいいか迷わない状態。

## todo

強い残タスクは無い。以下は「必要になったら」の優先順。

0. **search レイテンシ改善 (実装指示書作成済み、後続 AI に委任)** → [TASK-260712-search-latency](./TASK-260712-search-latency.md)
    - [ ] Option A (rg 並列化) + Option B (dynamic import 化) の実装。完了条件・計測手順は TASK 参照
1. **star 機能の実機確認 3 件 (軽い、人間実行)** → [TASK-260706-gistan-v3-star](./TASK-260706-gistan-v3-star.md) の未チェック項目
    - [ ] search / edit で stars が read-only 表示されること
    - [ ] mirror が commit されない (`gistan root status` に現れない) こと
    - [ ] `gistan rm` が stars/ を拒否すること
2. **配布の強化 (リリース形状が安定したと判断したら)** → [TASK-260708-mise-github-release-distribution](./TASK-260708-mise-github-release-distribution.md) Remaining work
    - [x] release flow の一部を goreleaser に寄せる (compile / archive / checksum / GitHub Release 作成のみ切り出し) — 260712 対応済み
        - 背景: 別の Rust プロジェクトでもバイナリ配布のリリーススクリプトが必要になり、同種コードの重複を避けて goreleaser (v2.5+ で Deno / Rust builder を公式サポート) に共通化したい。薄い wrapper script は各プロジェクトに残る前提で、中身の大半を goreleaser に寄せられればよい
        - 実装 (260712): `.goreleaser.yaml` (deno builder / 5 targets / asset 命名は旧規約を維持 / per-asset .sha256 / release notes は github-native) + `scripts/release.ts` を薄い wrapper に縮退
            1. prepare: version bump + check/test + `goreleaser release --snapshot --clean` (tag 不要のドライランでビルド〜archive〜checksum まで検証)
            2. 人間: version bump を commit し、`git tag v<version>` を打つ
            3. publish: `--i-understand-this-pushes-and-publishes` ガード → VERSION 一致 / clean tree / tag==HEAD 確認 → commit + tag を push → `goreleaser release --clean` (token は `gh auth token` を使い回し)
        - 検証済み: goreleaser check / deno task check / test (199 passed) / snapshot 実走 (5 targets, 14s) / macos-x64 バイナリ実行 / checksum 一致 / publish ガード動作。publish の実走のみ未 (人間実行)
        - [ ] 初回 goreleaser リリース時に mise `github:yano3nora/gistan` からのインストールを実機確認すること。特に .sha256 の中身が「hash のみ」に変わった (旧: `hash  filename` の shasum 形式)。archive 名と「バイナリのみ同梱」は旧規約と同一
    - [ ] mise 上流 registry 登録 (`mise use -g gistan` の短縮形が欲しくなったら)
    - [ ] tag-trigger のリリース自動化 (手動リリースを数回重ねてから)
    - [ ] GitHub Artifact Attestations / provenance (任意)
3. **運用で実害が出たら着手 (SPEC-0001 Open Questions と同期)**
    - [ ] index の複数マシン間 merge conflict → per-gist sidecar 分割
    - [ ] tags の再導入 (v2 で全廃。必要性が明確になるまで戻さない)
    - [ ] integration / e2e で実 gist を使う範囲の決定
    - [x] クリップボード対応のクロスプラットフォーム化 — 260712 対応済み (`core/clipboard.ts`。darwin: pbcopy / windows: clip / それ以外: wl-copy → xclip → xsel の fallback。ツール未導入は黙認、導入済みで失敗したときだけ warn)

## testcases

- [ ] 新セッションでこのファイルと SPEC-0001 だけ読めば、現状把握と作業着手ができる

## notes

- 実装の歩き方は README「Development > Directory Structure」に記載 (entrypoint `src/main.ts` → `src/commands/*` → `src/core/*`。難所は `core/reconcile.ts` のみ)
- 検証コマンド: `mise exec -- deno task check && mise exec -- deno task test`
- スコープ管理の原則 (AGENTS.md): 自動同期・TUI・他人 gist への書き戻しには将来も広げない。機能追加の前に Non-Goals を確認すること
