# Local development

## PostgreSQL integration tests

Run `pnpm test:database` with Docker running. The command uses the immutable
`postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`
image, creates a disposable database with ephemeral local credentials, applies
every migration, runs the database constraint suite, and removes the container.
It fails clearly if Docker or PostgreSQL startup is unavailable; it never skips.

The container superuser is the migration identity. Migrations create separate
`loremaster_importer` and `loremaster_runtime` group roles. Only migration
credentials own schema objects or may perform DDL. Production login roles and
their secrets are provisioned outside migrations and granted exactly one group
role.

Migration files are immutable and forward-managed after deployment. The paired
down migration is for disposable local databases only; production corrections
must be new forward migrations, and published revisions are never edited or
rolled back in place.

Operator-only validation and publication are documented in the
[content import guide](content-import.md).

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
pnpm run verify
```

`pnpm run verify` runs formatting, linting, type checking, tests and builds in that order. Use the explicit `run` because pnpm 11 also provides an unrelated built-in `verify` command. The individual commands are `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.

## Pull-request verification

The `CI` GitHub Actions workflow runs `pnpm install --frozen-lockfile` and `pnpm run verify` for every pull request. It also audits the locked dependency graph and scans Git history for secrets. The workflow has read-only access to repository contents and pull-request metadata and does not receive cloud credentials or deployment secrets. Never replace its `pull_request` trigger with `pull_request_target` while it installs dependencies or executes repository code.

If Corepack was previously configured with a broken global pnpm shim, remove that shim using the installation method that created it, then rerun `corepack enable` and `corepack install`. Do not install an unpinned pnpm version to work around the mismatch.

## Workspace boundaries

Apps live under `apps/*`; shared libraries live under `packages/*`. S2 packages export only scaffold metadata so the command surface can be exercised without prematurely implementing features assigned to S4-S7.
