# TASK-260706: 開発一区切り — 残タスクと再開ポイント

260706 next steps
===

> **Status: クローズ (2026-07-12)**。ここに書いた 1〜3 (実データ検証 / 本運用開始 / star) は完了。
> 現在の再開ポイントは [TASK-260712-wrap-up-and-next](./TASK-260712-wrap-up-and-next.md) を参照。

## asis

v1 (init / import / search / publish / status) + v2 (pull / doctor / new / edit / list /
rm / unpublish / sync / root) 実装済み。テスト 70 件 green、`--help` に全 14 コマンド。
ここまでの記録は TASK-260705 (v1) / TASK-260706-gistan-v2 (v2)。

**未検証・未実装なのは「実データでの検証」「star (v3)」「運用開始の周辺作業」のみ。**

## tobe

このファイルを読めば、次にどこから触ればいいか迷わない状態。

## todo

再開時は上から順に。

1. **実データ検証 (人間実行)** → [TASK-260706-v1-real-data-verification](./TASK-260706-v1-real-data-verification.md)
    - `brew install gitleaks` → README「Manual E2E check」の手順を一通り (v2 quick pass 含む)
    - fzf / editor / confirm プロンプトの操作感は unit test で担保できていないので、ここで初めて実機確認になる
2. **本運用開始**
    - README「Deployment」の手順でバイナリを PATH に配置
    - 本運用の gist repo を決めて `gistan init`、必要なら remote 追加 + push (人間判断)
    - この開発 repo (gistan) 自体もまだ GitHub に push されていない → push は人間が実行
3. **v3: star mirror** → [TASK-260706-gistan-v3-star](./TASK-260706-gistan-v3-star.md)
    - 運用が安定してから。search / list / rm の stars 対応は実装済みで、mirror を埋める部分だけが残り
4. **運用してから判断する積み残し (急がない)**
    - [ ] AGENTS.md Testing の TODO 2 つ (integration/e2e 方針、bugfix 再現テスト方針)
    - [ ] ADR-0001 Open Questions: multi-file gist の first-class 対応 / index の複数マシン merge conflict (per-file sidecar 化) / クリップボードのクロスプラットフォーム対応 (今は pbcopy のみ)
    - [ ] `sync` の定期実行 (launchd) を gistan 側で持つか
    - [ ] 配布の強化 (バージョニング運用、brew tap 等) — 公開するなら

## testcases

- [ ] 1〜2 完了後、日常運用 (書く → publish → 検索 → たまに pull/doctor) が gistan だけで回っている

## notes

- 設計の正: [SPEC-0001](./SPEC-0001-gistan-cli.md)、決定背景: [ADR-0001](./ADR-0001-repo-as-source-of-truth.md)
- 実装の歩き方: エントリポイント `src/main.ts` → 各コマンド `src/commands/*.ts` → 共通層 `src/core/*` (照合エンジンは `core/reconcile.ts`、ここが唯一の難所)
- 検証コマンド: `mise exec -- deno task check && mise exec -- deno task test`
