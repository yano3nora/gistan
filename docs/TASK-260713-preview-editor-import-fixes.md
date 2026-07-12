# TASK-260713 preview / editor / import fixes

## Goal

- search / grep preview に実ファイルの行番号を表示する
- invocation 単位で editor を `--editor` / `-e` 指定できるようにする
- v0.7.0 の `root init` が空の v2 index を生成し、`import` が拒否される不具合を直す

## Decisions

- 行番号は syntax highlight / match span の処理後に prefix として付与し、span の座標系を変えない
- editor option は command dispatch 前に抽出し、明示 command と search sugar の両方へ適用する
- 新規 index は v3 とする。v0.7.0 が生成した `{ version: 2, gists: {} }` だけはデータ損失なしで
  判別できるため、`root init` 再実行時に v3 へ修復する。データ入り v2 は従来どおり拒否する

## Verification

- `deno task check`
- `deno task test`
