# TASK-260708: CLI UX improvements

260708 root status / status 出力削減 / search 完全糖衣 / search 視認性
===

## asis

- `gistan root` に git status 相当がなく、repo の変更状態を見るには cd してから git を叩くしかない
- `gistan status` は全 gist を毎回列挙する。750 件規模では in-sync が大半でも全行出るため drift が埋もれる
- `gistan -p <query>` が効かない。main.ts の parseArgs が `-p` を flag として食い、search へ届かない (`gistan` 裸起動 = search という糖衣が flag 付きで破綻している)
- search の表示: 全行が `gists/` prefix 付きで冗長。query 入力時は rg の全文 grep のみで、dirname / filename は検索対象にならない。preview は match 行の前後 19 行固定で scroll できない

## tobe

- `gistan root status` で `git status` を repo に対して実行できる (push / pull と同じ「再ラップしない passthrough」)
- `gistan status` は git status と同様「対応が必要なものだけ」列挙する
  - 既定で表示する condition: `unpublished` / `local-drift` / `remote-drift` / `conflict` / `remote-deleted` / `dir-missing`
  - 既定で隠す condition: `in-sync` と `remote-unknown` (= published)
  - summary 行 (`750 gist(s): 747 in-sync, 2 local-drift, 1 unpublished`) は従来どおり常に出す
  - `--all` で従来の全件列挙。dirname filter 指定時 (`gistan status foo`) は condition に関わらずその item を表示する
- `gistan` は search の完全糖衣: 第一引数が既知 command / removed hint / `-h|--help` / `--version` のいずれでもなければ、**argv 全体を** search へ委譲する (`gistan -p foo` = `gistan search -p foo`)
- `gistan s` を search の alias として追加する (query が command 名と衝突するとき明示的に search を選べる: `gistan s list`)
- search の表示改善:
  - 表示上 `gists/` prefix を除去する (`stars/` は star mirror の区別に必要なので残す)。選択結果は `toRelPath` (shared.ts) で repo 相対 path に戻す
  - query 入力時、file path (dirname / filename) に query が match する file も結果に含める (filename hit → content hit の順で連結)
  - preview は match 行付近に位置合わせしつつ file 全体を対象にし、ctrl-u / ctrl-d で scroll できる。query の match 行は色付けする (rg --passthru 等)

## todo

- [ ] root.ts: `status` subcommand 追加 (`runPushPull` を汎用 passthrough として流用 or 改名)。USAGE 文字列更新
- [ ] main.ts: `COMMAND_DESCRIPTIONS.root` に status を追記
- [ ] status.ts: 既定 filter (`in-sync` / `remote-unknown` を隠す) + `--all` flag。summary 行は維持。dirname filter は常に表示
- [ ] main.ts: dispatch 再構成。第一引数を parseArgs より前に判定し、未知の第一引数は argv 全体ごと search へ fallback する。`s` → `search` alias 追加 (usage にも記載)
- [ ] search.ts: LIST_CMD / GREP_CMD / RELOAD_CMD を「filename match 連結 + `sed 's|^gists/||'` による prefix 除去」に更新。選択結果の path 復元に `toRelPath` を使う (`-p` 出力と openEditor 双方)
- [ ] search.ts: preview 改善 (match 行へ位置合わせ + rg --passthru による match 行 highlight + ctrl-u / ctrl-d scroll bind)。filename hit (line 番号なし) でも preview が壊れないこと
- [ ] test 更新: root_test.ts / main_test.ts / status_test.ts / search_test.ts
- [ ] docs 更新: SPEC-0001 (Commands 節: `root status`, `status [--all]`, search 挙動, 糖衣仕様と `s` alias) / README (該当例)

## testcases

