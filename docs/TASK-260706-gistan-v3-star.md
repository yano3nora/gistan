# TASK-260706: gistan v3 (star mirror)

260706 gistan v3 star mirror
===

> **Status: 実装完了 (2026-07-12, v0.5.0)**。残るのは下記の未チェック 3 件 (いずれも人間による実機確認のみ)。
> 確認が済んだらチェックを入れて本 TASK をクローズする。

## asis

他人の gist を local で検索・参照する手段がない。search / list / edit は `stars/` を
対象に含む実装済みだが、`stars/` を埋める手段が未実装。

## tobe

GitHub で star した gist が read-only mirror として local 検索に含まれる (SPEC-0001)。

## design

### Commands

```text
gistan star sync         starred gist 一覧を stars/ へ mirror (差分のみ・冪等)
gistan star add <url>    URL/id から gist を star し、その 1 件を即 mirror
```

- `src/commands/star.ts` — `root.ts` と同じサブコマンド dispatch (sync / add / undefined=USAGE / default=エラー exit 2)
- `src/main.ts` / `src/commands/types.ts` — `star` を CommandName / COMMANDS / COMMAND_DESCRIPTIONS に追加 (search fallback より前に解決される既存 dispatch に乗るだけ)

### Layout & cache

- mirror 配置: `stars/<owner>/<gist-id>/<files...>`。`.description.txt` は **置かない** (予約名は gists/ の概念。description は cache に保持)
- cache: `.gistan/cache/stars.json` (gitignore 済み)。形式:

```jsonc
{
  "version": 1,
  "stars": {
    "<gist-id>": {
      "owner": "octocat",
      "description": "...",
      "updated_at": "2026-07-08T00:00:00Z", // remote の updated_at (同期時点)
      "fetched_at": "2026-07-12T00:00:00Z"  // mirror 取得時刻
    }
  }
}
```

- key はソートして保存。壊れた cache (parse 不能 / version 不一致) は空扱いで作り直してよい (再取得可能な cache のため)

### Core (`src/core/stars.ts` + `src/core/gh.ts` 拡張)

- `gh.ts`: `listStarredGists(runner)` を追加 — `gh api "gists/starred?per_page=100&page=N"` の page loop
  (`listOwnGistSummaries` と同じパターン)。返すのは `{ id, owner, description, updated_at }`。
  `owner.login` 欠損時は `"unknown"` に fallback
- `gh.ts`: `getGist` の返却に `owner` (login) を追加 (`star add` が配置先 owner を知るため)
- `gh.ts`: `starGist(runner, id)` を追加 — `gh api gists/{id}/star --method PUT` (204 no content)
- `stars.ts`: cache load/save と `mirrorGist` (files 書き込み + mirror dir 内の stale file 削除)。
  truncated file (>1MB) は pull と同様 warn + skip

### sync アルゴリズム (冪等)

1. `listStarredGists` で remote 一覧取得
2. 各 starred gist: cache の `updated_at` が一致 **かつ** `stars/<owner>/<id>/` が存在すれば skip。
   それ以外は `getGist` で内容取得 → mirror 書き込み → cache 更新 (`synced: N` / `skipped: N` を出力)
3. remote 一覧に無い cache entry / `stars/` 配下の dir は削除 (`removed: N`)。
   owner rename で path が変わった場合も旧 dir 削除 + 新 dir 作成で収束する。
   mirror は再取得可能な cache なので確認プロンプトは挟まない
4. cache 保存

### star add

1. 引数を parse: `https://gist.github.com/<owner>/<id>`、`https://gist.github.com/<id>`、裸の `<id>` を受理。
   末尾 path segment を id とする (32 hex 想定だが厳密 validate はしない)
2. `starGist` (PUT) → `getGist` で内容 + owner 取得 → mirror + cache 更新
3. 引数なしは usage エラー exit 2

### ctrl-o の stars 対応 (`src/commands/shared.ts` browseBind)

- 現状 `stars/*` は no-op。`stars/<owner>/<id>/file` から id (第 3 セグメント) を導出し
  `https://gist.github.com/<id>` を開くように変更
- fzf の execute-silent(...) 制約 (括弧・`$()`・`[` 不可) は維持。`${p#stars/}` 等の
  文字列展開と `test` だけで書くこと。doc comment の「v3 で解消予定」記述も更新

### 実装しないこと

- `gistan pull --stars` — `star sync` と完全重複の alias になるためコマンド面を増やさない。
  SPEC の「全件一括 pull は提供しない」とも整合 (pull は自分の gist の drift 解消、stars は cache 更新で別概念)
- unstar コマンド — GitHub 側で unstar → `star sync` で消える、で足りる (YAGNI)

## todo

- [x] `src/commands/types.ts` / `src/main.ts`: `star` コマンド登録
- [x] `src/core/gh.ts`: `listStarredGists` / `starGist` 追加、`getGist` に owner 追加
- [x] `src/core/stars.ts`: cache load/save + mirror 書き込み
- [x] `src/commands/star.ts`: sync / add
- [x] `src/commands/shared.ts`: browseBind の stars 対応 (ctrl-o)
- [x] `docs/SPEC-0001-gistan-cli.md`: Commands 一覧 + star 挙動 + ctrl-o 記述 (stars no-op → 対応済み) + Layout の cache 追記
- [x] `README.md`: コマンド一覧・説明に star を追記 (該当箇所があれば)
- [ ] search / edit の stars read-only 表示の実機確認 (人間)

## testcases

- [x] star sync が冪等: 2 回目の sync で updated_at 不変の gist に `gists/{id}` GET が飛ばない (fake runner の呼び出し記録で検証)
- [x] updated_at が変わった gist だけ再取得され、mirror dir 内の stale file が消える
- [x] unstar された gist の mirror dir と cache entry が消える
- [x] star add: URL 3 形式の parse、PUT → mirror 書き込み、引数なし usage エラー
- [x] truncated file は warn + skip (pull と同じ挙動)
- [x] 壊れた stars.json は空 cache 扱いで sync が成功する
- [x] browseBind が `stars/<owner>/<id>/f.md` から id を導出する bind 文字列を生成する (単体)
- [ ] mirror が commit されない (`git status` に現れない) — gitignore 済みの確認 (実機)
- [ ] `gistan rm` が stars/ を拒否する (実装済み、確認のみ) — 人間による実機確認待ち。rm.ts は既に `stars/` を拒否する実装済み (自動テストなし)
- [x] `deno task check` / `deno task test` 全通過

## notes

- mirror は再取得可能な cache。編集・書き戻しは Non-Goal (ADR-0001)
- GitHub API は `gh api` subprocess 経由のみ (AGENTS.md)。starred 一覧 API は file content を
  含まないため、内容は gist 毎の `GET /gists/{id}` で取る (raw_url への直接 HTTP は使わない)
