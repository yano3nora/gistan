# gistan

A Deno + TypeScript CLI for managing a repo-backed gist collection. The local repo is the source of
truth; GitHub Gist is only the explicit publish surface.

## Layout

```text
<gist-repo>/
├ gists/<dirname>/<files...>   # 1 directory = 1 gist
├ stars/<owner>/<gist-id>/     # read-only mirror of starred gists (`gistan star sync`)
├ .gistan/state.json           # index v2
└ .gistan/cache/stars.json     # star mirror cache
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

Prerequisites: `gh` authenticated with gist scope, plus `rg` and `fzf`. Optionally `bat` — when
installed, search/grep previews get syntax highlighting, with query matches emphasized in reverse
video on top of it.

```sh
gistan root init ~/gistan-repo     # scaffold the gist repo
gistan import                      # import existing gists into gists/

gistan new -d "desc" hello.md      # create gists/hello/hello.md with description
gistan new tools/helper.ts         # adds gists/tools/helper.ts
gistan search deno deploy !wip     # document search: space = AND, !term = exclude, rows are path:line: excerpt
gistan hello                       # sugar: unrecognized input falls back to `gistan search hello`
gistan grep 'error\s+handling'     # line-level regex grep when you need the exact matching line
gistan list                        # list gists/

gistan publish hello               # publishes gists/hello as one gist (secret by default)
gistan publish hello --public      # public must be an explicit opt-in
gistan status                      # only conditions that need attention (like `git status`)
gistan status --all                # the full listing, including in-sync/published gists
gistan status --remote             # includes remote drift
gistan pull hello                  # overwrite local dir from remote after confirmation on conflict
gistan status --fix                # interactive fix of drifts

gistan unpublish hello             # delete remote gist, keep local dir
gistan rm hello/hello.md           # delete one file; asks if it is the last file

gistan star sync                   # mirror starred gists into stars/<owner>/<gist-id>/ (idempotent)
gistan star add <gist-url>         # star a gist and mirror it immediately
```

Daily operations above never touch the repo's own git history — they only read/write files and talk
to `gist.github.com` via `gh`. Setup and origin git housekeeping (pushing/pulling the notes repo
itself, not gists) live under `gistan root` instead, since conflating the two was confusing.

```sh
gistan root path                   # print the repo's absolute path, e.g. cd $(gistan root path)
gistan root commit -m "notes"      # git add -A + commit (omit -m for an auto message)
gistan root push                   # git push
gistan root pull                   # git pull --rebase
gistan root status                 # git status (same no-rewrap passthrough as push/pull)
```

### Composing with other tools

The repo is plain files, so any CLI composes through the repo path — gistan bundles no scanners or
other integrations itself. For example, scan for secrets before committing or publishing:

```sh
gitleaks dir $(gistan root path) --no-banner   # secret scan (brew install gitleaks)
rg -l TODO $(gistan root path)/gists           # or anything else that walks files
```

One integration point is built in: set `viewer` in `~/.config/gistan/config.toml` and ctrl-v inside
`gistan search` / `gistan grep` hands the selected file to that command (a markdown reader like
`leaf` or `glow` fits well). Quitting the viewer drops you back into the result list, so
browse → read → browse loops never leave fzf. The command must not contain parentheses (an fzf
`execute()` parsing limitation).

```toml
# ~/.config/gistan/config.toml
repo = "/Users/you/gistan-repo"
viewer = "leaf"
```

## Development

```sh
mise exec -- deno task check
mise exec -- deno task test
mise exec -- deno task compile
```

Important rules:

- GitHub API access goes through `gh api` subprocesses only.
- `status` / `pull` / `publish` drift judgment must share `src/core/reconcile.ts`.
- Do not commit, push, create releases, or publish packages from the agent; humans decide external
  publication.

### Structure

Where to look when touching a feature. The flow is always `src/main.ts` (dispatch) →
`src/commands/*` (one file per subcommand, CLI concerns only) → `src/core/*` (logic shared across
commands, no CLI concerns). Every module has a sibling `*_test.ts`.

```text
src/
├ main.ts                 # entrypoint: dispatch, --help/--version, search sugar fallback,
│                         # removed-command hints, hidden renderer routing
├ commands/
│ ├ types.ts              # CommandContext (stdout/runner/confirm/editor) — every command's interface
│ ├ shared.ts             # config guard, fzf binds (ctrl-o browse / preview / viewer), and
│ │                       # runQueryUi — the whole fzf session search and grep share
│ ├ new.ts / edit.ts / list.ts / rm.ts     # local file operations (fzf pick + $EDITOR)
│ ├ search.ts             # document-unit search: fzf --disabled + self-reload UI
│ ├ search_render.ts      #   hidden `__search-render`: query parse, AND/exclude, excerpt, colors
│ ├ preview_render.ts     #   hidden `__preview`: bat highlight + match emphasis for fzf previews
│ ├ grep.ts               # line-level regex search (rg reload)
│ ├ publish.ts / unpublish.ts / pull.ts / status.ts   # sync surface, all built on core/reconcile
│ ├ import.ts             # bulk import of existing gists
│ ├ star.ts               # star mirror: sync / add
│ ├ root.ts               # repo git helpers: init / path / commit / push / pull / status
│ ├ init.ts               # implementation behind `root init` (repo scaffold + config)
│ └ test_helpers.ts
├ core/
│ ├ reconcile.ts          # THE drift engine — status/pull/publish must all judge through here
│ ├ state.ts              # index v2 (.gistan/state.json) load/save, v1 detection
│ ├ snippets.ts           # gists/ scanning (bare files / nesting), content hash, .description.txt
│ ├ stars.ts              # stars/ mirror writes + .gistan/cache/stars.json
│ ├ gh.ts                 # all GitHub API access, as `gh api` subprocess wrappers
│ ├ config.ts             # ~/.config/gistan/config.toml
│ ├ deps.ts               # external CLI presence checks (gh/git/rg/fzf)
│ ├ clipboard.ts          # cross-platform copy (pbcopy / clip / wl-copy → xclip → xsel)
│ ├ proc.ts               # Runner abstraction over subprocesses (swapped out in tests)
│ └ description.ts        # slugify for import dirnames
└ testing.ts              # in-memory CommandContext for unit tests
scripts/release.ts        # release:prepare / release:publish (publish is human-only)
docs/                     # ADR (decisions) / SPEC (current behavior) / TASK (work logs)
```

### Test dev binary
```sh
mise exec -- deno task compile
./gistan --version
```

## Deployment

gistan ships as a single self-contained binary (`deno compile` embeds the runtime, ~80MB). Nothing
on the target machine needs Deno, but runtime integrations still require external CLIs: `gh`
(authenticated, gist scope), `git`, and `rg` + `fzf` (search/edit/rm picks).

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