- [ ] `gistan root status` が repo cwd で git status を実行し、exit code / stdout / stderr をそのまま伝播する
- [ ] `gistan status`: 全件 in-sync のとき list 部が空で summary のみ出る。drift 混在時は drift 行のみ + summary
- [ ] `gistan status --all`: 従来同様全件出る
- [ ] `gistan status <dirname>`: in-sync でもその item が出る
- [ ] `gistan -p foo` が search に `-p foo` として届く (runner mock で fzf 呼び出し引数を検証)
- [ ] `gistan s foo` = `gistan search foo`。`gistan --version` / `gistan -h` / `gistan init` (removed hint) は従来挙動
- [ ] `gistan 未知語` が search fallback する (usage エラーにならない)
- [ ] search: fzf に渡る reload command が `gists/` prefix 除去と filename match 連結を含む。選択行 `foo/bar.md:12:...` と `stars/x/y.md` の両方で編集対象 path が正しく復元される
- [ ] `deno task check` / `deno task test` が通る

## followup (実機フィードバック 1 回目)

### tobe

- search 結果は query の有無に関わらず path で sort され、dir 単位で固まって見える
  - empty query: list を `sort`
  - query あり: filename hit と content hit を混ぜて `sort -t: -k1,1 -k2,2n`。同一 file では filename hit (行番号なし = k2 空 = 数値 0) が先頭に来て、その file の content hit が行番号順に続く
  - sort は無色の結合 stream に対して行い、色付けは従来どおり最後の 1 pass (ANSI code が sort key を壊すため)
- ctrl-o で選択中 item の gist URL をブラウザで開ける。fzf は抜けない (`execute-silent`)
  - dirname → gist id の解決: search 起動時に `loadState` して `<dirname>\t<id>` 形式の一時 map file を書き出し、bind の sh は `awk -F'\t'` で引くだけにする (sh での JSON parse を持ち込まない)。fzf 終了後に map file を削除する
  - URL 構築は `gistUrl` (core/gh.ts) と同一形式。opener は `Deno.build.os` で分岐 (darwin: `open` / それ以外: `xdg-open`)
  - 未 publish dir (map に無い) は no-op。`stars/*` も現状 no-op (v3 の `stars/<owner>/<gist-id>/` 配置が入れば path から id を導出できる — v3 側の todo とする)

### todo

- [x] search.ts: RELOAD_CMD 両分岐に sort を挿入
- [x] search.ts: loadState + 一時 map file 書き出し (finally で削除) + `ctrl-o:execute-silent(...)` bind 追加
- [x] search_test.ts: reload command の sort、ctrl-o bind、map file の内容と後始末を検証
- [x] docs: SPEC-0001 の search 挙動 bullet に sort / ctrl-o を追記。TASK-260706-gistan-v3-star.md の todo に「ctrl-o の stars 対応 (path から id 導出)」を追加

### testcases

- [x] 空 query / query ありの両方で reload command が sort を含む
- [x] `foo/bar.md` (filename hit) と `foo/bar.md:12:...` `foo/bar.md:3:...` を混ぜた入力で、sort 後の順序が `bar.md` → `:3:` → `:12:` になる (sh 断片単体で検証)
- [x] fzf 呼び出し引数に ctrl-o bind が含まれ、map file path と opener command が正しく埋め込まれる
- [x] state に 2 件ある fixture で map file が `dirname\tid` 2 行になる。fzf 終了後 (異常終了含む) に map file が消える
- [x] map に無い dirname / stars path で bind の sh 断片が exit 0 で何もしない (sh 断片単体で検証)
- [x] `deno task check` / `deno task test` が通る

## followup 2 (search を document 単位の fzf ネイティブ検索へ / 旧実装は grep として温存)

### 背景

- 現行 search は fzf `--disabled` + 毎キーストローク rg reload で、query 全体を 1 本の正規表現として扱う。スペースはリテラル空白であり「Google 的なスペース区切り AND」にならない
- gist は互いに独立した小文書なので、検索の単位は「一致行」ではなく「document (= file)」が適切。fzf ネイティブの extended-search (space = 順不同 AND, `!` 除外, `'` toggle) に任せるのが体験・実装両面で最良と判断した

### tobe

