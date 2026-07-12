# TASK-260712: search のキーストローク反映レイテンシ改善

260712 search latency
===

> **Status: 未着手 (実装は後続 AI に委任)**。調査・設計・判断は 2026-07-12 に完了済み。
> 実装対象は Option A と B のみ。C は保留 (notes 参照)、D は非採用の記録。

## asis

`gistan search` はキーストローク毎に fzf の reload が `<self> __search-render {q}` を起動する。
実データ repo (1590 files / 8.7MB) での実測 (median, Intel Mac / deno 2.9.1):

| ケース | 反映まで |
|---|---|
| 空クエリ | 94ms |
| 1 term | **130ms** |
| 2 terms | 149ms |
| 2 terms + 除外 1 | 162ms |

1 term (タイプ中の支配的ケース) 130ms の内訳:

1. `$SHELL -c` 起動 ~11ms — fzf の reload の仕様。削減不可
2. deno ランタイム初期化 ~30ms — hello-world の compile バイナリでも 41ms (sh 込み)。方式上の下限
3. **gistan のモジュール評価 ~33ms** — `main.ts` が全コマンドを静的 import しており、
   `__search-render` に不要な @std/toml / gh / import 等も毎キーストローク評価される
4. **rg × 3 が直列 ~57ms** — `search_render.ts` が listFiles → termSet (term 毎) → firstHits を
   `await` で順次実行。term が増える毎に +19ms

体感の目安は「~100ms 以下 = 瞬時」。現状は「速いが知覚可能」の帯域。

### 計測手順 (before/after は必ず同一マシン・同一 repo で)

```sh
cd $(gistan root path)   # 実データ repo
BIN=/path/to/compiled/gistan   # deno task compile したもの。deno run では測らない
perl -MTime::HiRes=time -e '
  my $cmd = shift @ARGV;
  system("/bin/sh","-c","$cmd >/dev/null 2>&1"); # warmup
  my @t; for (1..10) { my $s = time; system("/bin/sh","-c","$cmd >/dev/null 2>&1"); push @t,(time-$s)*1000 }
  @t = sort {$a<=>$b} @t; printf "min %.1f med %.1f max %.1f ms\n",$t[0],$t[4],$t[-1];
' "$BIN __search-render deno"
```

## tobe

- 1 term のキーストローク反映が median ~90ms 前後 (A で -20ms、B で最大 -30ms)
- 検索セマンティクス (空白 AND / `!` 除外 / case-insensitive literal / 2 段 tier 表示) は一切不変
- 既存テストが全通過し、A / B それぞれの効果が before/after の実測値で記録されている

## todo

### Option A: `__search-render` の rg 並列化 (トレードオフ実質ゼロ)

対象: `src/commands/search_render.ts` の `runSearchRender`。

- [ ] `termSet()` を「rg 部分」と「path ヒット合流部分」に分離する
  - 現在の `termSet(context, term, files)` は rg `-li` の結果 Set に「display path が term を含む file」を
    合流させてから返す。rg 呼び出し (`rgFilesMatching(context, term)`) だけを切り出し、
    path 合流は rg 結果が出揃った後に純関数で行う
- [ ] `listFiles` + 全 positive term の rg + 全 negative term の rg を `Promise.all` で並列 spawn する
  - **negative term にも path 合流を適用すること** (現行セマンティクス: `!term` は path に term を
    含む file も除外する)。合流には `listFiles` の結果が必要なので、合流・積集合・差集合は
    all 解決後の TS 処理
  - `firstHits` は候補集合に依存するため従来どおり後段 (直列) でよい
- [ ] `search_test.ts` の render 系テストが rg 呼び出しの「順序」に依存していないか確認し、
  依存していれば「呼ばれた引数の集合」での検証に直す
- [ ] 効果を実測して本 TASK に記録 (期待値: 1 term -20ms / 2 terms -40ms、段数が
  「並列集合演算 → firstHits」の 2 段に頭打ちになる)

### Option B: `main.ts` の dynamic import 化 (小さいトレードオフ、効果は要実測)

- [ ] `COMMANDS` を静的 import の handler map から lazy loader map に変える:
  `search: () => import("./commands/search.ts").then((m) => m.run)` の形。
  specifier は必ず文字列リテラル (deno compile が同梱できる条件)
- [ ] 隠し renderer (`__search-render` / `__preview`) も同様に lazy 化する — ここが本命。
  `__search-render` の import graph は search_render.ts + types.ts だけになるはず
- [ ] `RunOptions.commands` (テスト注入) は現行どおり handler 直渡しを受け、
  override があれば lazy load せずそれを使う
- [ ] `COMMAND_DESCRIPTIONS` / usage は静的な文字列のままにする (lazy 化しない)
- [ ] **compile 済みバイナリで dynamic import が動くことを実機確認する**
  (`deno task compile` → `./gistan __search-render foo` を実 repo cwd で実行)
- [ ] 効果を実測し、**`__search-render` の median が 15ms 以上縮まなければ B は不採用として
  revert し、実測値だけ本 TASK に記録する** (V8 初期化が支配的でモジュール評価の
  節約が効かない可能性がある)

### 共通の完了条件

- [ ] `deno task check` / `deno task test` 全通過
- [ ] 検索セマンティクスのテスト (AND / 除外 / tier / 抜粋 / 色) が変更なしで通る
- [ ] before/after の実測値 (上記手順、同一マシン) を本 TASK の notes に追記
- [ ] SPEC-0001 は変更不要のはず (挙動不変)。変わる場合は実装が間違っている

## testcases

- [ ] A: 2 positive + 1 negative のクエリで、結果の file 集合・行・抜粋が並列化前と完全一致する
- [ ] A: negative term が「path にだけ term を含む file」を除外する (合流の回帰)
- [ ] B: `gistan --version` / `--help` / 既知コマンド / search fallback / removed hint の
  dispatch が全て従来どおり (main_test 一式)
- [ ] B: compile 済みバイナリでの `__search-render` / `__preview` 実機動作 (人間 or 実行環境で確認)

## notes

- **Option C (常駐レンダラ) は保留**。search 起動中の gistan 親プロセスが FIFO 経由で描画し、
  reload を `echo {q} > req; cat resp` にする案。プロセス起動が消え、コーパスの
  メモリキャッシュまでやれば ~20-40ms が狙える。保留理由: fzf が旧 reload を kill した際の
  FIFO 書き込み/読み取りレース、後始末、「外部 CLI の糊」という設計思想 (ADR-0001) からの逸脱、
  障害モードが「キーストローク毎に独立」→「レンダラ死 = 検索死」に変わること。
  **再検討トリガ: A+B 後も体感が悪い、またはコーパスが現在の 10 倍規模になったとき**
- **非採用 (D)**: debounce (レイテンシを足すだけ) / ディスク索引キャッシュ (repo 外状態の禁止
  ADR-0001 に抵触 + 鮮度問題) / fzf `--listen` サーバ化 (C より複雑で利得なし)
- preview (`__preview`) も同じ起動コストを払っているため、B が入れば cursor 移動時の
  preview 追従も同時に速くなる
- 実測の生データ (2026-07-12): sh baseline 11ms / hello-world binary 41ms / `gistan --version`
  74ms / render empty 94ms / 1 term 130ms / 2 terms 149ms / 2+1 162ms (すべて median, sh 込み)
