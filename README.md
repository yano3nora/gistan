# gistan

A Deno + TypeScript CLI for managing a repo-backed gist collection. The local repo is the source of
truth; GitHub Gist is only the explicit publish surface.

## Layout

```text
<gist-repo>/
├ gists/<dirname>/<files...>   # 1 directory = 1 gist
├ stars/                       # read-only cache
└ .gistan/state.json           # index v2
```

`gists/<dirname>/.description.txt` is reserved metadata. Its trimmed content becomes the gist
description, but it is **never uploaded as a gist file**. Multi-line descriptions are sent as-is;
GitHub UI rendering is your responsibility. A remote gist containing a real `.description.txt` file
is skipped on import.

## Getting Started

### Install with mise

```sh
# Latest release.
mise use -g github:yano3nora/gistan

# Pinned release.
mise use -g github:yano3nora/gistan@0.1.0

gistan --version
```

Release assets use conventional OS/arch names so mise can auto-detect the right one:

```text
gistan-v0.1.0-linux-x64.tar.gz
gistan-v0.1.0-linux-arm64.tar.gz
gistan-v0.1.0-macos-x64.tar.gz
gistan-v0.1.0-macos-arm64.tar.gz
gistan-v0.1.0-windows-x64.zip
```

The archive contains `gistan` at the archive root (`gistan.exe` for Windows). If you want the
shorter `mise use -g gistan` form, `gistan` must also be registered in the upstream mise registry or
defined as a local tool alias.

## Usage

Prerequisites: `gh` authenticated with gist scope, plus `rg`, `fzf`, and `gitleaks`.

```sh
gistan root init ~/gistan-repo     # scaffold the gist repo
gistan import                      # import existing gists + gitleaks scan

gistan new -d "desc" hello.md      # create gists/hello.md with description
gistan new tools/helper.ts         # adds gists/tools/helper.ts
gistan search hello                # fuzzy pick by `hello`
gistan list                        # list gists/

gistan publish hello               # publishes gists/hello as one gist (secret by default)
gistan publish hello --public      # public must be an explicit opt-in
gistan status                      # check local drift
gistan status --remote             # includes remote drift
gistan pull hello                  # overwrite local dir from remote after confirmation on conflict
gistan status --fix                # interactive fix of drifts

gistan unpublish hello             # delete remote gist, keep local dir
gistan rm hello/hello.md           # delete one file; asks if it is the last file
```

Daily operations above never touch the repo's own git history — they only read/write files and talk
to `gist.github.com` via `gh`. Setup and origin git housekeeping (pushing/pulling the notes repo
itself, not gists) live under `gistan root` instead, since conflating the two was confusing
(`gistan sync` is gone):

```sh
gistan root path                   # print the repo's absolute path, e.g. cd $(gistan root path)
gistan root commit -m "notes"      # git add -A + commit (omit -m for an auto message)
gistan root push                   # git push
gistan root pull                   # git pull --rebase
```

## Development

```sh
deno task check
deno task test
deno task compile
```

Important rules:

- GitHub API access goes through `gh api` subprocesses only.
- `status` / `pull` / `publish` drift judgment must share `src/core/reconcile.ts`.
- Do not commit, push, create releases, or publish packages from the agent; humans decide external
  publication.

## Deployment

gistan ships as a single self-contained binary (`deno compile` embeds the runtime, ~80MB). Nothing
on the target machine needs Deno, but runtime integrations still require external CLIs: `gh`
(authenticated, gist scope), `git`, `rg` + `fzf` (search/edit/rm picks), and `gitleaks` (import
only).

```sh
# 1. Bump VERSION, run check/test, and build all release assets.
mise run release:prepare -- 0.1.0

# 2. Review the diff, then commit the version bump yourself.
# git diff
# git add src/main.ts
# git commit -m "Release v0.1.0"

# 3. Human-only publishing step. This tags, pushes the tag, and creates the GitHub Release.
mise run release:publish -- 0.1.0 --i-understand-this-pushes-and-publishes
```

`release:publish` refuses to run unless the working tree is clean, so the tag points at a committed
version bump instead of an uncommitted local edit.

New machine checklist: clone this repo → `mise install` → build & copy the binary → clone your notes
repo yourself → `gistan root init <notes-repo-dir>`.
