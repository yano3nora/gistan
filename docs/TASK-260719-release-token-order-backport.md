# TASK-260719: Backport release token-order fix

260719 release-token-order-backport
===

## asis

`scripts/release.ts` の publish は HEAD push → tag push → GITHUB_TOKEN 取得 → goreleaser の順。
token 取得 (gh auth) が失敗すると、remote だけ commit / tag が進んだ半端な状態で止まる。

## tobe

token を push より先に確保し、認証失敗を push 前に検出する。

## todo

- [x] publish() の token 取得ブロックを git push より前へ移動

## testcases

- [x] `deno task check` (fmt --check / lint / type check) が通ること

## notes

- kawsay の release scaffold 作成時 (kawsay: TASK-260719-release-scaffold) の codex レビュー指摘からの backport
- kawsay 側にはもう 1 点「project 名の regex escape / env var 正規化」もあるが、gistan は project 名が
  literal な "gistan" で metacharacter を含まないため対象外
- push 済み・release 未作成で失敗した場合のロールバックは引き続き手動 (goreleaser 再実行で回復可能)
