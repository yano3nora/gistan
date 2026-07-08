# TASK-260706: gistan v3 (star mirror)

260706 gistan v3 star mirror
===

## asis

他人の gist を local で検索・参照する手段がない。search / list / edit は `stars/` を
対象に含む実装済みだが、`stars/` を埋める手段が未実装。

## tobe

GitHub で star した gist が read-only mirror として local 検索に含まれる (SPEC-0001)。

## todo

- [ ] `gistan star sync` — `GET /gists/starred` (paging) を `stars/<owner>/<gist-id>/` へ mirror
- [ ] `gistan star add <gist-url>` — URL から id を解決し API で star → mirror
- [ ] mirror 管理情報 (fetched_at 等) を `.gistan/cache/stars.json` に保存 (gitignore 済み)
- [ ] `gistan pull --stars` — star mirror の更新 (pull 実装済み、フラグは v3 送りでエラー中)
- [ ] search / edit の stars read-only 表示の実機確認
- [ ] search の ctrl-o (gist URL をブラウザで開く) の stars 対応 — `stars/<owner>/<gist-id>/` 配置が入れば path から gist id を導出できる。現状 stars/* は no-op (TASK-260708 followup)

## testcases

- [ ] star sync が冪等 (再実行で差分のみ更新)
- [ ] mirror が commit されない (`git status` に現れない)
- [ ] `gistan rm` が stars/ を拒否する (実装済み、確認のみ)

## notes

- mirror は再取得可能な cache。編集・書き戻しは Non-Goal (ADR-0001)
- 楽しい機能だが価値の中心ではないので、v1 実データ検証 → v2 運用が安定してから
