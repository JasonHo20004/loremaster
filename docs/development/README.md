# Local development

## Running the API locally

The API requires a PostgreSQL login that is a member of the
`loremaster_runtime` group role. Do not use migration-owner or importer
credentials for the server. Migrations and content publication are separate
operator actions; API startup never applies either one.

Set the following environment variables with local placeholder values replaced
by credentials created for your machine:

```bash
export LOREMASTER_API_MODE=local
export DATABASE_URL='postgresql://<runtime-login>:<runtime-password>@127.0.0.1:5432/<database-name>'
export LOREMASTER_API_ORIGIN='http://localhost:5173'
export LOREMASTER_API_CURSOR_ACTIVE_VERSION='local-v1'
export LOREMASTER_API_CURSOR_ACTIVE_KEY='<base64url-encoded-random-32-byte-key>'
export PORT=3000
```

Generate a local cursor key without printing unrelated environment values:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url') + '\n')"
```

Optional `LOREMASTER_API_TRUSTED_PROXIES` entries must be explicit IP addresses
or CIDRs. Leave it unset when connecting directly. Production additionally
requires HTTPS origin and the fixed `__Host-` cookie names. Configuration
rejects unknown `LOREMASTER_API_*` variables, short cursor keys, unsafe origins,
changed timeout hierarchy, and production-incompatible cookies before opening
the database pool.

From the repository root, use one of these pinned commands:

```bash
pnpm --filter @loremaster/api dev
pnpm --filter @loremaster/api start
pnpm --filter @loremaster/api build
pnpm --filter @loremaster/api test
pnpm test:api:database
```

`dev` rebuilds the API and its workspace dependencies and gracefully restarts it
when their source files change. `start` runs the compiled server. The focused
database command creates a clean PostgreSQL container, provisions a login with
only runtime-role membership, exercises the composed HTTP API, and fails rather
than skipping when Docker is unavailable.

Liveness does not access PostgreSQL. Readiness executes a bounded read-only
transaction after `SET LOCAL ROLE loremaster_runtime`; it never migrates,
publishes content, or returns a raw database error. On `SIGINT` or `SIGTERM`, the
server stops accepting connections, allows in-flight requests up to the drain
deadline, closes remaining HTTP connections, and then closes the pool.

## Running the API and web client locally

After an operator has migrated the database and published a content pack, keep
the API environment above in one terminal and start the API:

```bash
pnpm --filter @loremaster/api dev
```

In a second terminal, start the Vite client:

```bash
export LOREMASTER_API_PROXY_TARGET='http://127.0.0.1:3000'
pnpm --filter @loremaster/web dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the exact loopback target
without changing the browser Origin, so the API's configured origin must remain
`http://localhost:5173`. `LOREMASTER_API_PROXY_TARGET` accepts only an exact
loopback HTTP origin. This is a source-development workflow, not an S8 container
or deployment procedure.

### Exercising the session and gameplay boundary

The following example preserves both cookies in a jar. Values are placeholders;
do not paste real tokens into documentation, commits, issue trackers, or logs.

```bash
API_BASE='http://127.0.0.1:3000'
WEB_ORIGIN='http://localhost:5173'
COOKIE_JAR="$(mktemp)"

curl --fail-with-body --cookie-jar "$COOKIE_JAR" \
  --header "Origin: $WEB_ORIGIN" \
  --header 'Content-Type: application/json' \
  --data '{}' \
  "$API_BASE/api/v1/session"

CSRF_TOKEN="$(awk '$6 == "loremaster_local_csrf" { print $7 }' "$COOKIE_JAR")"

curl --fail-with-body --cookie "$COOKIE_JAR" \
  "$API_BASE/api/v1/cases/current"

curl --fail-with-body --cookie "$COOKIE_JAR" \
  --header "Origin: $WEB_ORIGIN" \
  --header 'Content-Type: application/json' \
  --header "X-CSRF-Token: $CSRF_TOKEN" \
  --header 'Idempotency-Key: <unique-start-key>' \
  --data '{}' \
  "$API_BASE/api/v1/cases/current/attempt"
```

Reuse an idempotency key only for a byte-equivalent logical retry. A changed
payload with the same key is a conflict. Command calls use the same cookie,
Origin, CSRF, content-type, and idempotency headers, with the returned attempt ID
in `/api/v1/attempts/<attempt-id>/commands`.

The in-memory limiter is intentionally bounded and replica-local. Multiple API
replicas therefore permit the sum of their local ceilings. S7 may add a shared
Redis ceiling, but it must retain this local limiter as the availability and
memory-safety fallback when Redis is unavailable.

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

The command surface remains pinned and deterministic. CI runs both repository
database tests and composed API database tests with ephemeral credentials.

The S6 acceptance baseline is 277 non-database tests, 59 repository/database
tests, 7 composed HTTP/PostgreSQL tests, 11 focused Chromium component tests,
4 real-stack browser journeys, and 5 accessibility/responsive browser journeys.
See the [S6 acceptance record](../architecture/s6-acceptance.md) for the exact
claim mapping and the S8 deployed-artifact deferral. A missing Docker daemon,
browser, or PostgreSQL startup is a failure, never a skipped acceptance result.

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

Apps live under `apps/*`; shared libraries live under `packages/*`. Browser code may import browser-safe `@loremaster/contracts` exports and call the frozen `/api/v1` surface. It must not import API/database modules, the operator importer, authored fixtures, answers, explanations, or sources. S7 cache warming may optimize disposable reads but must preserve these browser/API semantics and PostgreSQL-owned gameplay truth.
