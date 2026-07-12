# TASK-260705: gistan v1 (MVP) 実装

# 260705 gistan v1 (MVP) 実装

> **Status: クローズ (2026-07-12)**。v1 実装は完了。本文の `snippets/` / tags / gitleaks / doctor は
> [ADR-0002](./ADR-0002-one-directory-one-gist.md) の再設計で廃止されており、記録としてのみ残す。
> 未チェックの「実データ検証」は v2 再設計後の実運用 (753 gists import + 日常利用)
> で事実上完了した。

## asis

設計ドキュメントのみ存在し、コードは未着手。

- [ADR-0001](./ADR-0001-repo-as-source-of-truth.md) / [SPEC-0001](./SPEC-0001-gistan-cli.md)
  で設計確定済み
- 既存の約 753 gist は gist 上に散在し、検索・管理が困難なまま

## tobe

SPEC-0001 の v1 コマンドが動作し、日常利用を開始できる。

- `init` / `import` / `search` / `publish` / `status` の 5 コマンドが動く
- 既存 gist が secret スキャン (gitleaks) を通過した状態で gist repo に取り込まれている
- 「取り込み、探し、公開できる」の縦切りが実データで検証済み

## todo

- [x] Deno プロジェクト scaffold (`deno.json`, fmt / lint / test 設定, `src/` 構成, README 更新) —
      260705 codex exec + 手直し (DENO_DIR 除去, import map 整理)
- [x] config (`~/.config/gistan/config.toml`) の読み書きと外部 CLI (gh / git / rg / fzf) の存在検査
      — 260705 `src/core/{config,deps,proc}.ts`
- [x] `gistan init` — gh auth 確認 / repo 作成 or clone / 雛形 (`snippets/` `stars/` `.gistan/`
      `.gitignore`) 配置 — 260705 実 repo 作成の E2E は import 検証時に実施
- [x] index (`.gistan/state.json`) の読み書きモジュール (key ソート済み書き出し) — 260705
      `src/core/state.ts`
- [x] 照合エンジン (index・local・remote の三者照合) — 260705 `src/core/reconcile.ts`
      純関数として実装
- [x] `gistan status` — 未公開 / 公開中 / local drift / remote drift / conflict の判定・表示 —
      260705 remote 到達不可時は local-only 判定に degrade
- [x] `gistan publish` — 新規作成 / 冪等更新 / description 自動生成 / URL クリップボード /
      可視性変更時の警告付き再作成 — 260705 body は `gh api --input -` の stdin 渡し
- [x] `gistan search` — rg + fzf ライブ全文検索 (snippets + stars) — 260705 fzf reload 方式、vim
      系は行ジャンプ + stars read-only。対話 UI の実機確認は人間実行
- [x] `gistan import` — paging / multi-file gist のディレクトリ保持 / description からの tags 逆輸入
      / gitleaks スキャン (検出時 commit ブロック) — 260706 gist ID 単位の冪等スキップ + 1 件ごと
      index 保存で中断再開可能。`--limit N` で試行可
- [ ] 実データ (約 753 gists) で import → search → publish の一連を検証

## testcases

- [x] `init`: gh 未認証時に案内して終了する / 2 回実行しても冪等 — unit test 済 + 実環境 smoke (非
      git dir 拒否・依存警告) 確認済
- [x] `publish`: 新規 → gist 作成 + index 記録 / 再実行 → 冪等更新 / `--secret` 切替 → URL
      変更の警告と確認を挟む — unit test 済 (実 gist を作る E2E は外部公開操作のため人間実行: import
      検証と合わせて実施)
- [x] `status`: 未公開・公開中・local drift・remote drift をそれぞれ正しく判定する — reconcile
      の判定マトリクス + status の unit test で網羅、実 753 gists で一覧取得 smoke 済
- [x] `import`: secret 検出時に commit がブロックされる / multi-file gist が
      `snippets/<slug>--<id8>/` で保持される / tags が逆輸入される — unit test 済。実データ検証は
      README「Manual E2E check」の手順で人間実行
- [ ] 直接 rm / mv されたファイルがあっても各コマンドがクラッシュせず動作する (Invariants)

## notes

- 仕様は SPEC-0001、決定背景は ADR-0001 を正とする
- v2 (`pull` / `doctor` / 運用糖衣) と v3 (`star`) は別 TASK に切る (SPEC-0001 Milestones)
- 照合エンジンは将来 pull / doctor と共用するため必ず単一モジュールにする (SPEC-0001 実装・依存)
- codex exec へ委任するのは scaffold 等「完了条件まで指示書に書き切れる」部分に限る (CLAUDE.md)
- import は破壊的ではないが実データを扱うため、検証は使い捨ての作業ブランチ or 別ディレクトリの repo
  で行ってから本番 gist repo に適用する
- 260706 実機フィードバック反映: init は remote repo を作らない (local git init のみ) / status
  は既定 local 判定・`--remote` で drift 検出 (遅さの原因は remote 一覧取得の実測 10.4 秒) / search
  は空クエリでファイル一覧・入力で全文 grep / 裸 `gistan` は search 起動 / status 表示から
  `snippets/` プレフィックス省略