- `gistan search` は document 単位の fzf ネイティブ検索になる:
  - 起動時に TS 側で index を構築して fzf の **stdin** へ渡す (runner の `stdin` option を使う。reload bind と一時 script は不要になる)
  - index item は 1 file = 1 行: `<display path>\t<平坦化した file 内容>`。display path は従来同様 `gists/` を除去し `stars/` は残す。平坦化は `[\n\r\t]+` → 半角 space 1 個 (tab は delimiter なので必ず除去)。item は display path で sort する
  - dir に `.description.txt` があれば、その平坦化テキストを**同 dir の全 item の検索対象テキスト末尾に追記**する (description hit で実 file が引っかかるように)。`.description.txt` 自身も従来どおり 1 item として残す
  - 1 MiB 超の file と読み取り失敗 file は内容を index せず path のみの item にする (fzf の肥大化防止)
  - fzf は `--exact` / `--delimiter '\t'` / `--with-nth 1` (表示は path のみ、マッチは内容込み) / `--print-query`。`--disabled` `--ansi` reload bind は廃止。fuzzy 既定にしない理由: 全文 subsequence 一致は文書検索ではゴミ結果製造機になるため。`'term` で term 単位の fuzzy には戻せる (fzf の --exact 時の `'` は toggle)
  - preview: TS が空の一時 pattern file を用意し、preview command 冒頭で `{q}` を空白 split → fzf 演算子を除去 (`!term` 行は削除、先頭 `'` `^` と末尾 `$` を strip、`|` と空行を削除) して pattern file に書き、`rg --passthru -i -F -f <patfile>` で全 term を highlight。最初の一致行 (`rg -in --max-count=1 -F -f`) の 5 行上へ位置合わせ。pattern file が空 (query 無し) なら `cat`。既存の `-f` guard (空 {1} / directory / 消えた file → exit 0) は維持
  - Enter 後: `--print-query` の 1 行目 = query、2 行目 = 選択 item。選択 item の先頭 tab までが display path → `toRelPath` で復元。editor への行 jump は TS で計算する: query から正の term (空白 split、`!...` は除外、先頭 `'` `^` 末尾 `$` を strip、空と `|` を除外) を取り、file を読んで**いずれかの term を含む最初の行** (case-insensitive 部分一致)。無ければ行指定なし
  - ctrl-o (map file + browse bind) / ctrl-u・ctrl-d / `--path|-p` / exit code 1・130 の扱いは従来どおり。map file と pattern file は finally で削除
- 旧 search 実装は `gistan grep` として温存する (比較用。行レベル regex grep が要る場面のため):
  - 現 search.ts をほぼそのまま grep.ts へ移す。`-p/--path`・ctrl-o・preview 等は現行のまま
  - browse bind (map file 書き出し含む) と preview scroll bind 等、両 command で共有するものは shared.ts へ抽出して重複実装しない
  - `gistan` 裸起動・`s` alias・完全糖衣 fallback の行き先は search (document 検索) のまま

### todo

- [x] grep.ts 新設 (現 search.ts の移設) + types.ts の CommandName に grep 追加 + main.ts (COMMANDS / COMMAND_DESCRIPTIONS)
- [x] shared.ts: browse bind (map file 書き出し + bind 文字列) と preview scroll bind の共有化
- [x] search.ts を document モードへ書き換え (index 構築 / stdin 渡し / --exact --print-query / preview / 行 jump 計算)
- [x] search_test.ts 書き換え + grep_test.ts 新設 (旧 search テストの移設) + main_test.ts (grep 追加)
- [x] docs: SPEC-0001 (Commands に grep 追加、search の挙動 bullet を document 検索仕様に書き換え、fzf 検索文法への言及) / README (search と grep の例)

### testcases

- [x] index: 複数行 file が tab 区切り 1 行に平坦化され、`gists/` が除去され、path で sort されている。`.description.txt` の内容が同 dir の他 item 末尾に追記されている
- [x] 1 MiB 超の file が path のみの item になる
- [x] fzf 呼び出し: stdin に index が渡り、args に --exact / --delimiter / --print-query があり、--disabled と reload bind が無い (--with-nth は下記 note により不採用)
- [x] fzf の `--exact --filter` (非対話 mode) で実 fzf に対し「space 区切り 2 term の順不同 AND」「`!term` 除外」が index item に効くことを検証 (semantics の実機確認)
- [x] --print-query 出力 (`query\npath\tcontent`) から path 復元と行 jump が正しい: term が 3 行目にある fixture で editor が `+3` で開く。`'foo !bar` のような query で jump 対象 term が foo だけになる
- [x] --path 指定時に絶対 path が出る。exit 1 / 130 は正常終了扱い
- [x] preview の sh 断片単体検証: 2 term highlight、一致行への位置合わせ、query 空で cat fallback、空 {1} / 消えた file で exit 0
- [x] map file / pattern file が fzf 異常終了時も消える
- [x] `gistan grep` が旧 search と同じ挙動 (旧テスト一式が grep で通る)
- [x] `deno task check` / `deno task test` が通る

