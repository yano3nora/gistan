# AGENTS - Development Guide
## Overview
- gist 向け snippets を集約する markdown repo (= gist repo) の構成・運用を補助する CLI「gistan」。体験の目標は「Zenn の GitHub 連携の gist 版」
- 技術スタック: Deno + TypeScript。外部 CLI (gh / git / rg / fzf / gitleaks) の糊として実装し、配布は `deno compile` 単一バイナリ
- 最重要ドキュメント: `docs/ADR-0001-repo-as-source-of-truth.md` (決定背景) / `docs/SPEC-0001-gistan-cli.md` (仕様の正)
- 参照実装 / 出発点: VSCode 拡張 gistpad (課題の出所)、Zenn GitHub 連携 (体験の参照)、pass / chezmoi (repo を隠さない思想)

### 🎯 Role & Objective
あなたはエキスパートソフトウェアエンジニアとして、この repo の設計・実装・テストを行うこと。

### 🚨 CRITICAL: Architecture
- **repo が Source of Truth、gist は公開面**: 検索・編集・agent 連携は local repo で完結させ、gist へは明示的コマンドでのみ同期する。バックグラウンド・自動双方向同期は将来も実装しない (gistpad の失敗の構造的回避)
- **repo を隠さない**: ユーザーの直接操作 (rm / mv / 編集) で壊れないこと。CLI は糖衣であり門番ではない。整合性は事前防止でなく doctor による事後検出・修復で担保する
- **状態管理**: gistan は config (`~/.config/gistan/`) 以外の状態を repo 外に持たない。メタデータは `.gistan/state.json` (コミット対象)、star mirror と管理情報は再取得可能な cache (gitignore 対象) とする。ファイル内容と gist 内容は byte 一致 (frontmatter 等の埋め込み禁止)
- **失敗モード前提**: gist は作成後の可視性変更が API 非対応 (変更 = 再作成 = URL 変更)。remote は人手で編集・削除されうる (drift 前提)。破壊的操作は必ず警告 + 確認を挟む
- **YAGNI**: Obsidian / Evernote 化しない。TUI・独自エディタ・他人 gist への書き戻し・自動同期の方向へ広げない (SPEC-0001 Non-Goals)

### 📂 Code Organization Constraints
- **`docs/`**: ADR / SPEC / TASK。仕様の正は SPEC-0001
- **`src/`**: scaffold 時に確定 (TASK-260705)。ただし以下は先に確定した制約
    - **照合エンジンの単一化**: status / pull / doctor が使う「index・local・remote の三者照合」は単一モジュールとし、コマンド側は表示・適用のみを変える。drift 判定の分散実装を禁止
    - **GitHub API は `gh api` subprocess 経由のみ**: 自前 HTTP client・token 管理を持ち込まない

### 🛠️ Workflow & Development Rules
- **Secrets**: 企業名・製品名・機密情報などがあった場合、コード上に残らないように汎用・一般名称に差し替えること。
- **Commit**: `git commit` は基本的には人間判断で行うため、指示されたとき以外はコミットせず人間に判断を委ねること。
- **Push / Publish**: `github push` や `npm publish` など、外部へ公開・配布する操作は Agent が実行しない。人間が判断して実行する。
- **Testing**: タスク完了前に実行する検証を書く
    - linter / formatter: Deno 標準 (`deno fmt` / `deno lint`) を使う。設定は scaffold 時に確定 (TASK-260705)
    - unit test: `deno test`。照合エンジンと index 読み書きを最優先でテストする
    - TODO: integration / e2e 方針 (実 gist を使う検証の扱い)
    - TODO: bugfix 時の再現テスト方針
- **Documentation**:
    - 技術的な意思決定や検討は `docs/ADR-XXXX-*.md` に記録し、大きな変更の前には既存 ADR を確認する
    - 設計・仕様の検討・決定事項は `docs/SPEC-XXXX-*.md` に記録する
    - 原則、全開発タスクが適切な粒度で `docs/TASK-YYMMDD-*.md` に残るようにする
    - 画像などは `docs/assets/` へ配置してリンクする
- **Versioning / Release**: TODO

## Domains

用語の定義は SPEC-0001 Terms を正とする。

- `gist repo`
    - snippets を集約する git repo。Source of Truth。普通のディレクトリとして直接操作してよい
- `snippet`
    - gist repo 内の 1 ファイル (markdown に限らない)。gist ID と紐付いたものが published snippet
- `index`
    - `.gistan/state.json`。gist ID・tags・可視性・同期時点の hash 等のメタデータ。ファイルへは埋め込まない
- `drift`
    - 最終同期時点と比べて local または remote が変更されている状態。status / doctor が検出する
- `star mirror`
    - `stars/` 配下に取り込んだ他人の gist の read-only コピー。gitignore 対象の cache
