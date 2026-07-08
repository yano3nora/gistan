# ADR-0001: markdown repo を Source of Truth とし gist へは明示的コマンドでのみ同期する

- Status: Proposed
- Date: 2026-07-05

## Context

- gist は「Obsidian までは要らないエンジニアの第二記憶装置 + 雑な公開手段」として最適な位置にいるが、大量コンテンツの管理には機能が貧弱すぎる
    - 階層・タグなし、検索は description 頼み、1 gist = 1 git repo のため横断 grep 不可
    - 作者 (yano3nora) は既に約 753 個の gist を持ち、「過去の賢かった自分のメモ」を探せない
- 既存解の VSCode 拡張 gistpad には構造的な課題がある
    - VSCode がないと動かない (terminal / agentic coding で使えない)
    - 双方向同期が不安定 (conflict 解決・rate limit・部分同期は個人開発で勝てない領域)
    - gist URL をサクッと取得できない
- Zenn の GitHub 連携のように「repo で雑に書き、公開したいものだけ web サービスへ」という体験を gist に持ち込みたい
- 共有はほぼ public gist で足りる。極稀に secret を使う程度。チーム向けアクセス制御は不要
- 出先でスマートフォンから gist / repo を更新し、後で取り込むことが稀にある
- agentic coding の普及により、snippets を terminal・agent から grep / 編集できる価値が上がっている

## Decision

「gist 向け snippets を集約する markdown repo (= gist repo)」の構成・運用を補助する CLI として gistan を作る。

### 1. repo が Source of Truth、gist は「公開面」

- snippets の実体は普通の git repo (private) に置く。検索・編集・agent 連携はすべて local で完結させる
- gist は publish 先であり、repo 上のファイル内容がそのまま gist の内容になる (byte 一致)

### 2. 同期は明示的コマンドのみ。バックグラウンド・自動双方向同期は非採用

- repo → gist は `publish`、gist → repo は `pull` という明示操作に限定する
- conflict は自動解決せず、diff を提示して人間が選ぶ
- gistpad の不安定さの根源は自動双方向同期であり、この一線は将来も越えない

### 3. repo を隠さない。CLI は門番ではなく糖衣

- `cd` して直接編集・削除・mv しても壊れないことを保証する (pass / chezmoi と同じ思想)
- 整合性は事前防止ではなく `doctor` による事後検出・修復で担保する

### 4. メタデータは frontmatter ではなく repo 内 index (`.gistan/`) に置く

- 非 markdown ファイル (`.tsx` 等) に frontmatter は書けず、markdown でも frontmatter が publish 内容に露出する
- ファイル内容と gist 内容の byte 一致を守るため、gist ID・tags・可視性・同期時点の hash は index に隔離する

### 5. 認証・GitHub API は gh CLI に相乗りする

- token 管理・認証フローを自前実装しない。API 呼び出しは `gh api` 経由

### 6. 他人の gist は read-only mirror として取り込む (star 機能)

- GitHub で star した gist を local に mirror し、検索対象に含める
- 編集・書き戻しは行わない。書き戻しを始めた瞬間に別プロダクト (同期エンジン) になるため
- mirror は repo に commit せず、gitignore された再取得可能な local cache として扱う (他人のコンテンツの恒久保存によるライセンス面の懸念と repo 肥大を避ける)

### 7. 実装は Deno + TypeScript

- 作者の主戦場である TypeScript を、tsconfig / bundler 等の設定ゼロで使える
- `deno compile` による単一バイナリ配布で、Rust 同等の導入容易性 (新マシンにバイナリを置くだけ) を得られる
- 外部 CLI (gh, git, rg, fzf) の糊で CPU bound な処理がないため、runtime 性能は選定理由にしない

## Alternatives Considered

- **gist を SoT とする gist client 自作**: gist の検索・構造の貧弱さと戦い続けることになり、gistpad と同じ泥沼。API rate limit も常に敵になる
- **双方向自動同期**: gistpad の失敗の再現。conflict 解決・部分同期は個人開発で品質を維持できない
- **VSCode 拡張として作る**: エディタ依存こそが解決したい課題なので本末転倒
- **gh gist + shell 関数で済ませる**: 8 割は代替可能だが、753 件の横断検索・冪等な publish・drift 検出 (doctor)・規約の強制力 (new) が賄えない。この差分が自作の存在理由
- **汎用メモツール化 (Obsidian / Evernote 代替)**: Non-Goal。gist という「不完全だが消えないサービス」の最大活用に特化し、ニッチに刺す
- **メタデータを frontmatter に置く**: 非 markdown 非対応・publish 内容への露出のため不採用 (Decision 4)
- **Rust で実装**: 性能優位が活きない glue CLI であり、subprocess 中心のコードは Rust 学習の題材としても本丸 (所有権・並行性) に触れない。初速低下に見合わず不採用
- **Node で実装**: ツールチェーンの儀式が glue CLI には過剰。依存が少なすぎて npm エコシステムの厚みという Node の利点が発動しないため不採用

## Consequences

### 良くなること

- 検索・agent 連携が local ファイルとして最速・最自由 (rg / fzf / Claude 等がそのまま使える)
- 障害モードが「git が動かない」だけに収束し、同期不安定問題が構造的に発生しない
- Obsidian や GitHub web UI という無料 GUI が同じ repo に対して使える
- 新マシンのセットアップが `install → init` で再現可能

### リスク・コスト

- gist の可視性は作成後 API で変更不可 (update エンドポイントに `public` フィールドがない)。可視性変更・再公開は delete + 再作成となり **URL が変わる**。UX 上の警告が必須
- 手動 pull 前提のため remote 編集の取り込み忘れ (drift) が起きうる → doctor / status で検出可能にする
- index とファイル実体の乖離 (直接 mv / rm) が起きうる → doctor が content hash で検出・再リンク
- Deno runtime への依存を受け入れる。`deno compile` のバイナリは数十 MB とリッチだが、個人配布のため実害は薄い

## Migration Notes

- 既存の約 753 gist を `import` で repo へ一括取り込みする (一度きり)
- ~~**import 時に secret スキャン (gitleaks 等) を必須とする**。public gist として書いた当時と「repo に集約して agent に食わせる」今後ではリスク面が変わるため~~
  - **2026-07-08 改訂: gistan は gitleaks への依存を持たない**。repo は plain なファイル/dir であり、scan は `gitleaks dir $(gistan root path)` のように外部から合成できるため、CLI が scanner と結合する必要がない (「CLI は糖衣であり門番ではない」の原則を優先)。また旧実装の scan は import 完了後の advisory 警告にすぎず、必須依存に見合う防御になっていなかった。secret scan は利用者が任意で行う運用とし、README Usage に連携例を記載する

## Open Questions

- gist repo の default 配置・名前 (`~/notes` 相当をどこにするか)
- multi-file gist の first-class サポート範囲 (v1 は import 時の保持のみ)
- index (`.gistan/state.json`) の複数マシン間 merge conflict が実害になった場合の分割 (per-file sidecar 化)

## Progress

- 2026-07-05: 壁打ちを経て初版作成
- 2026-07-05: 実装言語を Rust から Deno + TypeScript に変更 (性能優位が活きず、学習題材としても不適と判断)
- 2026-07-05: 設計レビューの懸念 (v1 スコープ縮小・照合エンジン単一化・star mirror の cache 化) を SPEC-0001 に反映