### note: --with-nth は不採用 (実機検証による設計変更)

`--with-nth 1` は表示を path のみにするが、fzf のマッチングは with-nth 変換後の行に対して行われ、隠した field は検索対象にならない (fzf 0.67 の `--filter` で実機確認。man にも "fzf doesn't allow searching against the hidden fields" と明記)。内容マッチこそが本機能の核なので `--with-nth` は付けず、「path + TAB + 平坦化内容」の行をそのまま表示する (path が行頭、内容の末尾は画面幅で切れる)。

## followup 3 (search の一覧を `path:line: ヒット前後の抜粋` にする / self-reload 方式)

### 背景 (実機フィードバック 2 回目)

- followup 2 の document モードは fzf ネイティブマッチのため item = `path\t全文` をそのまま表示する。fzf はマッチ箇所を見せるために行を横スクロールするので、本文の奥でヒットすると **path が画面外に消える**。人間に必要なのは第一に「どの gist / file か」、第二に「ヒット前後の文脈」
- 望む一覧は `dirname/file.md:50: …ヒット前後の抜粋…`。これは query 依存の表示なので fzf ネイティブマッチでは実現不能 (fzf は item 文字列の表示しかできない)。reload 方式に戻すが、followup 1 で懲りた sh 断片の量産はしない: **reload は gistan 自身の隠しサブコマンド `__search-render` を呼ぶ**。分割・積集合・抜粋・色付けを全部 TypeScript でやる (sh quoting / zsh word-split / awk multibyte の問題が全て消え、unit test 可能になる)

### tobe

- `gistan search` は fzf `--disabled` + `--ansi` に戻し、start / change の reload で `<self> __search-render {q}` を呼ぶ
  - `<self>` の解決: `Deno.execPath()` の basename が `deno` なら `"<execPath>" run --allow-read --allow-run --allow-env "<fromFileUrl(Deno.mainModule)>" __search-render {q}` (dev 用)、それ以外 (compile 済み binary) は `"<execPath>" __search-render {q}`。path は必ず quote する。この組み立ては純関数に切り出して unit test する
  - fzf ネイティブ演算子は廃止し、search 独自の Google 風 query 仕様にする: **空白区切り = file 単位の順不同 AND**、`!term` = その term を含む file を除外。`'` `^` `$` は特別扱いせずリテラル文字として検索。マッチは常に case-insensitive の literal (regex でない)
- `__search-render` (隠しサブコマンド、usage / COMMAND_DESCRIPTIONS に載せない):
  - cwd を gist repo として動く (fzf の reload は cwd=repo で走る。config 解決は不要)。args を join したものが query。flag parse はしない
  - 空 query: `rg --files --no-ignore gists stars` を display path (gists/ 除去) で sort して 1 行ずつ出力
  - query あり:
    1. query を空白 split → 正 term 群と `!` 負 term 群に分ける (正 term が 0 なら空 query と同じ扱い)
    2. 正 term ごとに `rg -li -F -- <term> gists stars` で file 集合を取り積集合、負 term の集合を引く (rg の filename match は content に効かないため、**display path に term を含む file も正 term の集合へ加える**。file 一覧は空 query と同じ rg --files から得る)
    3. 残った file 集合へ `rg -in --max-count=1 -F -f <pattern> -- <files...>` (pattern = 正 term を行区切りで stdin か一時なしで渡せる `-e term` の複数指定でも可) を 1 回だけ実行し、file ごとの最初のヒット行 `path:line:text` を得る。path のみヒットの file (content ヒットなし) は `path` のみの行にする
    4. 各行を `display_path:line: <抜粋>` へ整形して display path で sort して出力。抜粋は最初の正 term の出現位置の前後 ~60 文字 (Array.from ベースで文字単位に切り、先頭/末尾が切れたら `…` を付ける)。ANSI 色付けも TS で行う: path は通常色、`:line:` と抜粋は dim、抜粋・path 中の正 term 出現箇所は highlight (fzf は --ansi)
  - rg 呼び出しは Runner 経由でなく直接 `Deno.Command` でよい…ではなく、**必ず context.runner 経由** (テスト容易性の既存方針を守る)
