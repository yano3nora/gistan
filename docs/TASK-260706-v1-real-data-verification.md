# TASK-260706: v1 実データ検証 (人間実行)

260706 v1 実データ検証
===

> **Status: クローズ (2026-07-12)**。手順の前提 (gitleaks 必須 / `snippets/` / tags / `gistan init`) は
> [ADR-0002](./ADR-0002-one-directory-one-gist.md) 以降の再設計で消滅。実データでの運用検証自体は
> v0.2〜v0.5 の実機フィードバックループで完了した。

## asis

v1 + v2 のコマンドは unit test と部分的な実環境 smoke まで完了しているが、
「実アカウントの約 753 gists を相手にした一連の運用」は未検証。
gist の作成・削除は外部公開操作のため Agent は実行せず、人間が行う。

## tobe

README「Manual E2E check」の手順が実データで一通り通り、v1 を出荷済みと言える状態。

## todo

- [ ] `brew install gitleaks` (import の必須依存)
- [ ] README「Manual E2E check」の手順 1〜7 (init / publish / status / search)
- [ ] `gistan import --limit 5` で小規模検証 → 問題なければ全件 import
- [ ] import 後の `gistan status` / `gistan search` の体感確認 (753 件規模での速度・表示)
- [ ] テスト gist・fixture の後片付け
- [ ] 本運用の gist repo を決めて `gistan init`、必要なら remote 追加 + push (人間判断)

## testcases

- [ ] secret スキャンが全件通過する (検出があれば masking して再実行)
- [ ] ファイル名衝突が `--<id8>` サフィックスで解決されている
- [ ] multi-file gist が `snippets/<slug>--<id8>/` に保持されている
- [ ] description の `[tag]` が index に逆輸入されている (`gistan list --tag <t>` で確認)

## notes

- 問題が出たら出力を貼って Agent に修正依頼する
- 完了したら TASK-260705 の「実データ検証」項目にチェックを入れる
