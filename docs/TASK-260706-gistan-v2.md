# TASK-260706: gistan v2 (pull / doctor / 運用糖衣)

260706 gistan v2 実装
===

## asis

v1 (init / import / search / publish / status) 実装済み。
remote 側の変更取り込み (pull)・整合性修復 (doctor)・日常操作の糖衣が未実装。

## tobe

SPEC-0001 の v2 コマンドが動作し、日常運用が gistan だけで完結する。

## todo

- [x] `shared.ts` — config 必須チェック / fzf ファイル選択 / エディタ起動の共通化 — 260706
- [x] `gistan pull [path]` — remote-drift の取り込み。conflict は diff 提示 → remote 適用 or skip (local 温存 → publish で押し返す)。`--stars` は v3 送り — 260706
- [x] `gistan doctor` — 孤児 gist (file-missing) の復元 or 削除、upstream 削除済み gist の unlink を対話修復 — 260706
- [x] `gistan new [--tags] <filename>` — template 適用 + index 登録 + $EDITOR — 260706
- [x] `gistan edit [query]` — fzf ファイル fuzzy 選択 → $EDITOR — 260706
- [x] `gistan list [--tag] [--published|--local|--stars]` — 260706
- [x] `gistan rm [path]` — 確認つき削除。published なら remote も消すか確認。stars/ は拒否 — 260706
- [x] `gistan unpublish <path>` — remote gist 削除、local とタグは温存 — 260706
- [x] `gistan sync` — add / commit / pull --rebase / push (remote 未設定なら local commit のみ) — 260706
- [x] `gistan root` — 260706

## testcases

- [x] pull: remote-drift の自動適用 / conflict の拒否 (local 温存) と承認 (remote 上書き) / upstream 削除の警告
- [x] doctor: file-missing → gist から復元 / upstream 削除済み → unlink / 復元拒否 → 孤児 gist 削除
- [x] rm: 二段確認 (local 削除 → remote も消すか) / 拒否時は何も起きない / stars 拒否
- [x] new: template の {{title}} 置換 / 重複はエラー / `/` 入りはエラー
- [x] sync: 変更ありで commit / remote 未設定で pull/push をスキップ / 変更なしで commit スキップ
- [ ] 対話系 (fzf pick / editor / conflict prompt) の実機確認 — v1 実データ検証と合わせて人間実行

## notes

- pull / doctor は reconcile (照合エンジン) の結果への「適用」だけを書く。drift 判定ロジックの再実装禁止 (SPEC-0001)
- conflict 解決は「remote で上書き or skip」の 2 択に簡略化 (skip + publish が SPEC の「local 優先」に相当)
