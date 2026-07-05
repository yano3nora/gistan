# TASK-260705: gistan v1 (MVP) 実装

260705 gistan v1 (MVP) 実装
===

## asis

設計ドキュメントのみ存在し、コードは未着手。

- [ADR-0001](./ADR-0001-repo-as-source-of-truth.md) / [SPEC-0001](./SPEC-0001-gistan-cli.md) で設計確定済み
- 既存の約 753 gist は gist 上に散在し、検索・管理が困難なまま

## tobe

SPEC-0001 の v1 コマンドが動作し、日常利用を開始できる。

- `init` / `import` / `search` / `publish` / `status` の 5 コマンドが動く
- 既存 gist が secret スキャン (gitleaks) を通過した状態で gist repo に取り込まれている
- 「取り込み、探し、公開できる」の縦切りが実データで検証済み

## todo

- [x] Deno プロジェクト scaffold (`deno.json`, fmt / lint / test 設定, `src/` 構成, README 更新) — 260705 codex exec + 手直し (DENO_DIR 除去, import map 整理)
- [ ] config (`~/.config/gistan/config.toml`) の読み書きと外部 CLI (gh / git / rg / fzf) の存在検査
- [ ] `gistan init` — gh auth 確認 / repo 作成 or clone / 雛形 (`snippets/` `stars/` `.gistan/` `.gitignore`) 配置
- [ ] index (`.gistan/state.json`) の読み書きモジュール (key ソート済み書き出し)
- [ ] 照合エンジン (index・local・remote の三者照合) — v1 では status が使う最小版
- [ ] `gistan status` — 未公開 / 公開中 / local drift / remote drift / conflict の判定・表示
- [ ] `gistan publish` — 新規作成 / 冪等更新 / description 自動生成 / URL クリップボード / 可視性変更時の警告付き再作成
- [ ] `gistan search` — rg + fzf ライブ全文検索 (snippets + stars)
- [ ] `gistan import` — paging / multi-file gist のディレクトリ保持 / description からの tags 逆輸入 / gitleaks スキャン (検出時 commit ブロック)
- [ ] 実データ (約 753 gists) で import → search → publish の一連を検証

## testcases

- [ ] `init`: gh 未認証時に案内して終了する / 2 回実行しても冪等
- [ ] `publish`: 新規 → gist 作成 + index 記録 / 再実行 → 冪等更新 / `--secret` 切替 → URL 変更の警告と確認を挟む
- [ ] `status`: 未公開・公開中・local drift・remote drift をそれぞれ正しく判定する
- [ ] `import`: secret 検出時に commit がブロックされる / multi-file gist が `snippets/<slug>/` で保持される / tags が逆輸入される
- [ ] 直接 rm / mv されたファイルがあっても各コマンドがクラッシュせず動作する (Invariants)

## notes

- 仕様は SPEC-0001、決定背景は ADR-0001 を正とする
- v2 (`pull` / `doctor` / 運用糖衣) と v3 (`star`) は別 TASK に切る (SPEC-0001 Milestones)
- 照合エンジンは将来 pull / doctor と共用するため必ず単一モジュールにする (SPEC-0001 実装・依存)
- codex exec へ委任するのは scaffold 等「完了条件まで指示書に書き切れる」部分に限る (CLAUDE.md)
- import は破壊的ではないが実データを扱うため、検証は使い捨ての作業ブランチ or 別ディレクトリの repo で行ってから本番 gist repo に適用する
