# S7.0 delivery preflight

Recorded 2026-09-29. The accepted S6 base is
`1ea44e7fdf2032ab65be05958d0cce43d08135fa`, the merge of PR #7 (`web-ui`)
to `main`. Its [hosted CI run](https://github.com/JasonHo20004/loremaster/actions/runs/35955071257)
completed successfully. Source branch head was
`8cbda10076894b8c3fc3901c5a7d6cd290c7c4a6`.

The local `main` reference was stale. Fetching remote refs and merging the
accepted base into `codex/s7-completion` produced
`05915507a5c30e0e4c07a65751f4855ab734bbb8`. The S8 plan commit is also
preserved. The existing S8 preflight documentation changes remain separate
from S7 implementation and are not evidence that S8 has been admitted.

## Baseline commands and results

All checks below ran before changing runtime dependencies, with Node 22.17.0
and pnpm 11.19.0. The existing Corepack shim directory was prepended to PATH
for this shell only to avoid a stale global pnpm shim. No global installation
was replaced. Docker Desktop was started; Engine 29.1.2 is available.

| Gate                                           | Result                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`               | PASS; lockfile current                                                         |
| `pnpm run verify`                              | PASS: formatting, lint, typechecks, 277 tests, builds                          |
| `pnpm test:database`                           | PASS: 59 tests in 5 files, disposable PostgreSQL                               |
| `pnpm test:api:database`                       | PASS: 7 tests in 2 files                                                       |
| `pnpm --filter @loremaster/web test:component` | PASS: 11 Chromium tests                                                        |
| `pnpm test:web:e2e`                            | PASS: 4 composed journeys and 5 shell/accessibility journeys                   |
| `pnpm test:web:disclosure`                     | PASS: 5 public artifacts scanned                                               |
| `pnpm audit --audit-level moderate`            | PASS: no known vulnerabilities                                                 |
| `pnpm licenses list --prod --json`             | 83 package/version entries: 76 MIT, 6 ISC, 1 BSD-3-Clause; no missing licenses |
| Full-history Gitleaks 8.30.0                   | PASS: 45 commits, approximately 1.21 MB, no leaks                              |
| Pinned Redis executable                        | PASS: Redis 7.4.5 executes in the disposable test image                        |

The Gitleaks image was
`zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9`,
run with this checkout mounted read-only and `git /repo --no-banner --redact`.
Redis's test image is
`redis:7.4.5-alpine@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08`.
This is a test prerequisite check, not S8 image or vulnerability acceptance.

## Frozen boundaries and ownership

The [S5 API contract](../docs/architecture/s5-api-contract.md) and
[S6 acceptance record](../docs/architecture/s6-acceptance.md) remain the public
baseline. Cookie, CSRF, idempotency, public projection and local limiter
behavior must not change in S7.1.

| Files                                                                | S7.1 responsibility                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/cache`, cache contract tests                               | Envelope, keys, ports and bounded client profiles                    |
| `packages/queue`, queue contract tests                               | Job schema, identity and execution/retention policy                  |
| `packages/config`, Redis configuration tests                         | Separate API/worker/observer parsers                                 |
| Database role migration and permission tests                         | Published suggestion reader and current-revision producer privileges |
| ADR 0005, architecture/contract docs, lockfile, root focused command | Boundary and admission evidence                                      |

Worker and observer remain compile-only placeholders in S7.1. The queue
package gains contracts only. Redis adapters, API cache/limiter wiring,
producer, worker, observer runtime and composed failure testing remain
S7.2-S7.8. No container deployment is introduced.

Scope clarification: on 2026-09-29 the user limited execution to S7.0 and
S7.1. Any unimplemented later-slice tests drafted before that clarification
are removed from this delivery. S7.9 acceptance and hosted CI for this change
are not implied by baseline success.
