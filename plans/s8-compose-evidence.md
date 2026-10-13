# S8.6-S8.7 local Compose evidence

Date: 2026-10-12. Host: Windows with Docker Engine 28.5.1 and Compose
v2.40.0. The `loremaster/*:s8` images were already assembled and are recorded
by digest in [S8 image evidence](s8-images-evidence.md). This record covers
local composition, not hosted CI or independent review.

## Focused results

| Gate                                                                              | Result                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm test:s8:data-services`                                                      | PASS on a unique disposable project from empty volumes, including a second bootstrap. |
| `pnpm test:s8:compose`                                                            | PASS on a second unique disposable project, including the browser gateway.            |
| `node scripts/s8-images-test.mjs all`                                             | PASS for all six image behavior journeys.                                             |
| `node scripts/s8-artifacts.mjs`                                                   | PASS: public disclosure scan and zero unapproved HIGH/CRITICAL image findings.        |
| `node scripts/database-test.mjs`                                                  | PASS: 6 files, 93 tests.                                                              |
| `node scripts/redis-test.mjs`                                                     | PASS: 1 file, 8 tests.                                                                |
| `node scripts/redis-test.mjs composed`                                            | PASS: 1 file, 9 tests; namespace admission measurement 28,772,912 bytes.              |
| `docker compose -f deploy/compose/compose.yaml --profile operator config --quiet` | PASS.                                                                                 |
| Format, lint, typecheck, unit tests, build, and `git diff --check`                | PASS; unit suite 47 files and 404 tests.                                              |

The data gate applied migrations with the one-shot operator image, provisioned
separate PostgreSQL API, producer, worker, and importer logins, denied runtime
DDL and importer-role elevation, rejected a wrong network password, checked
all six Redis identities for `FLUSHALL` denial, and rejected a wrong Redis
password. It verified Redis `noeviction` at 128 MiB, AOF retention and
PostgreSQL retention after service restarts. The importer profile copied a
pack into a UID 10006, mode `0400` volume and returned a structured rejection
for an intentionally invalid pack. The normal startup had no operator job.

The Compose gate inspected read-only roots, dropped capabilities, no-new-
privileges, CPU/memory/PID/file-descriptor limits, rotating logs, read-only
credential mounts, exact edge addresses, private backend membership, and
loopback-only web publication. API, worker, observer, PostgreSQL, Redis, and
web became healthy. A worker-image probe authenticated over the backend
network. HTTP `/`, `/health/ready`, and the proxied `/api/v1/` path returned
the expected smoke results. The harness activated both operator and bootstrap
profiles during teardown and verified that no volume with its project label
remained. Earlier disposable volumes exposed this profile-specific cleanup
gap; those exact test projects were removed after the harness was fixed.

## Secret mount decision

File-backed Compose secrets appeared as root-owned `0555` on Docker Desktop,
which the accepted parser rejects. The networkless credential job consumes
those Compose secrets and writes one volume per service with exact `0400`
files owned by the service UID. The live migration, PostgreSQL, Redis, API,
worker, and observer mounts were inspected. No secret value appears in the
resolved Compose environment or command arguments. Developer `stop` retains
the credential and data volumes; only disposable test cleanup uses `down
--volumes` for an exactly named project.

The host `pnpm` shim lacked its pinned binary. Corepack restored pnpm 11.19.0,
and the lockfile installation restored the missing host packages. The named
S8.6 and S8.7 commands then passed under Node 22.23.3 and pnpm 11.19.0.
The five `verify` stages ran individually with those pinned versions because
the host `pnpm` shim still does not resolve inside nested scripts. The combined
image behavior, artifact, database, Redis, and composed namespace gates also
passed. Hosted CI and independent review remain pending.
