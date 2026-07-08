gistan
===

A Deno + TypeScript CLI for managing a repo-backed gist collection. The local repo is the source of truth; GitHub Gist is only the explicit publish surface.

## Layout

```text
<gist-repo>/
├ gists/<dirname>/<files...>   # 1 directory = 1 gist
├ stars/                       # read-only cache
└ .gistan/state.json           # index v2
```

`gists/<dirname>/.description.txt` is reserved metadata. Its trimmed content becomes the gist description, but it is **never uploaded as a gist file**. Multi-line descriptions are sent as-is; GitHub UI rendering is your responsibility. A remote gist containing a real `.description.txt` file is skipped on import.

## Usage

Prerequisites: `gh` authenticated with gist scope, plus `rg`, `fzf`, and `gitleaks`.

```sh
gistan root init ~/gistan-repo     # scaffold the gist repo (was: gistan init)

gistan import                      # import existing gists + gitleaks scan
gistan new -d "demo description" hello.md
gistan new tools/helper.ts         # adds gists/tools/helper.ts
gistan search hello
gistan list

gistan publish hello               # publishes gists/hello as one gist (secret by default)
gistan publish hello --public      # public must be an explicit opt-in
gistan status                      # offline local view
gistan status --remote             # includes remote drift
gistan pull hello                  # overwrite local dir from remote after confirmation on conflict
gistan status --fix                # old doctor-equivalent repair flow

gistan unpublish hello             # delete remote gist, keep local dir
gistan rm hello/hello.md           # delete one file; asks if it is the last file
```

Daily operations above never touch the repo's own git history — they only read/write files and talk to `gist.github.com` via `gh`. Setup and origin git housekeeping (pushing/pulling the notes repo itself, not gists) live under `gistan root` instead, since conflating the two was confusing (`gistan sync` is gone):

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
- Do not commit, push, create releases, or publish packages from the agent; humans decide external publication.
