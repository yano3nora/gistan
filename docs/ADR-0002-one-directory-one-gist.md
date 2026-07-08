# ADR-0002: 1 directory = 1 gist に再設計する

- Status: Accepted
- Date: 2026-07-08

## Context

v1 は `snippets/` の 1 file = 1 gist を中心にしていたため、multi-file gist が import 時だけディレクトリ展開され、index / status / doctor / publish の管理対象外になっていた。その結果、publish 時の無言フォーク、再 import による local 編集上書き、drift 不可視化が発生した。

## Decision

- repo layout を `gists/<dirname>/<files...>` に変更し、**1 directory = 1 gist** とする
- index v2 は published gist のみを `dirname` key で管理する
- gist description は予約ファイル `.description.txt` で表現する。publish payload の files には絶対に含めない
- tags / `[tag]` description parsing は廃止する
- doctor コマンドは廃止し、修復は `status --fix` に統合する
- v1 state の migration は実装せず、pre-release として fresh import を要求する

## Consequences

良い点:

- single-file / multi-file が同じモデルで扱える
- import → publish が同じ gist id を更新し、二重 gist を作らない
- local filesystem が gist download 後の形に近くなり、repo を隠さない思想と一致する

コスト:

- 既存 v1 repo は作り直しが必要
- `.description.txt` は gist の通常ファイル名としては使えない。衝突時は import skip と warn で割り切る
- tags は一旦失われる。必要性が明確になるまで戻さない
