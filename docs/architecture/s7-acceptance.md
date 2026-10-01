# S7 cache worker acceptance record

Recorded 2026-10-01. S7.2-S7.6 are accepted through PR #12. S7.7-S7.9
complete worker health, queue observation, composed failure verification,
independent review and the S8 handoff through
[PR #13](https://github.com/JasonHo20004/loremaster/pull/13).
The final documentation commit must pass Quality, Dependency audit and Secret
scan before merge. The [final PR checks](https://github.com/JasonHo20004/loremaster/pull/13/checks)
and merged PR record are the delivery evidence. `PASS` means executable proof;
`DEFERRED (owner)` names downstream work.

PostgreSQL remains authoritative. The frozen S5/S6 browser/API contract,
cookie/CSRF/idempotency rules and synchronous gameplay effects remain intact.
The [Redis contract](../../ops/redis/README.md) owns exact environment inputs,
ACL/source ledgers, connection profiles and namespace budgets.

## Acceptance map

| Claim | Executable evidence | Status |
| --- | --- | --- |
| Strict immutable server-only cache/job contracts | `pnpm test:s7:contracts`: cache, queue, configuration, package boundaries, source/hash inventories | PASS |
| Ownership commits before Redis; no Redis inside transactions | `tests/database/gameplay-repository.test.ts`; adapter `assertOutsideTransaction`; `pnpm test:database` | PASS |
| Two guests with different evidence remain isolated | Composed cold/hit/corrupt/restarted/disabled API comparisons and foreign-owner denials; database two-guest suite | PASS |
| PostgreSQL truth survives Redis loss | Composed paused-Redis test commits REVEAL, replays exact receipt across replicas and proves no duplicate row effect; API readiness remains PG-only | PASS |
| Shared ceiling and local outage fallback | Two composed APIs share HMAC material: ten healthy session admissions total, each retains local ceiling during outage; real Redis overlapping-version saturation | PASS |
| Duplicate/replayed warm jobs; poison; bounded attempts | Isolated Redis coalescing/replay tests, composed excess-attempt injection, fixed secret-bearing transient failures and zero stacks | PASS |
| Actual Redis restart/OOM and worker kill | Composed pinned Redis restart and OOM rejection; active-read worker kill/restart and canonical atomic replacement; cancellation unit tests | PASS |
| Current-revision selection recovers without producer restart | Composed paused Redis with shifted windows in disposable PostgreSQL; production PG-time selector picks next revision; original rows and temporal checks restored | PASS (simulated UTC boundary) |
| Least-privilege database/Redis roles | `tests/database/s7-roles.test.ts`; real Redis wrong-role/forbidden-command denials; source guards and hashes | PASS |
| Namespace admission and memory headroom | Real cache/limiter/queue bounds; composed maximum-size/count `MEMORY USAGE` measurement | PASS |
| Worker/observer health, bounded metrics and disclosure | `pnpm test:s7:health`, `pnpm test:s7:observer`; composed held PG-login denial, Redis outage, stored cache/job/log/metric marker scan | PASS |
| Terminal retention and event budget | Composed 140 poison jobs retain at most 128 failed records and 1,024 events | PASS |
| Hosted verification and delivery | [Runtime CI](https://github.com/JasonHo20004/loremaster/actions/runs/36816763589) passed on `4f5bd574435393492218155fea7581c5084de2c0`; [final PR checks](https://github.com/JasonHo20004/loremaster/pull/13/checks) must pass before merge | PASS (merge gate) |
| Artifact and AWS cache isolation | S8 scans assembled artifacts; S12 repeats two-guest proof in its separately admitted environment | DEFERRED (S8/S12) |
| Full telemetry pipeline and retention | S7 exports fixed metrics and retains finite BullMQ job history only | DEFERRED (S10) |

Composed evidence is `tests/redis/composed.integration.test.ts`, invoked by
`pnpm test:s7:integration`. Isolated Redis evidence is
`tests/redis/runtime.integration.test.ts`, invoked by `pnpm test:redis`.
Missing Docker/PostgreSQL/Redis is a hard failure, never a skipped prerequisite.

## Runtime contract for S8

| Process | Entrypoint and binding | Health and lifecycle |
| --- | --- | --- |
| API | `pnpm --filter @loremaster/api start`; loopback `PORT`, default 3000 | `/health/live` process-only; `/health/ready` PG-only; ten-second HTTP drain |
| Worker | `pnpm --filter @loremaster/worker start`; `127.0.0.1:3001` | GET `/health/live`: 200 `{status:"ok"}`; GET `/health/ready`: 200 `{status:"ready"}`, or 503 `{status:"unavailable"}` / `{status:"draining"}`; queue/cache Redis plus worker-role PG required |
| Observer | `pnpm --filter @loremaster/queue-observer start`; `127.0.0.1:3002` | Same live/ready schemas; valid aggregate Redis data required; GET `/metrics` fixed Prometheus text; absent worker sets degraded without making observer unready |

Private probes use one-second deadlines and cancellation, one in-flight
readiness check, no-store responses, a 16-header cap and one-second HTTP close
budget. Shutdown waits for an in-progress bind. Worker SIGINT/SIGTERM marks
draining immediately, stops consumption, drains at most ten seconds, aborts
remaining work and closes owned HTTP/Redis/PostgreSQL clients. Observer stops
reads and closes its HTTP/Redis resources. Liveness queries no dependency.

Worker queue heartbeat is exactly
`loremaster:v1:queue:loremaster-warm-v1:health` with value `1`, renewed every
second with a 3,000 ms TTL on the existing connection. It means at least one
queue loop is connected, not PG readiness or every replica's connectivity.
Observer GETs only this exact key, counts five fixed queue states and reads at
most one completed/failed timestamp using `ZRANGE 0 0 WITHSCORES`. Identifiers
are discarded. Inspection is single-flight with at most one-second caching.
Invalid/overbudget data yields fixed zero gauges, degraded=1 and unready.

Stable gauges are `loremaster_queue_waiting`, `loremaster_queue_active`,
`loremaster_queue_delayed`, `loremaster_queue_completed`,
`loremaster_queue_failed`, `loremaster_queue_oldest_retained_age_seconds`,
`loremaster_queue_worker_connected`, and `loremaster_queue_degraded`. Labels
are only `queue="loremaster-warm-v1",version="1"`. Oldest retained age covers
terminal timestamps capped at 48 hours; it does not claim waiting-job age.
No payload, ID, key, URL, stack, guest, revision or arbitrary label is exported.

Dependencies: BullMQ **5.81.5**, ioredis **5.11.1**, Node **22.17.0**, pnpm
**11.19.0**. Queue name/prefix: `loremaster-warm-v1` / `loremaster:v1:queue`.
One job `warm-current-revision-v1` uses strict `{version:1,revisionId}` and
`warm-v1-<UUID>` identity. Payload/result bounds are 128/64 bytes. Cache values
are canonical version-1 suggestion indices, at most 512 KiB, on exact
`loremaster:v1:revision:<UUID>:suggestions` keys with 172,800-second TTL.
Only immutable eligible published entities are cached; no guest or HTTP state.

Processing: concurrency 2/default, 4/maximum; five-second work deadline;
three attempts; exponential 1,000 ms base with jitter 0.5; 48-hour maximum age;
128 outstanding and 128 retained records per terminal state; zero stacks;
one stalled recovery, five-second stalled check and ten-second lock. Producer
reconciles at startup/reconnect/every 60 seconds within one second. It selects
current revision with PostgreSQL time and never runs on a gameplay request.
All terminal transitions normalize retry, retention and stack options.

API Redis connections: one cache, one limiter, one producer. Worker: one
queue, one blocking duplicate, one cache writer. Observer: one connection.
Separate PG logins/pools retain runtime, cache-producer and cache-worker roles.
Worker and producer infrastructure connection setup is bounded to one second;
API pool deadlines and public 504 semantics remain unchanged. Read-only
commits retain cancellation; authoritative write commits preserve receipt
uncertainty. Exact environment variables are in the Redis configuration inventory.

Limiter counters are versioned HMAC identities with 61-second TTL. One global
`loremaster:v1:limit:capacity` registry spans versions. Healthy shared denial
and local denial are final. Outage uses each replica's local decision and emits
a bounded degraded code, so N replicas can admit the sum of N local ceilings.

The three application Lua scripts use `#!lua` with default OOM rejection;
legacy pruning-first scripts could otherwise continue writes under OOM.
Reviewed hashes are in `ops/redis/runtime-script-hashes.json`. Native ACLs
restrict commands/keys; source guards separately enforce admitted BullMQ Lua.

The disposable harness uses pinned Redis 7.4.5 with `noeviction`, 128 MiB,
AOF every second, no snapshots and a unique container. An explicit ephemeral
loopback host port stays stable across restart. Test-only admin commands,
corruption injection and simulated temporal fixture changes are not runtime
capabilities. Cleanup removes only exact keys/containers, never `FLUSHALL`.
Namespace maxima: cache 15 values plus registry / 16 MiB; queue 384 jobs /
32 MiB; limiter 20,000 keys / 16 MiB. Composed maximum-size measurements:
cache **9,831,720 bytes**, queue **7,947,264 bytes**, limiter about **7.6 MiB**;
combined with instance overhead about **28 MiB**, below the 64 MiB admission
threshold and preserving more than 64 MiB headroom.

## Verification and independent review

Required final commands: `pnpm run verify`, `pnpm test:database`,
`pnpm test:api:database`, `pnpm test:redis`, `pnpm test:s7:integration`,
`pnpm test:s7:contracts`, `pnpm test:web:e2e`,
`pnpm --filter @loremaster/web test:component`, `pnpm test:web:disclosure`,
audit, production license inventory, full-history/workspace secret scans,
and `git diff --check`. Final results are appended after execution.
Windows uses the pinned Corepack shim with `C:\Users\Jason\.local\bin` first
in PATH. Dependency junctions and Docker require execution outside the local
sandbox; checks are not skipped because of those environment permissions.

Independent TypeScript, database/acceptance and security reviewers resolved
raw dependency log disclosure, persisted driver messages, overlapping HMAC
admission, malformed retry options, pending health-bind shutdown, composed CI
omission and missing failure proofs. Final reviews report no remaining material
finding. Independent health/observer tests passed. Final local counts and hosted evidence are recorded below.

S8 must package the accepted processes, preserve explicit migration/import
operations, PostgreSQL authority, Redis fallback and public disclosure rules,
and establish its container probe/binding policy. S8 owns assembled-artifact
scanning and image admission. S7 creates no runtime containers, Kubernetes,
registry releases or AWS resources. Rollback disables Redis, stops producer,
worker and observer, and lets exact keys expire without gameplay/schema rollback.

## Final local gate results (2026-10-01)

| Gate | Result |
| --- | --- |
| Frozen install and full `pnpm run verify` on isolated delivery checkout | PASS; formatting, lint, typechecks, 369 tests, all 11 workspace builds |
| `pnpm test:database` | PASS; 93 tests in 6 files |
| `pnpm test:api:database` | PASS; 7 tests in 2 files |
| `pnpm test:s7:contracts` | PASS; 88 tests in 12 files and BullMQ inventory |
| `pnpm test:redis` | PASS; 8 real Redis scenarios |
| `pnpm test:s7:integration` | PASS; 9 composed scenarios, no skips |
| `pnpm test:web:e2e` | PASS; 4 real-stack plus 5 shell/accessibility journeys |
| `pnpm --filter @loremaster/web test:component` | PASS; 11 Chromium tests |
| `pnpm test:web:disclosure` | PASS; 5 public artifacts, no private markers |
| `pnpm audit --audit-level moderate` | PASS; no known vulnerabilities |
| Production license inventory | 102 package/version entries: 90 MIT, 3 Apache-2.0, 7 ISC, 1 BSD-3-Clause, 1 0BSD; no unknown license |
| Pinned Gitleaks 8.30.0 full history | PASS; 51 predecessor commits / 1.43 MB; delivery snapshot rescanned after commit |
| Diff hygiene | PASS; `git diff --check` |

Reviewers: independent `typescript-reviewer`, `code-reviewer` for database and
acceptance, and `security-reviewer`. Final follow-up reports no remaining
material findings; the producer timeout documentation was corrected.

## Hosted delivery evidence

Accepted predecessor: S7.2-S7.6 [PR #12](https://github.com/JasonHo20004/loremaster/pull/12),
main `5308d778e000e03785260d6df6850b1d7037e3c7`;
[branch CI](https://github.com/JasonHo20004/loremaster/actions/runs/36727763370)
and [merged-main CI](https://github.com/JasonHo20004/loremaster/actions/runs/36728221191) passed.

S7.7-S7.9 runtime delivery: `4f5bd574435393492218155fea7581c5084de2c0`;
[hosted CI](https://github.com/JasonHo20004/loremaster/actions/runs/36816763589)
passed Quality, Dependency audit and Secret scan. Quality reproduced the frozen
install, full verify, contracts, PostgreSQL, API/PostgreSQL, isolated Redis and
all nine composed scenarios on Ubuntu 24.04. Full verify and the composed gate
also passed locally after the accepted-predecessor update.

Final documentation and S8 admission use the same required jobs in
[PR #13 checks](https://github.com/JasonHo20004/loremaster/pull/13/checks).
Merge is allowed only after those jobs pass on its final head. The merged
[PR #13 record](https://github.com/JasonHo20004/loremaster/pull/13) identifies the
accepted main commit without a self-referential documentation hash. S8 must
start from that merged, green predecessor; it may not substitute an unreviewed
working tree.