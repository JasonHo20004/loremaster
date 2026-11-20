# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## Project

Loremaster Daily Case: a daily deduction game with original fiction (one `WHO` case per UTC day, briefing plus four evidence levels, guest play, streaks, regional knowledge, daily leaderboard). It doubles as a portfolio for reliable delivery and operations, built in numbered stages S1–S12. S1–S9 are accepted (through local kind/Helm/Argo CD GitOps). S10 observability is in progress ([plan](plans/s10-observability.md)): API metrics, structured logs, the kind monitoring stack, SLO alerts and runbooks exist; backup/restore ([ADR 0006](docs/adr/0006-backup-and-restore.md), proposed), the TLS edge, load tests and drills do not. S11 cloud bootstrap and S12 AWS lab are **not implemented**; do not treat future runtime or infrastructure as existing.

Authoritative sources, in priority order: accepted ADRs (`docs/adr/`), [game rules](docs/architecture/game-rules.md), [architecture](docs/architecture/README.md), the frozen [S5 API contract](docs/architecture/s5-api-contract.md). `docs/DailyRuneterraCase_Description.md` is historical inspiration only, not a spec. Stage plans live in `plans/`; acceptance evidence in `docs/architecture/s*-acceptance.md`.

## Toolchain

Pinned exactly: Node `22.23.3`, pnpm `11.19.0` via Corepack (`engine-strict`, `save-exact`, `strict-peer-dependencies`). Install with `pnpm install --frozen-lockfile`. Never install an unpinned pnpm. Dependency versions are exact; `pnpm-workspace.yaml` holds overrides and disables the `msgpackr-extract` build script on purpose.

## Commands

```bash
pnpm run verify          # format:check → lint → typecheck → test → build (use `run`: pnpm 11 has a built-in `verify`)
pnpm format              # prettier --write
pnpm lint                # eslint, --max-warnings 0
pnpm typecheck           # recursive; per-package pretypecheck builds workspace deps first
pnpm test                # root vitest, excludes Docker-backed suites
pnpm build

# Single test file / pattern (root vitest config includes tests/**/*.test.ts)
pnpm exec vitest run tests/domain/attempt-engine.test.ts
pnpm exec vitest run tests/api -t "<test name>"

# Docker-required suites (fail, never skip, when Docker is missing)
pnpm test:database       # disposable PostgreSQL, all migrations, constraint suite
pnpm test:api:database   # composed HTTP API against PostgreSQL
pnpm test:redis          # Redis ACLs, cache, queue, limiter (alias test:s7:redis)
pnpm test:s7:integration # composed PostgreSQL+Redis+API+worker+observer

# Web
pnpm --filter @loremaster/web dev             # Vite on localhost:5173, proxies /api
pnpm --filter @loremaster/web test:component  # vitest browser mode (Chromium), src/**/*.browser.test.tsx
pnpm --filter @loremaster/web test:e2e        # Playwright a11y/responsive (needs `pnpm exec playwright install chromium`)

# API / worker
pnpm --filter @loremaster/api dev   # rebuilds deps, restarts on change; needs env from docs/development/README.md
pnpm --filter @loremaster/worker start
pnpm content:import                 # operator-only content pack import (docs/development/content-import.md)

# Stage gates: test:s7:*, test:s8:*, test:images, test:s9, test:s10, test:s10:rules, `pnpm s9 <tools|cluster|promote|sync|status|...>`, `pnpm s10 <render|install|status|forward|uninstall>`
```

Tests under `tests/` import package source directly (`../../packages/domain/src/index.js`), but apps consume workspace packages through their built `dist/`. If an app test or typecheck fails on a missing module, build the dependency (`pnpm --filter <pkg> build`) or rely on the package's `pre*` scripts.

CI (`.github/workflows/`) runs `verify` plus the S7/S8/S9 contract, database, Redis, browser and image gates. It uses `pull_request` with read-only permissions; never switch to `pull_request_target`.

## Architecture

pnpm monorepo, ESM TypeScript (`NodeNext`, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Imports use `.js` extensions.

Flow: Browser → React/Vite `apps/web` → Express `apps/api` → PostgreSQL. API → Redis/BullMQ → `apps/worker` (daily cache warming only). `apps/queue-observer` exposes Prometheus queue metrics.

| Path                     | Role                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`        | Pure game rules: attempt state machine, scoring, aggregates, leaderboard. No I/O.                                                                                |
| `packages/contracts`     | Browser-safe zod HTTP contracts for `/api/v1`. Only package the web may import.                                                                                  |
| `packages/database`      | SQL migrations, repositories (gameplay, identity), content-pack schema/validation/import CLI. Subpath exports: `/content`, `/gameplay`, `/identity`, `/runtime`. |
| `packages/cache`         | Server-only Redis suggestion cache, limiter ports, connection profiles. Depends on no app, database, queue or browser contract.                                  |
| `packages/queue`         | Server-only versioned BullMQ job contracts, producer, worker, Lua script guard (`policy/bullmq-script-inventory.json`).                                          |
| `packages/config`        | Validated env parsing, file-backed secrets, Redis config. Rejects unknown `LOREMASTER_API_*` vars.                                                               |
| `packages/observability` | Redacted logs/metrics, health probes.                                                                                                                            |
| `deploy/`                | Dockerfiles (`deploy/images`), Compose stack, Helm chart.                                                                                                        |
| `platform/`              | kind cluster, Argo CD project/application.                                                                                                                       |
| `ops/`, `infra/`         | Redis ACL contract, build contexts, cost admission; AWS (not yet admitted).                                                                                      |

### Invariants that must hold

- **PostgreSQL is the only source of truth** for revisions, attempts, guesses, sessions, score, streaks, knowledge and leaderboard. Redis holds disposable caches and queue state; losing it must lose no game result. No gameplay write waits on a background job.
- **Mutations are synchronous transactions**: authenticate, validate, resolve idempotency key, lock attempt, check expected version, sample DB time after the lock, apply domain transition, commit. Same idempotency key + different payload is a conflict.
- **Disclosure**: ACTIVE attempts never expose answer ID, future evidence or explanations (including nested metadata). Terminal states unseal. Logs and traces never contain answers or narrative, even after unsealing.
- **Browser boundary**: `apps/web` may import only `@loremaster/contracts`. Never import API, database, cache, queue, fixtures, answers or explanations into the web. `contracts` must not import or re-export cache/queue. `tests/architecture` and `scripts/web-disclosure.mjs` enforce this.
- **Published content revisions are immutable**; corrections are new revisions for future slots. Daily slots are UTC days and must not overlap (DB constraint).
- **Migrations** in `packages/database/migrations` are immutable and forward-only once deployed; `.down.sql` is for disposable local DBs. Separate roles: migration owner, `loremaster_importer`, `loremaster_runtime`, cache producer/worker. The API runtime login must have only `loremaster_runtime`; API startup never migrates or imports.
- Expiry is lazy (finalized on read in a transaction); no job opens or closes a case.

Changes touching IP, identity, integrity, cloud admission/cleanup or migration/recovery need a new numbered ADR plus adversarial review. Never edit an accepted ADR's substance; supersede it.

## Conventions

- Prettier: no semicolons, single quotes, trailing commas. LF, 2-space indent.
- ESLint: `consistent-type-imports` and `no-explicit-any` are errors.
- Commits: conventional style with stage scope, e.g. `fix(s9): ...`, `docs(s8): ...`, `feat(s9): ...`.
- Container images, actions and tools are pinned by digest/hash; keep new ones pinned.
- Do not commit real secrets or tokens; local secrets are file-backed (see `docs/development/s8-container-contract.md`).
