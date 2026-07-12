# ADR-0003: dirname を gist-id に固定し description を index メタデータへ移す

- Status: Accepted
- Date: 2026-07-12

## Context

ADR-0002 の `gists/<dirname>/` 構成には、運用して見えてきた 2 つの歪みがある。

### dirname が「ユーザーの分類軸」として機能していない

- `import` は `slugify(description)` を dirname にするが、slugify は ascii
  英数字しか残さないため、日本語 description は空文字に落ちて `gist--<id8>` になる。「dirname =
  description ぽいもの」という建付けは非 ascii ユーザーでは最初から破綻している
- GitHub gist 側に「タイトル」に相当する概念がなく (web UI のタイトル風表示は single-file
  ならファイル名、multi-file なら最後に編集したファイル名にすぎない)、dirname を remote
  に反映する手段が存在しない。つまり dirname は「gistan 上にしか存在しない grouping」であり、tag
  と同様にすぐ腐る分類をツールがユーザーに強要する形になっていた (だからこそ検索は flatten な
  document 単位にした経緯がある)
- そもそも dirname/filename 構成を採った動機は「multi-file gist を扱えない状態からの脱却」(ADR-0002)
  であって「grouping したいから」ではない。ユーザーに dirname を管理したい欲求はない

### description が第一級市民でも道具でもない中途半端な位置にいる

- 作成 (`new -d`) では `.description.txt` を作るが、検索 (`search` / `grep`) は内容 + display path
  のみ照合で description は一切ヒットしない
- 編集導線は実は存在する (`.description.txt` 編集 → local-drift → `publish`) が SPEC
  に明文化されておらず発見不能
- description は未入力 OK な項目であり、「重要度・情報量に対して管理コスト (予約ファイル・drift
  判定・予約名衝突の warn) の方が重い」

## Decision

### 1. `gists/<dirname>/` の dirname はツール管理領域とし、gist-id に固定する

- published gist は `gists/<gist-id>/<files...>`。未 publish は `gists/<local-id>/<files...>`
  (local-id は `_` 始まりの採番文字列。gist-id と衝突しない)
- **1 directory = 1 gist の原則 (ADR-0002) は維持する**。変わるのは dirname の意味づけだけ
- `publish` 成功時に local-id → gist-id へ dir を rename する。`unpublish` は逆に新しい local-id へ
  rename する (削除された gist の id は dangling URL なので使い回さない)
- published 判定は index が正。dirname の形式そのものには意味を持たせず、ユーザーが手で
  `gists/_drafts/` のような dir を作っても壊れない (repo を隠さない原則の維持)
- ユーザーへの見せ方は「multi-file gist も single-file 同様、flatten な filename.ext
  の集まり」とする。検索・一覧では dirname (id) を表示せず、filename + description
  補助表示で認知させる。id / URL が必要な場面 (publish / unpublish 等) は search
  からのコピー操作で取得する

### 2. description は `.description.txt` を廃止し index (`.gistan/state.json`) のメタデータにする

- `new -d` / `publish -d` で指定し、publish 時に remote へ反映する。`pull` は remote の変更を index
  へ追従する。専用の編集コマンドは作らない
- **local 側の description drift という概念を消す**: `publish -d` が即時反映するため、index の
  description は常に「最終同期時点の値」となり、reconcile の description 判定は remote-drift
  のみに簡素化される
- 検索 (`search`) のマッチ対象と結果表示に description を補助的に組み込む
  (第一級の管理対象ではなく、検索を助ける読み取り専用メタデータという位置づけ)

### 3. 日常操作を `push` / `pull` の 2 コマンドに集約し、`status` は温存する

- `push`: published gist の local drift を全列挙 → 対話確認 → 一括 publish
- `pull`: remote drift を全列挙 → 対話確認 → 一括取り込み (現行の per-dir `pull` を置換)
- conflict (両側 drift) は push / pull では skip して `status` へ誘導する。ADR-0001 の「conflict
  は自動解決せず人間が選ぶ」を維持するため
- `status` は read-only レポート + `--fix` (dir-missing / remote-deleted 等の修復)
  の受け皿として温存する。「何もしないで全体を眺める」口を action コマンドの対話に兼ねさせない
- 個別の `publish` / `unpublish` は id or URL 指定のみとする。個別操作は「search で id
  を調べてから行う gist メンテ作業」と位置づける

## Alternatives Considered

- **dirname をユーザーの自由命名に委ねる (現状維持)**: gist
  側に反映できない分類をツールが持つことになり、tag と同じ腐り方をする。import 時の slugify
  破綻も解決しない
- **description を dirname に「正しく」反映する (unicode 対応 slugify + rename 追従)**: description
  は未入力 OK かつ remote から人手で変更されうるため、dirname が安定しない。rename
  追従は自動同期の泥沼に近づく
- **description を第一級市民に格上げする (専用編集コマンド + 全面的な drift 管理)**:
  情報量に対して管理コストが見合わない。gist の description は「検索の補助」以上の価値を持たない
- **status を廃止して push / pull に修復・conflict 解決まで統合する**: 「no
  と答えて状態確認代わり」という歪な UX になり、dir-missing / remote-deleted
  の修復がどちらのコマンドにも自然に収まらない
- **short-id を検索一覧に常時表示して同名 filename を区別する**: 「id
  を認知させない」方針が半分崩れる。description 補助表示で足り、description 未設定同士の同名衝突は
  preview で判別できる

## Consequences

### 良くなること

- import 時の slugify・dirname 採番の破綻が消える (id をそのまま使うだけ)
- `.description.txt` の予約名が消え、「gist file と remote gist file は byte
  一致する」が例外なしの不変条件になる。同名ファイルを含む gist の import skip 問題 (ADR-0002
  のコスト) も消滅
- `stars/<owner>/<gist-id>/` と layout が対称になる
- 目標体験「Zenn の GitHub 連携の gist 版」との整合: Zenn もランダム slug のファイル名 +
  メタデータ分離であり、「repo で雑に書き、タイトル等は公開面のメタデータ」というモデルが一致する
- 日常操作が `new` → `push` / `pull` にほぼ収束する

### リスク・コスト

- `gists/` 直下が hash の羅列になり、Obsidian / GitHub web UI での directory browse 性が落ちる
  (ADR-0001 Consequences の一部後退)。filename での quick-open・検索は生きるため許容する
- 未 publish gist の description が index に載るため、「index には published のみ」という v2
  の単純さが失われる (locals セクションの追加)
- publish / unpublish が dir rename を伴うため、エディタで該当 dir を開いたまま publish すると
  buffer の path が古くなる

## Migration Notes

- index v2 → v3 の自動 migration は実装しない。v2 state を読んだら fresh re-import
  を案内して停止する (v1 → v2 と同じ方針)
- 未 publish dir と `.description.txt` の内容は手動移行となる。README / エラーメッセージで案内する

## Open Questions

- `push` の対象に未 publish dir を含めるか。現時点では含めない (誤公開防止。新規 gist 化は
  `new --publish` か個別 `publish` の明示操作)
- description の検索マッチ・補助表示が search のレイテンシ (TASK-260712-search-latency)
  に影響する場合の縮退方法

## Progress

- 2026-07-12: 運用フィードバック (import dirname の破綻・description の中途半端さ)
  を受けて壁打ちし初版作成。status 温存 / description 補助表示 / new -d + publish -d のみ / fresh
  re-import を決定