- 選択後の処理は grep と同型に戻る: `:` split で path と line が直接得られる (行 jump の再計算 `firstMatchLine` / `positiveTerms` は不要になるので削除)。`-p` / ctrl-o / ctrl-u・d は維持
- preview は現行 (pattern file + tr/sed + rg --passthru + 位置合わせ) のまま。`{q}` の演算子 strip 仕様が `!term` 除去だけになるが、既存 sed は上位互換なので変更不要
- `gistan grep` は変更しない

### todo

- [x] main.ts: `__search-render` の内部 dispatch (usage に非掲載、search fallback より先に判定)
- [x] search.ts: self-reload command 組み立て (純関数 + unit test) / fzf を --disabled --ansi + reload に戻す / 選択行 parse を `:` split へ / firstMatchLine・positiveTerms 削除
- [x] render 実装 (search_render.ts): term 分割・積集合・負 term 除外・path ヒット合流・抜粋・色付け・sort。全て unit test 可能な形で
- [x] search_test.ts 更新 (index/stdin/print-query 系のテストを reload 方式へ書き換え、render の unit tests 追加)
- [x] docs: SPEC-0001 の search 節を「Google 風 query 仕様 (空白 AND / !除外 / literal / case-insensitive)」と一覧 format で書き換え。README の例も更新。followup 2 で書いた fzf 文法への言及を削除

### testcases

- [x] render: 2 正 term の AND (両方含む file だけ残る)、`!term` 除外、path のみヒット file の合流、`path:line: 抜粋` format、抜粋の前後 `…`、CJK query での文字単位切り出し、ANSI 色の付与、display path sort、空 query = 全 file 一覧
- [x] self-reload command: dev (execPath=deno) と compiled の両形態の組み立て、path の quote
- [x] search run(): fzf args に --disabled / --ansi / reload bind があり、選択行 `foo/bar.md:12: …` から editor が `+12` で開く。`-p` / exit 1・130 / ctrl-o bind / temp file 掃除は従来どおり
- [x] 実 fzf + 実 rg での挙動確認: `__search-render` を直接叩いて AND / 除外 / 抜粋 / 色を目視確認 (fixture repo で)。dev 形態の self-invocation が fzf の reload から実際に動くことも live session で確認済み (config は entrypoint からの auto-discovery で解決される)
- [x] `deno task check` / `deno task test` が通る

## followup 4 (実機フィードバック 3 回目: 小修正)

- [x] ctrl-u を `clear-query` (検索入力の全消去) にする。preview scroll は shift-up / shift-down へ退避 (search / grep 共通の `PREVIEW_SCROLL_BIND`)
- [x] `gistan s` alias を廃止 (command を増やしすぎない)。`s` は完全糖衣 fallback により query として search へ流れる。query が command 名と衝突するときは `gistan search list` と明示する

## notes

- 隠す既定に `unpublished` を含めない理由: git status が untracked を表示するのと同じで「まだ publish していない」は対応候補 (publish するか放置するか) の情報。ノイズになる場合は将来 `--short` 等を検討
- 完全糖衣の tradeoff: command の typo (`gistan pubish`) が search になる。search は対話的 fzf なので誤爆に即気づける、と判断して許容。removed hint (`init` / `sync`) は fallback より先に判定して維持する
- fzf preview / reload の sh 断片は quoting 事故が起きやすい。実装後、fzf を介さず sh 断片単体を sample 引数で実行して検証すること (fzf の `{q}` `{1}` `{2}` は quote 済み文字列に置換される前提)
- `.description.txt` は通常 file として rg の全文 grep に既に含まれるため、description 検索は対応済み扱い
