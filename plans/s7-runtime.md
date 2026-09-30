# S7.2-S7.6 local runtime evidence

Date: 2026-09-30. Branch: `codex/s7-runtime`. This record covers the local
implementation of S7.2-S7.6. It does not claim a hosted CI run or merge.

| Slice | Runtime behavior                                                                                                                                                                                                                          | Focused evidence                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| S7.2  | Separate bounded reader and worker writer; strict revision equality; canonical 48-hour value; atomic key-count admission; no API write port                                                                                               | `tests/cache`, pinned Redis ACL/corruption/TTL/saturation tests                                       |
| S7.3  | Ownership and current-revision check commits before cache access; PostgreSQL fallback builds the same immutable index and uses the existing public suggestion projection; transaction context rejects Redis calls inside `BEGIN`/`COMMIT` | Two-guest hit/miss/loss database tests, corrupt-value Redis test, database and API integration suites |
| S7.4  | One deterministic warm job; Redis-time atomic outstanding reservation; startup, 60-second tick, and capped recovery reconciliation; terminal job removal permits safe replay                                                              | Concurrent producer, retained-terminal replay, full queue, outage/current-revision-change Redis tests |
| S7.5  | Validated worker process, worker-only PostgreSQL views and cache write, permanent poison failures, three transient attempts, 5-second job deadline, 10-second drain and signal handling                                                   | Poison/retry/replay Redis tests and cancellation unit test                                            |
| S7.6  | Redis-time atomic 60-second IP/guest ceilings, HMAC identity separation, global key registry; local admission remains first and final on its own denial                                                                                   | Concurrent two-client ceiling, registry saturation, HMAC rotation, outage fallback and HTTP 429 tests |

The runtime required three narrow refinements to the S7.1 design. The 16-key
cache namespace uses 15 revision values plus one admission registry. The
producer has a dedicated PostgreSQL URL and role. Cache and producer admission
scripts require the additional ACL commands recorded in
`ops/redis/acl-policy.json`. Their exact source hashes are pinned in
`ops/redis/runtime-script-hashes.json`; the BullMQ script inventory remains
unchanged. The queue event stream requests approximate trimming at 512 to
leave headroom under the 1,024-event budget.

Gates passed on a clean worktree from `origin/main` at `2391a4d`: formatting, lint, all
workspace builds, 361 non-container tests, 92 PostgreSQL tests, seven
API/PostgreSQL tests, eight pinned Redis 7.4.5 tests, the BullMQ source
inventory check, web disclosure scan, and dependency audit. The audit found
three new advisories in transitive development tooling; the workspace now
pins `brace-expansion` 5.0.12 and the audit reports no known vulnerabilities.

Disabling `LOREMASTER_REDIS_ENABLED` and stopping the worker selects the
PostgreSQL suggestion path and replica-local limiter. No gameplay transaction
waits for Redis. Exact cache keys expire after 48 hours; rollback needs no
wildcard deletion. S7.7 health/observer, S7.8 composed failure and memory
headroom measurement, S7.9 acceptance, and hosted CI/merge remain separate
delivery gates.
