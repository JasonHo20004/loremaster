# Local development

The S2 command surface is intentionally small and deterministic. S3 runs the same surface in least-privilege CI. Application frameworks, databases, containers and cloud tooling belong to later delivery stages.

## Pinned prerequisites

- WSL2 with a current Ubuntu distribution
- Git
- Node.js `22.17.0` (also recorded in `.nvmrc` and `.node-version`)
- Corepack, included with the pinned Node release
- pnpm `11.19.0`, selected by the root `packageManager` field

Keep the clone inside the WSL filesystem (for example `~/src/loremaster`) rather than `/mnt/c` to avoid slow file watching and cross-platform permission problems.

## Fresh-clone setup in WSL2

```bash
git clone <repository-url> ~/src/loremaster
cd ~/src/loremaster
nvm install
nvm use
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs formatting, linting, type checking, tests and builds in that order. The individual commands are `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.

## Pull-request verification

The `CI` GitHub Actions workflow runs `pnpm install --frozen-lockfile` and `pnpm verify` for every pull request. It also audits the locked dependency graph and scans Git history for secrets. The workflow has read-only access to repository contents and pull-request metadata and does not receive cloud credentials or deployment secrets. Never replace its `pull_request` trigger with `pull_request_target` while it installs dependencies or executes repository code.

If Corepack was previously configured with a broken global pnpm shim, remove that shim using the installation method that created it, then rerun `corepack enable` and `corepack install`. Do not install an unpinned pnpm version to work around the mismatch.

## Workspace boundaries

Apps live under `apps/*`; shared libraries live under `packages/*`. S2 packages export only scaffold metadata so the command surface can be exercised without prematurely implementing features assigned to S4-S7.
