# AGENTS - Development Guide

## Overview

- gist を集約する repo (= gist repo) の構成・運用を補助する CLI「gistan」。体験の目標は「Zenn の GitHub 連携の gist 版」
- 技術スタック: Deno + TypeScript。外部 CLI (gh / git / rg / fzf) の糊として実装し、配布は `deno compile` 単一バイナリ
- 最重要ドキュメント: `docs/ADR-0001-repo-as-source-of-truth.md` / `docs/ADR-0002-one-directory-one-gist.md` / `docs/SPEC-0001-gistan-cli.md`

## Role & Objective

あなたはエキスパートソフトウェアエンジニアとして、この repo の設計・実装・テストを行うこと。

## Critical Architecture

- **repo が Source of Truth、gist は公開面**: 検索・編集・agent 連携は local repo で完結させ、gist へは明示的コマンドでのみ同期する。バックグラウンド・自動双方向同期は将来も実装しない
- **1 directory = 1 gist**: `gists/<dirname>/` が 1 gist。single-file / multi-file を分けない。`gists/` 直下の裸ファイルや depth 2+ のネストは管理対象外 / publish 不可
- **repo を隠さない**: ユーザーの直接操作 (rm / mv / 編集) で壊れないこと。CLI は糖衣であり門番ではない。整合性は `status --fix` による事後検出・修復で担保する
- **状態管理**: gistan は config (`~/.config/gistan/`) 以外の状態を repo 外に持たない。メタデータは `.gistan/state.json` (コミット対象)。star mirror は再取得可能な cache (gitignore 対象)
- **byte 一致の例外**: gist file と remote gist file は byte 一致する。ただし `gists/<dirname>/.description.txt` は description 専用予約ファイルで、publish files には絶対に含めない
- **tags 廃止**: index v2 に tags は存在しない。description の `[tag]` parse も行わない
- **GitHub API は `gh api` subprocess 経由のみ**: 自前 HTTP client・token 管理を持ち込まない
- **照合エンジンの単一化**: status / pull / publish が使う「index・local・remote の三者照合」は単一モジュールとし、drift 判定の分散実装を禁止
- **失敗モード前提**: gist は作成後の可視性変更が API 非対応 (変更 = 再作成 = URL 変更)。remote は人手で編集・削除されうる。破壊的操作は必ず警告 + 確認を挟む
- **YAGNI**: Obsidian / Evernote 化しない。TUI・独自エディタ・他人 gist への書き戻し・自動同期の方向へ広げない

## Workflow & Development Rules

- **Secrets**: 企業名・製品名・機密情報などがあった場合、コード上に残らないように汎用・一般名称に差し替えること
- **Commit**: `git commit` は人間判断。指示されたとき以外はコミットしない
- **Push / Publish**: `git push`、GitHub Release、`npm publish` など外部公開は Agent が実行しない
- **Testing**: 完了前に `deno fmt` / `deno lint` / `deno test` または `deno task check` / `deno task test` を実行する
- **Documentation**: 技術的意思決定は ADR、仕様は SPEC、作業単位は TASK に残す

## Domains

用語の定義は SPEC-0001 Terms を正とする。

- `gist repo`: gists を集約する git repo。Source of Truth。普通のディレクトリとして直接操作してよい
- `gist dir`: `gists/<dirname>/`。1 directory = 1 gist
- `gist file`: gist dir 直下の通常ファイル
- `index`: `.gistan/state.json`。published gist の id・可視性・同期時点の hash 等を保持する
- `drift`: 最終同期時点と比べて local または remote が変更されている状態。`status` / `status --fix` が検出する
- `star mirror`: `stars/` 配下に取り込んだ他人の gist の read-only cache
