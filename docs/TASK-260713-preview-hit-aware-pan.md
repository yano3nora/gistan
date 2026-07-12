# TASK-260713 preview hit-aware pan

## Status

Closed (YAGNI).

Default preview is wrapped, so an off-screen horizontal hit is already brought into view by line
wrapping. The existing vertical anchor and reverse-video emphasis make the hit identifiable without
adding a separate pan renderer. No implementation is planned unless a concrete case remains hard to
identify in the default wrapped view.

## Problem

fzf の preview pane は no-wrap 時に横スクロールできない。そのため、長い行の画面外に query hit が
あると、該当行へ縦方向に移動しても一致箇所を確認できない。

## Goal

no-wrap preview では本文だけを hit 周辺へ自動 pan（viewport crop）し、少なくとも優先 hit を画面内に
表示する。行番号と区切りは固定し、crop された側は `…` で示す。

```text
128 │ …const result = veryLongExpression(hitValue)…
```

## Proposed design

- fzf が preview command に渡す `FZF_PREVIEW_COLUMNS` を利用し、利用可能な表示幅を決める
- `行番号 + separator` と本文を分離し、pan/crop は本文だけに適用する
- wrap 時は全文表示を維持し、no-wrap 時だけ hit-aware crop を適用する
- query hit が収まる範囲で、優先 hit の前にも文脈を残す。hit がない行は行頭から表示する
- ANSI SGR sequence は表示幅に数えず、crop 境界で壊さない。bat の syntax highlight と reverse-video
  の hit 強調を維持する
- JS の文字数ではなく terminal display width を基準にする。CJK、結合文字、絵文字、tab をテストする
- 左右の省略記号も表示幅へ含める

## Open questions

1. preview renderer に wrap/no-wrap 状態をどう渡すか
   - fzf の toggle 状態を subprocess が直接取得できない場合、wrap/no-wrap 用の明示的な bind / renderer
     mode が必要
2. 複数 hit が同じ長い行にある場合の優先順位
   - 初回は左端の hit を優先する案が単純。ただし grep の選択行では row に対応する hit を優先できるか検討
3. tab の扱い
   - 現状の `bat --tabs=0` を維持して表示幅を計算するか、preview に限って固定幅へ展開するか決める
4. terminal width 実装
   - 新規 dependency を避けて必要十分な width 計算を持つか、Deno/std に適切な実装があるか調査する

## Non-goals

- preview pane の手動横スクロールの再現
- editor / viewer の代替
- fzf 自体の改造

## Acceptance criteria

- no-wrap で画面外にある優先 hit が表示される
- 行番号、separator、hit 強調、bat の色が維持される
- wrap 時の表示は現状から変わらない
- CJK、絵文字、tab、ANSI、複数 hit、preview 幅不足をテストする
- `deno task check` / `deno task test` が成功する
