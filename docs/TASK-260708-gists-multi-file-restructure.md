# TASK-260708: multi-file gist 全面対応 (gists/ 構造 + index v2)

260708 multi-file gist 全面対応 (gists/ 構造 + index v2)
===

## asis

- `snippets/` はフラットなファイル置き場で、single-file gist のみ first-class (1 file = 1 gist = 1 index エントリ)
- multi-file gist は import 時に `snippets/<slug>--<id8>/` へ展開されるだけで index エントリを持たない。その結果:
    - publish すると元 gist と無関係の新規 gist が生成される (無言フォーク)
    - 再 import で local 編集が無言上書きされる (index が無く skip 判定に乗らない)
    - status / doctor から不可視 (drift 検出の対象外)
    - 「read-only なのに commit 対象の snippets/ に置かれる」という状態モデルの自己矛盾
- index は `.gistan/state.json` version 1。ファイル相対パスをキーに `tags` と `gist` (id / visibility / synced_hash / remote_updated_at) を持つ
- gist の description は `publish --description` の自由文 + tags 埋め込み (`parseDescription` が `[tag]` prefix を解釈)
- doctor が対話修復 (ファイル復元 / 孤児 gist 削除 / stale エントリ掃除) を担当。status は表示のみ
- pull は path 引数指定で個別 pull

## tobe

**設計コンセプト: 「1 directory = 1 gist」。repo のディレクトリ構造を gist の実構造 (download すると dirname/files になる) にそのまま準拠させ、single / multi の区別を消す。**

### レイアウト

```
<gist-repo>/
├ gists/<dirname>/<files...>   # 1 dir = 1 gist。フラット (depth 1 のみ)
├ stars/                       # 変更なし
└ .gistan/state.json           # v2 (後述)
```

- `snippets/` は `gists/` へ改名 (汎用 snippets 管理ツールではなく gist 管理ツールであることの明示)
- **dirname は repo 内での gist の識別子**。gist の description とは独立 (下記予約ファイル参照)
- `gists/` 直下の裸ファイル (dir に入っていないファイル) は非管理。status が「dir に入れてください」と warn する
- depth 2 以上のネスト (`gists/a/b/c.md`) は gist 化不可 (gist filename に `/` を含められない)。status で warn、publish 時はエラー

### 予約ファイル `.description.txt`

- `gists/<dirname>/.description.txt` の内容 (trim 後) が gist の description になる
- **publish 時に gist ファイルとしてはアップロードしない** (唯一の特別扱い。忘れると gist に実ファイルとして公開される事故になるので実装・テスト最重要)
- ファイルが無ければ description は空。ファイルを削除して publish すると remote description をクリアする
- import 時は remote description が非空なら必ず生成する (これを怠ると re-publish で既存 700 件超の description が全消しされる)
- 複数行はそのまま送る (加工しない)。UI 上 1 行表示で崩れるのは自己責任、と README に記載
- 予約名であることを README と `new` / `import` の警告文で明示。import 対象 gist が本物の `.description.txt` を含む場合は warn + その gist を skip

### index v2 (`.gistan/state.json`)

```jsonc
{
  "version": 2,
  "gists": {
    "<dirname>": {                       // gists/ からの相対 dir 名がキー
      "id": "abc123...",
      "visibility": "public",            // "public" | "secret"
      "remote_updated_at": "2026-07-08T00:00:00Z",
      "synced_description_hash": null,   // .description.txt (trim 後) の hash。null = 同期時 description なし
      "files": {
        "filename.md": "sha256:...",     // 最終同期時点の内容 hash (ファイル単位)
        "helper.js": "sha256:..."
      }
    }
  }
}
```

- **tags は全面廃止** (schema v2 には最初から含めない)。`parseDescription` の tags 解釈も削除し、description は素の文字列として扱う
- **index には published gist のみ載せる**。未 publish の dir はファイルシステムだけで表現する (tags が消えたことで「未 publish エントリ」を保持する理由が無くなった。v1 の `gist: null` エントリと doctor の "never published" 分岐は消える)
- キーはソートして書き出す (現行踏襲)
- version 1 の state.json を読んだら明確なエラーで停止し、再作成を案内する (migration コードは書かない):
  `error: index schema v1 detected — gistan v2 restructured the repo layout. Re-run 'gistan root init' with a fresh repo and 'gistan import'. See docs/TASK-260708-gists-multi-file-restructure.md`

### 照合エンジン (reconcile) v2

dir レベルと file レベルの二段で判定する。**status / pull / publish の drift 判定は必ずこの単一モジュールを通す** (AGENTS.md の分散実装禁止の原則)。

- dir レベル: `unpublished` (local にあるが index に無い) / `dir-missing` (index にあるが dir が無い) / `remote-deleted` (index にあるが remote gist が 404)
- file レベル (published dir 内): `local-drift` (現 hash ≠ synced hash。ファイル追加・削除も local-drift) / `remote-drift` (remote updated_at ≠ synced) / `conflict` (両方)
- description: `.description.txt` の現 hash ≠ synced_description_hash も local-drift
- 検出は hash ベース。どの行がどう変わったかは追わない (conflict 時の diff 提示は pull 側の責務として現行踏襲)

### コマンド仕様

