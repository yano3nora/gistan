# TASK-260708 - manual GitHub Release distribution for mise

## Goal

Make the `deno compile` binary installable via mise, while keeping release publishing manual until
the release shape feels stable.

## Decision

Use mise's GitHub backend. A human publishes platform-specific GitHub Release assets:

```sh
mise use -g github:yano3nora/gistan
mise use -g github:yano3nora/gistan@0.1.0
```

This keeps distribution aligned with the current architecture: a single compiled binary, while
runtime integrations (`gh`, `git`, `rg`, `fzf`, `gitleaks`) remain external tools.

Do not add tag-triggered release automation yet. The project should first learn whether the asset
naming, platform matrix, binary size, and installation UX are good enough.

## Why not an asdf/mise plugin or workflow first?

An asdf-style plugin is unnecessary until `gistan` needs custom installation logic. GitHub Releases
with conventional OS/arch asset names are enough for mise's GitHub backend to auto-detect the right
asset.

A tag-triggered GitHub Actions release workflow is also premature. It would make bad release shape
easy to repeat. A local helper script is acceptable because a human still reviews the diff and
chooses when to push/publish.

Do not make a true one-command `bump -> tag -> push -> gh release` flow unless the script also owns
committing the version bump. Tagging an uncommitted version bump would publish a release whose tag
points at the previous version. For now, use one script with two explicit phases:

- `release:prepare`: bump, check, test, build assets.
- `release:publish`: tag, push tag, create GitHub Release.

## Manual release steps

1. Prepare the release:

   ```sh
   mise run release:prepare -- 0.1.0
   ```

   This bumps `VERSION`, runs `deno task check`, runs `deno task test`, builds release assets under
   `dist/gistan-v0.1.0/`, and writes `.sha256` files.

2. Review and commit the version bump yourself:

   ```sh
   git diff
   git add src/main.ts
   git commit -m "Release v0.1.0"
   ```

3. Publish only after the commit is correct:

   ```sh
   mise run release:publish -- 0.1.0 --i-understand-this-pushes-and-publishes
   ```

   This tags `v0.1.0`, pushes the tag, and creates the GitHub Release with the prepared assets.

Agents must not run `release:publish` or any equivalent push/publish command.

## Asset naming for mise

Target binaries:

- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `x86_64-pc-windows-msvc`

Expected assets:

- `gistan-v<version>-linux-x64.tar.gz`
- `gistan-v<version>-linux-arm64.tar.gz`
- `gistan-v<version>-macos-x64.tar.gz`
- `gistan-v<version>-macos-arm64.tar.gz`
- `gistan-v<version>-windows-x64.zip`

The archive should contain `gistan` at the root (`gistan.exe` for Windows). Keep `.sha256` files
next to each release asset.

The local helper script lives at `scripts/release.ts`. It intentionally refuses to publish unless
the working tree is clean, preventing a tag from pointing at a commit that does not contain the
version bump.

## mise use validation

After release publication:

```sh
mise use -g github:yano3nora/gistan@0.1.0
gistan --version
```

If mise cannot detect the asset, first fix asset names before adding custom options. If custom
options become necessary, document them in README instead of hiding them in a release script.

## Remaining work

- Upstream mise registry registration if the project needs `mise use -g gistan` instead of
  `mise use -g github:yano3nora/gistan`.
- Release automation after several manual releases prove the shape.
- Optional GitHub Artifact Attestations / provenance hardening.
