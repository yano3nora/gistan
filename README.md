# gistan

A Deno + TypeScript CLI for managing a repo-backed gist collection. The local repo is the source of
truth; GitHub Gist is only the explicit publish surface.

## Layout

```text
<gist-repo>/
├ gists/<gist-id>/<files...>   # 1 directory = 1 gist; the dirname IS the gist id
├ gists/<local-id>/<files...>  # not published yet (`_`-prefixed id assigned by `gistan new`)
├ stars/<owner>/<gist-id>/     # read-only mirror of starred gists (`gistan star sync`)
├ .gistan/state.json           # index v3
└ .gistan/cache/stars.json     # star mirror cache
```

**1 directory = 1 gist, and dirnames are tool-managed ids** (ADR-0003). GitHub Gist has no title
concept and no way to reflect a directory name, so gistan does not ask you to name or categorize
directories at all — search and list show a flat filename view (ids hidden), descriptions ride along
as search targets and annotations, and ctrl-y in `gistan search` copies the id/URL whenever a
command needs one. Descriptions live in the index (`new -d` / `publish -d`, pulled back on
`gistan pull`), never as files, so local files and the remote gist match byte-for-byte with no
reserved filenames.

## Getting Started

### Install with mise

```sh
# e.g. use globally.
mise use -g github:yano3nora/gistan@0

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
gistan import                      # import existing gists into gists/<gist-id>/

gistan new hello.md                # create gists/<local-id>/hello.md (id printed, editor opens)
gistan new -d "desc" hello.md      # same, with a description (stored in the index)
gistan new note.md --id <id>       # add a file to an existing gist dir
gistan new hello.md --publish      # create, edit, then publish in one go (secret by default)

gistan search deno deploy !wip     # document search: space = AND, !term = exclude; descriptions match too 
                                   # ctrl-y copies the selected item's id/URL, ctrl-o opens the gist

gistan hello                       # sugar: unrecognized input falls back to `gistan search hello`
gistan grep 'error\s+handling'     # line-level regex grep when you need the exact matching line
gistan list                        # flat filename view with descriptions and ids/URLs

gistan push                        # list every locally drifted gist, one confirm, update them all
gistan pull                        # the same for remote drift (conflicts go to status --fix)
gistan status                      # only conditions that need attention (like `git status`)
gistan status --all                # the full listing, including in-sync/published gists
gistan status --remote             # includes remote drift
gistan status --fix                # interactive repair: conflicts, deleted remotes, missing dirs

gistan publish <id|url>            # per-gist maintenance: publish/update one gist (secret by default)
gistan publish <id|url> --public   # public must be an explicit opt-in
gistan publish <id|url> -d "desc"  # update the description
gistan unpublish <id|url>          # delete remote gist; local files move to a fresh local id
gistan rm hello.md                 # delete one file (fzf pick); asks if it is the last file

gistan star sync                   # mirror starred gists into stars/<owner>/<gist-id>/ (idempotent)
gistan star add <gist-url>         # star a gist and mirror it immediately
```

The everyday loop is `new` → edit → `push` / `pull`. Individual `publish` / `unpublish` are
id-addressed maintenance commands — grab the id with ctrl-y from `gistan search` first.

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
`leaf` or `glow` fits well). Quitting the viewer drops you back into the result list, so browse →
read → browse loops never leave fzf. The command must not contain parentheses (an fzf `execute()`
parsing limitation).

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
- `status` / `push` / `pull` / `publish` drift judgment must share `src/core/reconcile.ts`.
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
│ ├ shared.ts             # config guard, the 3-field fzf row protocol (real\tline\tdisplay),
│ │                       # binds (ctrl-o open / ctrl-y copy / ctrl-v viewer), and runQueryUi —
│ │                       # the whole fzf session search and grep share
│ ├ new.ts / edit.ts / list.ts / rm.ts     # local file operations (fzf pick + $EDITOR)
│ ├ search.ts             # document-unit search: fzf --disabled + self-reload UI
│ ├ search_render.ts      #   hidden `__search-render`: query parse, AND/exclude, excerpt, colors
│ ├ grep_render.ts        #   hidden `__grep-render`: line-level rg rendering with id-less display
│ ├ preview_render.ts     #   hidden `__preview`: bat highlight + match emphasis for fzf previews
│ ├ actions.ts            #   hidden `__open` / `__copy` / `__list`: id/URL resolution behind binds
│ ├ grep.ts               # line-level regex search (self-reload like search)
│ ├ publish.ts / unpublish.ts    # per-gist maintenance, id/URL-addressed
│ ├ push.ts / pull.ts / status.ts  # bulk sync surface, all built on core/reconcile
│ ├ import.ts             # bulk import of existing gists into gists/<gist-id>/
│ ├ star.ts               # star mirror: sync / add
│ ├ root.ts               # repo git helpers: init / path / commit / push / pull / status
│ ├ init.ts               # implementation behind `root init` (repo scaffold + config)
│ └ test_helpers.ts
├ core/
│ ├ reconcile.ts          # THE drift engine — status/push/pull/publish must all judge through here
│ ├ state.ts              # index v3 (.gistan/state.json) load/save, v1/v2 detection
│ ├ ids.ts                # local id generation + id/URL target normalization
│ ├ display.ts            # id-hiding display paths + description lookup for search/list
│ ├ sync.ts               # publish/pull building blocks (diff payload, apply-remote)
│ ├ snippets.ts           # gists/ scanning (bare files / nesting), content hashes
│ ├ stars.ts              # stars/ mirror writes + .gistan/cache/stars.json
│ ├ gh.ts                 # all GitHub API access, as `gh api` subprocess wrappers
│ ├ config.ts             # ~/.config/gistan/config.toml
│ ├ deps.ts               # external CLI presence checks (gh/git/rg/fzf)
│ ├ clipboard.ts          # cross-platform copy (pbcopy / clip / wl-copy → xclip → xsel)
│ └ proc.ts               # Runner abstraction over subprocesses (swapped out in tests)
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

Compile / archive / checksum / GitHub Release creation are delegated to
[goreleaser](https://goreleaser.com/) (`.goreleaser.yaml`). `scripts/release.ts` stays as a thin
wrapper for what goreleaser cannot own: the VERSION bump, check/test, tag↔VERSION consistency
checks, and the human-only publish gate.

```sh
# 1. Bump VERSION, run check/test, then dry-run the whole goreleaser pipeline
#    (compile/archive/checksum for all targets, no tag needed, nothing published).
mise run release:prepare -- 0.1.0

# 2. Review the diff, then commit the version bump and tag it yourself.
# git diff
# git add src/main.ts
# git commit -m "Release v0.1.0"
# git tag v0.1.0

# 3. Human-only publishing step. This pushes the commit + tag, then goreleaser
#    rebuilds from the tagged commit and creates the GitHub Release
#    (release notes are GitHub-generated, token is reused from `gh auth token`).
mise run release:publish -- 0.1.0 --i-understand-this-pushes-and-publishes
```

`release:publish` refuses to run unless the working tree is clean, the tag exists, the tag points at
HEAD, and the tag matches `VERSION` in `src/main.ts` — so the published binaries are always built
from the exact commit the tag points at.

New machine checklist: clone this repo → `mise install` → build & copy the binary → clone your notes
repo yourself → `gistan root init <notes-repo-dir>`.