```
gistan new [-d <desc>] <filename | dirname/filename>
    # new filename.md         → gists/filename/filename.md (stem を dirname に)
    # new dirname/filename.md → gists/dirname/filename.md (既存 dir への追加ファイルも可)
    # -d 指定時のみ .description.txt を生成
gistan search [query] [--path|-p]
    # ファイル単位 fuzzy pick (dirname/filename.ext 表示)。.description.txt も特別扱いせず検索対象
    # 通常: 選択ファイルを $EDITOR で開く (現行踏襲) / -p: エディタを開かず絶対 path を stdout へ
gistan edit [query]      # ファイル単位 pick → $EDITOR (現行踏襲)
gistan rm [query]
    # ファイル単位 pick。published なら gist からも該当ファイルを削除 (確認付き)
    # gist の最後の 1 ファイルなら「gist ごと削除」を警告して確認。local の dir が空になったら dir も削除
gistan publish [query] [--secret|--public]
    # ファイル単位 fuzzy pick → 親 dir を対象に「<dirname> 全体 (N files) を publish します」と注意 → 確認
    # create: 全ファイル + description / update: hash 差分のあるファイルのみ、削除ファイルは null、description 変更も反映
    # 可視性変更 = delete + 再作成の警告 (現行踏襲、dir 単位)。--description フラグは廃止
gistan unpublish [query] # 同様に dir 単位。gist 削除 + index エントリ削除、local ファイルは残す (現行踏襲)
gistan pull [dirname]
    # 引数なし: remote-drift / conflict のある gist (dir) を fuzzy pick。引数あり: 直接指定
    # dir 内ファイル群を remote 内容で上書き。conflict は現行どおり diff 提示 + 確認。全件一括 pull は提供しない
gistan status [--remote] [--fix]
    # default: offline。published 一覧 + visibility + local drift (index vs local files、hash 比較のみ、API 呼ばない)
    # --remote: remote list を fetch し remote-drift / conflict / remote-deleted / dir-missing も検出
    # --fix: 検出結果に対する対話修復 (旧 doctor: gist からファイル復元 / 孤児 gist 削除 / エントリ unlink)。--remote を暗黙に含む
    # doctor コマンドは削除
gistan import [--limit <n>]
    # multi-file を first-class に取り込む: gists/<dirname>/<files> + .description.txt + index v2 エントリ
    # dirname 生成: slugify(description)。空なら gist--<id8>。衝突時は --<id8> suffix (現行の流儀)
    # index に同 gist id があれば skip (現行)。local に同名 dir があり index 未登録なら override するか確認 (decline → skip)
    # gitleaks scan は現行維持
gistan list [--published|--local|--stars]
    # dir (gist) 単位で一覧。published は visibility とファイル数を表示。--tag は廃止
```

## todo

- [ ] `src/core/state.ts`: schema v2 型定義・load (v1 検出エラー含む)・save
- [ ] `src/core/reconcile.ts`: dir + file 二段照合へ書き換え
- [ ] `src/core/gh.ts`: multi-file 対応 (create / update の files map、update 時のファイル削除 = null、description 設定・クリア)
- [ ] `src/core/description.ts`: tags 解釈 (`parseDescription`) を削除、slugify は dirname 生成用に維持
- [ ] `src/core/snippets.ts`: `gists/` スキャン (dir 単位 + 裸ファイル・ネスト検出)、`.description.txt` の hash 計算
- [ ] `src/commands/`: new / search / edit / rm / publish / unpublish / pull / status / import / list を上記仕様へ書き換え
- [ ] `src/commands/doctor.ts` を削除し、修復ロジックを `status --fix` へ移植
- [ ] `docs/SPEC-0001-gistan-cli.md` 全面改訂: Terms (snippet → gist/dir)、Behavior、コマンド一覧、レイアウト、index スキーマ、Invariants (「byte 一致」の例外として `.description.txt` を予約名として明記 / doctor → status --fix)、Open Questions の multi-file 項を解決済みに
- [ ] `docs/ADR-0002-one-directory-one-gist.md` 新規作成: 本再設計 (dir = gist 準拠 / tags 廃止 / .description.txt / index は published のみ) の決定と背景を記録
- [ ] `AGENTS.md` 更新: doctor 記述 → status --fix、snippets/ 用語、tags 廃止
- [ ] `README.md` 更新: 予約名 `.description.txt` の明示を含む

## testcases

- [ ] reconcile v2: unpublished / dir-missing / remote-deleted / local-drift (編集・追加・削除) / remote-drift / conflict / description drift の各判定 unit test
- [ ] state v2: load / save round-trip、v1 state.json 読み込みで案内付きエラー
- [ ] publish: create 時 `.description.txt` が gist ファイルに**含まれない**こと (最重要)。update 時に差分ファイルのみ・削除ファイル null・description 反映のペイロード検証
- [ ] publish: description ファイル削除 → remote description クリア
- [ ] rm: 最後の 1 ファイルで gist ごと削除の確認が出ること
- [ ] import: multi-file gist が dir + index エントリ + .description.txt 付きで取り込まれ、再 import で skip されること。dirname 衝突 suffix。同名 dir 既存時の override 確認。`.description.txt` を含む gist の warn + skip
- [ ] import → publish の round-trip で二重 gist が生成されないこと (dir 単位)
- [ ] status: offline 時に API を呼ばないこと。--fix で旧 doctor 相当の修復が動くこと
- [ ] `deno fmt` / `deno lint` / `deno test` 全通過

## notes

- 背景: single-file のみ first-class の割り切りが publish フォーク・無言上書き・doctor 不可視の矛盾を生んでいた (260708 の会話で確認)。手元実測で 753 gists 中 multi-file は 56 件 (7%)
- 移行は「作り直し」と判断済み: pre-release かつ利用者は本人のみ。未 publish の local 編集がある場合のみ手動退避が必要
- tags は「後付け不可・全コマンドにフィルタが欲しくなる・multi-file で煩雑化」により一旦全廃。運用が固まったら再検討 (SPEC Open Questions に残す)
- gist は dotfile を含められるため `.description.txt` は理論上衝突しうる → 予約名として文書化 + import 時 warn で割り切る
- 本タスクは root コマンド再編 (TASK-260708-root-command-reorg) と SPEC 編集が被るため直列で先に実施すること
