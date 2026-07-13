# TASK-260712: 開発一区切り — 現状サマリと再開ポイント

# 260712 wrap up and next

> **Status: Closed (2026-07-12)**。本 TASK の残タスクは全て [BACKLOG](./BACKLOG.md)
> へ棚卸し済み。**次の作業は BACKLOG から pick して新 TASK を作る** — このファイルはクローズ時点
> (v0.7.0) のスナップショット記録。

## asis

v0.7.0 で当初計画 (v1 / v2 / v3 + UX 改善) に加え、goreleaser 化 (v0.6.0) と dirname 廃止 /
アーキテクチャ刷新 (v0.7.0, ADR-0003 / state v3) まで完了。日常運用中。

- コマンド 14 種 + 隠し renderer / action 6 種 (`__search-render` / `__grep-render` / `__preview` /
  `__list` / `__open` / `__copy`) が全て動作。`--help` と [SPEC-0001](./SPEC-0001-gistan-cli.md)
  Commands 節が一致
- 実データ (約 753 gists) の import 済み・日常利用中。実機フィードバックは
  TASK-260708-cli-ux-improvements の followup 1〜4 として反映済み。v0.7.0 分の実機確認は BACKLOG
  参照
- 配布は GitHub Release + mise (`mise use -g github:yano3nora/gistan`)。リリースは goreleaser +
  `scripts/release.ts` の prepare / publish 2 段構え (publish は人間のみ)
- ドキュメントは 2026-07-12 に棚卸し済み: ADR-0003 追加 (dirname 廃止 / description の index 化)、
  SPEC-0001 は現状と一致、過去 TASK は全てクローズ or ステータス注記済み、未解決事項は BACKLOG.md
  に一元化

過去の経緯を追うときの読み順: [ADR-0001](./ADR-0001-repo-as-source-of-truth.md) (なぜ作るか) →
[ADR-0002](./ADR-0002-one-directory-one-gist.md) (v2 再設計) →
[ADR-0003](./ADR-0003-gist-id-directory-and-description-metadata.md) (dirname 廃止) →
[SPEC-0001](./SPEC-0001-gistan-cli.md) (現行仕様の正) → 各 TASK (作業記録)。

## tobe

このファイルと BACKLOG を読めば、次の作業をどこから始めればいいか迷わない状態。

## todo

クローズ時点の決着。未完了分は全て [BACKLOG](./BACKLOG.md) へ移管。

0. **search レイテンシ改善** → **未着手のまま BACKLOG へ移管**。
   [TASK-260712-search-latency](./TASK-260712-search-latency.md) の指示書は有効だが、v0.7.0 で
   renderer に description マッチが加わったため asis 実測は要更新 (詳細は BACKLOG)
1. **star 機能の実機確認 3 件** → 未実施のまま BACKLOG へ移管
2. **配布の強化** → goreleaser 化は完了、残りは BACKLOG へ移管
   - [x] release flow の goreleaser 化 (v0.6.0) — `.goreleaser.yaml` (deno builder / 5 targets /
         asset 命名は旧規約を維持 / per-asset .sha256 / release notes は github-native) +
         `scripts/release.ts` を薄い wrapper に縮退。検証済み: goreleaser check / deno task check /
         test / snapshot 実走 / macos-x64 バイナリ実行 / checksum 一致 / publish ガード動作
   - mise インストール実機確認 / 上流 registry / tag-trigger 自動化 / attestations → BACKLOG
3. **運用で実害が出たら着手** → SPEC-0001 Open Questions ごと BACKLOG へ移管
   - [x] クリップボード対応のクロスプラットフォーム化 (`core/clipboard.ts`。darwin: pbcopy /
         windows: clip / それ以外: wl-copy → xclip → xsel の fallback。ツール未導入は黙認、
         導入済みで失敗したときだけ warn)
4. **(本 TASK 作成後に追加着手した分) dirname 廃止 / アーキテクチャ刷新** → **完了 (v0.7.0)**。
   [TASK-260712-gist-id-restructure](./TASK-260712-gist-id-restructure.md) 参照
   - [x] index v3 (`gists` = gist-id key + `locals`) / local-id 採番 / `.description.txt` 全廃
   - [x] `push` / `pull` 新設、`publish` / `unpublish` の id 指定化、`status --fix` の conflict 解決
   - [x] search / grep / list の id 秘匿表示 (fzf 3 フィールド行プロトコル) + description
         マッチ・補助表示 + ctrl-y コピー
   - [x] codex レビュー 7 件中 5 件修正 (pull の all-or-nothing 化、publish の可視性変更順序など)
   - 実機フィードバックのみ未実施 → BACKLOG

## testcases

- [x] 新セッションでこのファイル + BACKLOG + SPEC-0001 を読めば、現状把握と作業着手ができる

## notes

- 実装の歩き方は README「Development > Directory Structure」に記載 (entrypoint `src/main.ts` →
  `src/commands/*` → `src/core/*`。難所は `core/reconcile.ts` のみ)
- 検証コマンド: `mise exec -- deno task check && mise exec -- deno task test`
- スコープ管理の原則 (AGENTS.md): 自動同期・TUI・他人 gist
  への書き戻しには将来も広げない。機能追加の前に Non-Goals を確認すること
- クローズ時の実態調査 (2026-07-12): 本ファイルの旧記述に実態とのズレがあったため、コード・git
  履歴と突き合わせて更新した。特に search レイテンシ改善は「完了扱いにしない」ことを確認済み
  (`search_render.ts` の rg 直列・`main.ts` 静的 import が現存)
