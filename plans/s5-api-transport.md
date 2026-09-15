# S5 API transport construction plan

Date: 2026-09-14. Objective: expose the accepted S4 gameplay and reporting
transactions through a bounded, authenticated Express JSON API without moving
authoritative state out of PostgreSQL or disclosing private case content.

## Readiness decision

S5 is **based on the reviewed S4 merge and locally ready; completion of the
delivery preflight remains conditional on CI for the S5.0 command correction**.

The formal S5 base is `fa47243` (`Merge pull request #4 from
JasonHo20004/domain-engine`). The S5 branch is `codex/s5-api`; the merge contains
topic head `0b5202b` and the final S4 feature commit `8be6c8b`.

Evidence checked on 2026-09-15:

- S4 PR #4 is merged into `origin/main` at `fa47243`, and `codex/s5-api` is
  based directly on that reviewed merge.
- Formatting and ESLint pass when invoked through the pinned Corepack pnpm.
- All ten workspace TypeScript configurations typecheck and build.
- All 152 non-database tests pass.
- All 47 tests pass against a clean disposable PostgreSQL 17.6 container.
- `packages/database` exports typed current-case, start, owned-attempt, command,
  profile, and leaderboard operations for an API adapter.
- S1/S4 acceptance records and the threat model enumerate the transport,
  identity, replay, race, timeout, disclosure, and abuse-control evidence that
  S5 must close.

Delivery caveats:

- GitHub CLI is unavailable in this environment, so PR creation/checks require
  the GitHub UI. S5 uses the UI and does not depend on `gh`.
- The global/fallback pnpm shim is inconsistent outside the managed session.
  A Corepack shim scoped to the session proves Node 22.17.0 and pnpm 11.19.0;
  CI continues to use `corepack enable` and `corepack install`. Use the explicit
  `pnpm run verify` form because pnpm 11 has an unrelated built-in `verify`.
- `apps/api`, `packages/contracts`, `packages/config`, and
  `packages/observability` are still scaffolds. The database does not yet expose
  session creation/authentication or keyset leaderboard pagination. These are
  planned S5 work, not S4 regressions.

## Scope and fixed invariants

S5 owns the HTTP boundary, guest-session lifecycle, request validation,
security middleware, bounded in-process abuse controls, database timeouts,
public JSON contracts, API integration tests, and an S5 acceptance record.

The following are fixed inputs, not implementation choices:

- Express is the API framework; PostgreSQL remains authoritative.
- Authentication is a server-issued token with at least 256 bits of entropy;
  only its SHA-256 hash is stored. Sessions expire absolutely after 30 days.
- Production uses a host-only `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`
  `__Host-` session cookie. Local HTTP uses a different, explicitly local name
  and is forbidden in production mode.
- Every gameplay mutation requires the exact configured `Origin`, JSON content
  type, a session-bound CSRF header, guest ownership, and a guest-scoped ASCII
  idempotency key of at most 128 characters. `POST /session` is the sole
  bootstrap exception: it has no prior identity or CSRF secret, so it requires
  exact Origin, the exact JSON object `{}`, and the source-IP creation limit.
  S5.1 must formally clarify or supersede ADR 0003 so its “every mutation” rule
  applies to authenticated gameplay mutations before S5.2 implementation starts.
- JSON bodies are at most 16 KiB. Autocomplete queries are at most 80
  characters and return at most 20 items.
- A command has a five-second end-to-end deadline, a one-second lock timeout,
  and a three-second PostgreSQL statement timeout. A timeout rolls back before
  a success receipt; clients retry with the same idempotency key.
- Per minute: 30 mutations per guest, 120 mutations per source IP, 120
  autocomplete reads per guest, 300 per IP, and 10 session creations per IP.
  A bounded per-process limiter remains active without Redis and rejects new
  identities when its storage cap is full.
- Logs contain request ID, route template, status, and timing only. They never
  contain cookies, tokens, guesses, raw URLs, SQL parameters, imported text, or
  private projections. Metric labels are bounded and contain no guest or
  attempt ID.
- API responses are constructed from explicit public contracts/projections;
  database rows and thrown error details are never serialized.
- Credentialed CORS allows only the configured exact origin, methods, and
  headers. It never returns an origin wildcard. Trusted proxies are explicit
  addresses/CIDRs, never an unexplained hop count.
- Leaderboard cursors are versioned, bound to the slot and ordering schema, and
  authenticated with HMAC. Base64url encoding alone is not integrity.

S5 does not own the React application, browser refresh journey, Redis/BullMQ,
cache warming, containers, Kubernetes, full observability retention, or cloud
deployment. Those remain S6–S12 work.

## Proposed HTTP surface

Freeze this surface and its schemas in S5.1 before handler implementation.
Names may change during that slice, but no handler may land before the accepted
contract and status matrix exist.

| Method and route                                  | Authentication             | Purpose                                                                                                                                       |
| ------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/session`                            | bootstrap policy           | With exact Origin, exact body `{}`, and IP limiting, create a guest/session, set mode-specific auth/CSRF cookies, and return public metadata. |
| `GET /api/v1/session`                             | cookie                     | Confirm/refresh client-visible session metadata without rotating or extending absolute expiry.                                                |
| `GET /api/v1/cases/current`                       | cookie                     | Return `NO_CASE`, `NOT_STARTED`, or the owned attempt projection. Reads may reconcile expiry but never start a clock.                         |
| `POST /api/v1/cases/current/attempt`              | cookie + mutation controls | Start once or replay the same start receipt.                                                                                                  |
| `GET /api/v1/attempts/:attemptId`                 | cookie                     | Return only the owned attempt; use a non-disclosing not-found response for unknown and foreign IDs.                                           |
| `POST /api/v1/attempts/:attemptId/commands`       | cookie + mutation controls | Apply `GUESS`, `REVEAL`, or `GIVE_UP` with expected version and idempotency key.                                                              |
| `GET /api/v1/attempts/:attemptId/suggestions?q=`  | cookie                     | Return at most 20 suggestions for an owned, current, ACTIVE attempt. Never fetch supplied URLs.                                               |
| `GET /api/v1/profile`                             | cookie                     | Return the guest's reconciled statistics and regional knowledge.                                                                              |
| `GET /api/v1/leaderboards/:slotId?limit=&cursor=` | cookie                     | Return stable keyset pagination with competition ranks and an opaque validated cursor.                                                        |
| `GET /health/live`                                | none                       | Process liveness only; no dependency or configuration details.                                                                                |
| `GET /health/ready`                               | none                       | Bounded PostgreSQL readiness only; no secrets or raw errors.                                                                                  |

Use one error envelope containing a stable public code, request ID, and optional
field paths. Define exact mappings for 400, 401, 403, 404, 409, 413, 415, 429,
500, 503, and 504. Authentication, ownership, and unknown-ID responses must not
form an enumeration oracle. Successful mutation responses include `replayed`
and the current projection, never the raw receipt fingerprint or token.

## Dependency graph

```text
S5.0 -> S5.1 -> S5.2 -> S5.3a
                         |   |---> S5.3b --|
                         |   |---> S5.3c --|--> S5.4 --|
                         |   |---> S5.3d --|            |--> S5.6 -> S5.7 -> S5.8
                         |   `---> S5.3e --|--> S5.5 --|
                         `-----------------'
```

S5.3b–S5.3e may proceed in parallel after the kernel interfaces in S5.3a are
frozen, with the file ownership named below. S5.4 and S5.5 may then proceed in
parallel. S5.6 composes the finished controls and routes; it cannot exit early.
S5.7 depends on that complete application, removing any ambiguity between pure
handler tests and protected HTTP integration tests.

## Execution matrix

| Slice | Risk     | Execution/review tier                              | Parallel group      |
| ----- | -------- | -------------------------------------------------- | ------------------- |
| S5.0  | Medium   | Default executor; delivery review                  | Preflight only      |
| S5.1  | High     | Strong architect; security review                  | Contract gate       |
| S5.2  | High     | Strong database/security executor and review       | Identity foundation |
| S5.3a | Medium   | Default TypeScript executor; TypeScript review     | Kernel gate         |
| S5.3b | High     | Strong security executor and review                | P1 with S5.3c–e     |
| S5.3c | Critical | Strong database/security executor and review       | P1 with S5.3b,d,e   |
| S5.3d | High     | Strong security executor and review                | P1 with S5.3b,c,e   |
| S5.3e | High     | Default executor; security review                  | P1 with S5.3b–d     |
| S5.4  | High     | Strong TypeScript executor; security review        | P2 with S5.5        |
| S5.5  | High     | Strong database executor; database/security review | P2 with S5.4        |
| S5.6  | High     | Default executor; E2E and lifecycle review         | Composition gate    |
| S5.7  | Critical | Strong independent adversarial/security reviewer   | Serial gate         |
| S5.8  | High     | Strong independent acceptance reviewer             | Serial exit         |

“Strong” means the most capable available reasoning tier; “independent” means
the reviewer did not author the slice. Parallel work may not share the primary
files named below without an explicit ownership handoff in the mutation log.

## S5.0 — Close the delivery preflight

Context: S5 must have exactly one reviewed S4 base and a reproducible toolchain.
This slice changes no application behavior.

- Merge or formally base the S5 branch on the reviewed `domain-engine` head;
  record the base commit in the PR description.
- Repair/replace the stale pnpm shim using Corepack, verify Node 22.17.0 and pnpm
  11.19.0, install with `--frozen-lockfile`, and run the unmodified root gates.
- Confirm `pnpm run verify`, `pnpm test:database`, and `git diff --check` on a clean
  checkout. Confirm CI uses the same commands and retains read-only permissions.
- Decide whether PR operations use the GitHub UI or install `gh`; do not make
  local API work depend on the CLI.

Verify: `node --version`, `pnpm --version`, `pnpm install --frozen-lockfile`,
`pnpm run verify`, `pnpm test:database`, `git diff --check`. Exit: a single S4 base
is named and all gates pass from a clean checkout. Rollback: discard only the
S5 branch/tool shim change; never rewrite or reset the S4 commits.

## S5.1 — Freeze public contracts and the status matrix

Context: `packages/contracts` is browser-safe and may depend on public domain
types, but never on database rows, server configuration, or content fixtures.

- Define strict request/response schemas for every route above, including the
  discriminated case/attempt projections and stable error envelope.
- Bound UUID/date/version/integer/query/idempotency/cursor inputs. Reject unknown
  object keys, wrong primitive types, malformed JSON, non-JSON bodies, and
  non-calendar dates before invoking a repository.
- Specify the canonical command shape used by the existing S4 fingerprint; HTTP
  field order must not affect replay identity.
- Define the exact domain/database rejection-to-HTTP mapping and document when a
  timeout is safe only to retry with the same key.
- Design an opaque base64url leaderboard cursor from the full stable ordering
  tuple `(version,slotId,orderingSchema,evidenceLevel,totalWrongGuesses,
elapsedMilliseconds,attemptId)` authenticated with HMAC; parse, authenticate,
  and validate it as untrusted input and never accept SQL fragments. Define key
  rotation behavior before implementation.
- Freeze exact credentialed CORS/OPTIONS behavior, cookie names/attributes and
  clearing attributes, the session-bootstrap exception, and non-disclosing
  unknown/foreign/terminal suggestion mappings.
- Before S5.2 begins, update ADR 0003 with a formal clarification that its
  session/CSRF/idempotency mutation controls apply to authenticated gameplay
  mutations, while `POST /session` is the exact-Origin + exact-`{}` + IP-limited
  bootstrap. If reviewers judge this a changed decision rather than a
  clarification, add a superseding ADR and update the normative acceptance text.
- Reject repeated security headers/query parameters. Use a bounded raw JSON
  parser that rejects duplicate object keys rather than relying on last-key-wins
  behavior for command fields.
- Add contract examples and recursive tests proving active/no-case responses
  cannot represent answer, future evidence, explanations, or sources.

Primary files: `packages/contracts/src/`, `tests/contracts/`, and the S5 status
matrix under `docs/architecture/`. Verify: `pnpm --filter
@loremaster/contracts test`, `pnpm --filter @loremaster/contracts typecheck`,
`pnpm run verify`. Exit:
every route and rejection has one validated public representation, and handlers
need no ad-hoc body parsing. Rollback: remove contract modules/tests before any
handler depends on them.

## S5.2 — Configuration, identity, and session persistence

Context: the API creates identities; existing S4 gameplay repositories consume
trusted `{guestId, sessionId}` values. Raw tokens never cross into gameplay
methods or logs.

- Replace the config scaffold with a strict server environment parser covering
  mode, database URL, exact origin, trusted proxies, port, cookie names, timeouts,
  cursor HMAC keys/versions, and limiter capacities. Trusted proxies are parsed
  as explicit addresses/CIDRs. Fail startup on unknown/unsafe production
  combinations, including the local cookie in production.
- Add database session operations to atomically create guest + session, generate
  a server pseudonym, authenticate by token hash, and reject absolute expiry.
  Generate independent 32-byte authentication and CSRF secrets using Node
  cryptography; persist only hashes.
- Use a readable same-origin CSRF cookie plus required header whose value hashes
  to the immutable session-bound database value. Keep the auth cookie HttpOnly.
  Production cookies have no `Domain`; clear both cookies with the exact same
  mode/path/security attributes on invalid/expired authentication without
  disclosing why. Authentication middleware checks expiry before every read or
  write repository call.
- Add forward migration only if new indexes/constraints are proven necessary;
  do not edit S4 migration files. Do not extend expiry on reads.
- Cover token uniqueness, hash-only persistence, pseudonym bounds, cookie mode,
  expired session, two-session isolation, and no token leakage in errors.
- Extend the disposable test harness to create a login granted only the
  `loremaster_runtime` group role. Run API integration and readiness through that
  credential and prove it cannot perform DDL, import/update published content,
  or invoke migrations.

Primary files: `packages/config/src/`,
`packages/database/src/identity/`, a new forward migration only if required,
`tests/config/`, and `tests/database/session-repository.test.ts`. Verify:
`pnpm --filter @loremaster/config test`, `pnpm test:database`, then `pnpm run
verify`. Exit: an HTTP adapter can resolve a
trusted identity without receiving a client-selected guest/session ID. Rollback:
remove new repository code; correct deployed schema only with a forward migration.

## S5.3a — Express kernel and bounded parsing

Context: construct the application through an injectable factory so integration
tests do not bind a real port. This slice owns only the kernel, parsing, public
errors, and headers; later slices plug controls into explicit interfaces.

- Pin the smallest required Express/runtime/test dependencies and update the
  lockfile. Keep validation contracts in `packages/contracts`.
- Apply a bounded raw-body/JSON parser that enforces 16 KiB, rejects malformed
  JSON, duplicate object keys, unknown fields through S5.1 schemas, and wrong
  content types without echoing bodies.
- Generate request IDs server-side; do not trust caller values. Disable
  identifying defaults and add conservative JSON API security headers.
- Define injectable auth, policy, limiter, deadline, logger, repository, and
  clock interfaces for focused tests; do not implement those controls here.

Primary files: `apps/api/src/app.ts`, `apps/api/src/http/`,
`tests/api/kernel.test.ts`, `apps/api/package.json`, and `pnpm-lock.yaml`.
Verify: `pnpm --filter @loremaster/api test -- kernel`, API typecheck/build,
`pnpm run verify`. Exit: bounded validated requests reach an injected no-op handler
and all parse failures use the stable envelope. Rollback: remove the kernel and
dependency additions; database behavior is unchanged.

## S5.3b — Authentication, cookies, CSRF, and CORS

Context: use S5.2 session operations through S5.3a interfaces. Session bootstrap
is the sole no-auth mutation and still requires exact Origin plus IP limiting.

- Implement auth-cookie resolution and expiry checks, mode-specific auth/CSRF
  cookie issue/clear behavior, exact Origin, session-bound CSRF, and JSON policy.
- Implement explicit credentialed CORS/OPTIONS allowlists for the one configured
  origin, methods, and headers. Never combine credentials with `*`.
- Return indistinguishable authentication/ownership failures and never pass a
  client-supplied guest/session ID to repositories.

Primary files: `apps/api/src/security/auth.ts`, `csrf.ts`, `cors.ts`,
`cookies.ts`, and `tests/api/auth-policy.test.ts`. Verify: `pnpm --filter
@loremaster/api test -- auth-policy`, `pnpm run verify`, and runtime-role integration
tests. Exit: a protected no-op handler cannot run without all identity policies.
Rollback: remove these middleware registrations; keep S5.2 database operations.

## S5.3c — End-to-end deadlines and cancellable transactions

Context: a response-level `Promise.race` is forbidden because PostgreSQL work
could commit after a 504. The deadline begins when the request arrives and
includes parsing, authentication, rate limiting, pool acquisition, SQL, commit,
or rollback.

- Add a request deadline/cancellation context and thread it through handlers and
  database operations. Bound `pg.Pool.connect()` acquisition within the remaining
  budget; distinguish pool, lock, statement, and client-disconnect cancellation.
- Extend `packages/database/src/gameplay/runtime.ts` transaction helpers to set
  local `lock_timeout=1s` and `statement_timeout=3s`, cancel safely, and return
  control only after COMMIT or ROLLBACK completes.
- Map timeout classes to the frozen public envelope. Never emit 504 while work can
  still commit; a client disconnect triggers cancellation and completed rollback.
- Test pool exhaustion, held locks, long statements, disconnects, rollback
  failure handling, no success receipt after timeout, and same-key recovery.

Primary files: `packages/database/src/gameplay/runtime.ts`, a shared database
deadline type, `apps/api/src/http/deadline.ts`,
`tests/database/transaction-timeout.test.ts`, and
`tests/api/timeout.integration.test.ts`. Verify: `pnpm test:database`, `pnpm
--filter @loremaster/api test -- timeout`, `pnpm run verify`. Exit: all timeout paths
prove transaction completion/rollback before an error response. Rollback: retain
the old transaction overload during migration; remove it only after every S5
caller passes the deadline context. Schema remains unchanged.

## S5.3d — Trusted source IP and bounded abuse controls

Context: source IP is security input only after explicit proxy validation. Redis
is absent in S5; the local limiter remains a mandatory fallback after S7 adds a
shared limiter.

- Resolve source IP from the socket and only configured proxy addresses/CIDRs;
  reject forged forwarding chains and never use a vague hop-count setting.
- Implement bounded minute windows, deterministic expiry, hard storage caps, and
  the exact guest/IP/session/autocomplete limits. Return integer `Retry-After`.
- When capacity is full, reject new limiter identities instead of allocating
  unbounded state. Document replica-local aggregate weakness.

Primary files: `apps/api/src/security/source-ip.ts`, `rate-limit.ts`, and
`tests/api/rate-limit.test.ts`. Verify: `pnpm --filter @loremaster/api test --
rate-limit`, `pnpm run verify`. Exit: proxy forgery and storage-exhaustion tables
pass. Rollback: unregister this middleware only on a non-deployed branch; S5
cannot ship without a bounded fallback.

## S5.3e — Redacted telemetry primitives

Context: S10 owns full telemetry/retention. S5 owns enough structured telemetry
to prove the API cannot leak secrets.

- Implement request logs with server request ID, route template, status, and
  timing only; serialize allowlisted fields rather than redacting arbitrary
  objects after the fact.
- Add bounded metric names/labels with no guest, session, attempt, raw URL, or
  error-object values. Build capture adapters for adversarial tests.

Primary files: `packages/observability/src/`, `apps/api/src/http/telemetry.ts`,
`tests/observability/`, and `tests/api/telemetry.test.ts`. Verify: focused
observability/API tests and `pnpm run verify`. Exit: secret-shaped fixtures never
appear in captured output. Rollback: remove telemetry adapter registration; do
not replace it with console logging of request/error objects.

## S5.4 — Protected gameplay routes

Context: handlers translate validated contracts to the existing S4 repository
API and translate typed results back. They contain no gameplay rules or SQL.

- Implement current-case and owned-attempt reads. Preserve lazy expiry and map
  foreign/unknown attempts to the same non-disclosing response.
- Implement start with header idempotency, and command with path attempt ID,
  expected version, and `GUESS`/`REVEAL`/`GIVE_UP` payloads.
- Map `NO_CASE`, replay, stale version, evidence limit, terminal attempt,
  unknown entity, conflict, expired session, and timeout exactly as S5.1 defines.
- Ensure rejected validation/CSRF/Origin/CORS/content-type requests never call the
  database mutation repository and never create a receipt.
- Test T01–T21 and T23–T25 transport portions, including duplicate start,
  canonical replay, changed payload/key conflict, two-client same-version race,
  repeated wrong guesses with new keys, exact-close lock contention, and profile
  effects after terminal outcomes.

Primary files: `apps/api/src/routes/gameplay.ts`,
`tests/api/gameplay-routes.test.ts`, and
`tests/api/gameplay.integration.test.ts`. Verify: `pnpm --filter
@loremaster/api test -- gameplay`, PostgreSQL-backed HTTP integration tests,
`pnpm run verify`, `pnpm test:database`. Exit: every gameplay
transport assertion has executable evidence and no route duplicates domain
logic. Rollback: remove route adapters/tests; S4 repositories remain usable.

## S5.5 — Suggestions, profile, and paginated leaderboard

Context: these are read paths, but suggestions/profile are guest-scoped and can
trigger reconciliation. The public leaderboard contains pseudonyms only.

- Add a revision/attempt-scoped suggestion query that performs bounded,
  deterministic matching over public name/aliases/role and returns at most 20.
  Require owned, current, ACTIVE attempt context; give unknown, foreign, and
  terminal IDs the frozen non-disclosing mapping. Do not expose answer
  correctness or fetch URLs.
- Expose the reconciled profile contract with exact hundredths/sample counts and
  half-up display percentages already produced by S4.
- Extend the leaderboard repository to keyset pagination while computing rank
  over the complete slot before cursor filtering. Return `items` and
  `nextCursor`; validate limit and opaque cursor before SQL.
- Prove B02–B06 and B08–B10 at the JSON boundary, including zero-score solved,
  `1,1,3` competition ranks across a page boundary, stable exact-tie order, and
  malformed cursor rejection, forged valid-looking tuples, wrong-slot/version,
  and cursor-key rotation.
- Apply separate guest/IP autocomplete limits and response-disclosure scans.

Primary files: `packages/database/src/gameplay/suggestions.ts`,
`leaderboard.ts`, `apps/api/src/routes/reporting.ts`,
`tests/database/reporting.test.ts`, and `tests/api/reporting.integration.test.ts`.
Verify: repository pagination/suggestion tests, PostgreSQL-backed route tests,
`pnpm run verify`, `pnpm test:database`. Exit: all S5 reporting/pagination deferrals
in the S4 matrix are closed. Rollback: retain old internal leaderboard read API
until callers migrate; remove new routes/repository overloads together.

## S5.6 — API composition and local developer workflow

Context: make S5 runnable without introducing S8 containers or S6 web assets.

- Compose config, database pool, middleware, and routes in an application
  factory with explicit dependencies; keep `index.ts` as a thin process adapter.
- Add liveness/readiness using the least-privilege runtime pool, startup refusal
  for unsafe production config, signal handling, connection draining, and
  graceful shutdown. Readiness never runs migrations or exposes raw errors.
- Add pinned `dev`, `start`, focused API test, and build scripts without weakening
  the root deterministic command surface. Include API integration tests in the
  clean PostgreSQL harness/CI rather than silently skipping them.
- Document local PostgreSQL credentials/roles, required environment variables,
  session bootstrap, curl examples that preserve cookies/CSRF/idempotency, and
  graceful shutdown. Examples use placeholders and never real secrets.
- Document the fallback limiter's per-replica semantics and the boundary with
  future S7 Redis augmentation; S7 must retain the local limiter for Redis
  outages rather than replace it.

Primary files: `apps/api/src/index.ts`, `apps/api/src/server.ts`, API scripts,
`scripts/database-test.mjs`, `.github/workflows/ci.yml`, and development docs.
Verify: fresh local start against a disposable database, readiness transition,
graceful SIGTERM, focused API test command, root gates. Exit: a new contributor
can run and exercise the API from documented commands only. Rollback: remove
composition/scripts/docs without touching persisted domain data.

## S5.7 — Adversarial transport and disclosure gate

Context: this slice attacks the composed API rather than individual helpers.

- Run an input matrix for malformed JSON, duplicate JSON object keys,
  repeated security headers/query parameters, unknown keys, wrong types,
  overlong values, encoded paths, content-type variants, and 16 KiB boundaries.
- Run independent cookie jars for two guests against attempt, receipt, profile,
  suggestion, and replay paths; assert no status/body/timing-friendly ownership
  disclosure beyond the frozen contract.
- Exercise missing/wrong Origin and CSRF, production/local cookie policies,
  credentialed CORS/preflight, forged forwarding headers, limiter storage
  exhaustion, and all 429 windows.
- Hold database locks to prove the one-/three-/five-second timeout hierarchy,
  rollback-before-receipt, same-key recovery, and exact-close reconciliation.
- Capture errors/logs/metrics for secret-shaped tokens, guesses, answer fields,
  future evidence, raw URLs, SQL fragments, IDs in labels, and imported text;
  fail on any match.
- Verify no public package or HTTP route imports `@loremaster/database/content`,
  its CLI, or fixtures, and no URL-fetching path exists.

Verify: one stable adversarial API command against clean PostgreSQL plus all root
gates. Exit: every S5-owned threat-model row has a named executable proof.
Rollback: tests/evidence only; fix failures in the owning slice rather than
weakening assertions.

Primary files: `tests/api/adversarial.integration.test.ts`,
`tests/api/disclosure.test.ts`, and the API database harness. The stable focused
command introduced by S5.6 is `pnpm test:api:database`.

## S5.8 — S5 acceptance and handoff to S6

Context: close only API claims. Browser bundles, browser refresh, deployed
artifacts, Redis, containers, and cloud evidence remain explicitly deferred.

- Create `docs/architecture/s5-acceptance.md` mapping T01–T25, B02–B06,
  B08–B10, B13, and every S5 threat-model control to exact tests and one of
  `PASS`, `PARTIAL`, or `DEFERRED (owner)`. Keep T03/T22 browser journeys with
  S6 and T25 scheduled/deployed observation with S8; do not overclaim them.
- Record clean counts for unit, non-database, database, HTTP integration, race,
  timeout, rate-limit, and disclosure suites. A missing Docker/database
  prerequisite is a failure, never a skip.
- Run dependency audit and secret scan after adding HTTP dependencies. Review
  runtime dependency licenses and lockfile changes.
- Update architecture/development/threat-model wording and README status only
  after the full gate and adversarial review pass.
- State the S6 handoff contract: browser-safe contracts and API base behavior are
  stable; secret fixtures remain server-only; browser/bundle proofs are still due.

Verify: `pnpm run verify`, focused API command, `pnpm test:database`, dependency
audit, secret scan, `git diff --check`, clean-checkout CI. Exit: S5 acceptance is
traceable and S6 can build without importing server modules. Rollback:
documentation/status only; production schema changes remain forward-managed.

Primary files: `docs/architecture/s5-acceptance.md`,
`docs/architecture/README.md`, `docs/development/README.md`,
`docs/threat-model/README.md`, `README.md`, and this plan's progress/mutation
records.

## Review and delivery rules

- Prefer one reviewed PR per numbered slice/suffix. S5.3b–S5.3e and later S5.4
  and S5.5 may be developed in parallel only as shown in the graph and with the
  disjoint primary-file ownership recorded above.
- Every slice must include its focused tests, all previously green gates, and a
  local rollback path. Do not mark progress from a partial/sandbox-only run.
- Security-sensitive identity, middleware, logging, timeout, and SQL changes
  require a security review. TypeScript changes require a TypeScript review.
- Never edit an applied S4 migration. Use a new forward migration and prove
  clean-database plus upgrade behavior.
- If a slice spans more than one focused review, split it with suffixes before
  implementation and update the graph. If a product/security invariant changes,
  supersede the relevant ADR and acceptance examples before coding.
- Maintain a mutation log at the end of this plan: date, changed dependency or
  slice, reason, affected acceptance IDs, and reviewer. Never silently reorder a
  slice after implementation has begun.
- Record progress below only after focused tests, root gates, database tests,
  review, and CI all pass.

## Progress

- [ ] S5.0 Close the delivery preflight — formal base `fa47243` recorded; frozen
      install, `pnpm run verify` (152 non-database tests), and 47 database tests
      pass locally on 2026-09-15; awaiting CI for the corrected command surface
- [ ] S5.1 Freeze public contracts and the status matrix — implemented and
      reviewed locally 2026-09-14; 15 focused, 151 non-database, and 47 database
      tests pass; awaiting S5.0 base/toolchain closure and clean-checkout CI
- [ ] S5.2 Configuration, identity, and session persistence — implemented and
      locally verified; awaiting independent review and clean-checkout CI
- [ ] S5.3a Express kernel and bounded parsing — implemented and locally
      verified; awaiting independent review and clean-checkout CI
- [ ] S5.3b Authentication, cookies, CSRF, and CORS — implemented and locally
      verified; awaiting independent review and clean-checkout CI
- [ ] S5.3c End-to-end deadlines and cancellable transactions — implemented and
      locally verified; awaiting independent review and clean-checkout CI
- [ ] S5.3d Trusted source IP and bounded abuse controls — implemented and
      locally verified; awaiting independent review and clean-checkout CI
- [ ] S5.3e Redacted telemetry primitives — implemented and locally verified
      2026-09-15; awaiting independent TypeScript/security review and
      clean-checkout CI
- [ ] S5.4 Protected gameplay routes
- [ ] S5.5 Suggestions, profile, and paginated leaderboard
- [ ] S5.6 API composition and local developer workflow
- [ ] S5.7 Adversarial transport and disclosure gate
- [ ] S5.8 S5 acceptance and handoff to S6

## Plan mutation log

- 2026-09-14 — Initial draft adversarially reviewed. Split the oversized kernel,
  added cancellable pool/transaction deadlines, corrected composition
  dependencies, froze the bootstrap/CORS/cursor/runtime-role policies, preserved
  the S7 local limiter fallback, and corrected S5/S6/S8 acceptance ownership.
  Affected: T01–T25, B02–B06, B08–B10, B13, and all S5 threat-model rows.
- 2026-09-14 — Implemented the S5.1 canonical runtime contract, operation/status
  matrix, ADR 0003 bootstrap clarification, CORS/cookie/cursor/retry policies,
  strict public projections, and contract tests. TypeScript and security review
  findings were resolved locally. Formal completion remains gated by S5.0 and
  clean-checkout CI. Affected: T01–T24 transport shapes, B02–B06, B08–B10, B13,
  and the S5 identity/disclosure/replay threat-model controls.
- 2026-09-14 — Clean-checkout CI exposed database typecheck resolving
  `@loremaster/domain` declarations before `dist` existed. Added a pinned
  Corepack pretypecheck prerequisite and command-surface regression test; clean
  reproduction, recursive typecheck/build, 151 non-database tests, and 47
  database tests pass. Affected: S5.0 toolchain reproducibility and S5.1 gate.
- 2026-09-15 — Based `codex/s5-api` on reviewed S4 merge `fa47243` (PR #4;
  topic head `0b5202b`, final S4 feature commit `8be6c8b`) and selected GitHub UI
  for PR operations. Corepack proved Node 22.17.0/pnpm 11.19.0 and a frozen
  install; the real aggregate gate passed with 152 non-database and 47 database
  tests. Corrected CI/docs to use `pnpm run verify` because pnpm 11's bare
  `pnpm verify` resolves to an unrelated built-in command. S5.0 remains open
  until CI passes this correction. Affected: S5.0 reproducibility and all later
  root verification gates. Reviewer: delivery review GO.
- 2026-09-15 — Implemented S5.2 strict server configuration and hash-only guest
  session persistence using the existing S4 schema; no new migration was
  necessary. Extended the disposable PostgreSQL harness with a login granted
  only the `loremaster_runtime` group role and proved readiness, identity,
  expiry, isolation, CSRF binding, DDL/content/migration denial, and secret-safe
  failures. Focused config tests, 157 non-database tests, 52 database tests,
  workspace typechecks/builds, formatting, lint, and diff checks pass locally;
  formal progress remains open pending independent review and CI. Affected:
  S5 identity, cookie, configuration, least-privilege, and disclosure controls.
- 2026-09-15 — Implemented S5.3a with pinned Express 5.2.1, an injectable
  operation kernel, server-generated request IDs, conservative response
  headers, exact 16 KiB UTF-8 JSON parsing, recursive duplicate-key detection,
  frozen-contract validation, stable public errors, and success projection
  validation. The focused kernel command passes 11 tests; 168 non-database and
  52 database tests, all workspace typechecks/builds, formatting, lint, and
  diff checks pass locally. The root `pnpm run verify` wrapper remains blocked
  only by the host's stale child-process pnpm shim, so its exact stages were run
  directly. Formal progress remains open pending independent review and CI.
  Affected: S5 parsing, validation, request-ID, disclosure, and kernel-composition
  controls.
- 2026-09-15 — Implemented S5.3b cookie-authentication resolution with injected
  expiry checks, mode-specific issue/clear attributes, exact Origin enforcement,
  session-bound double-submit CSRF, strict JSON integration, and credentialed
  CORS/preflight allowlists without wildcards. Raw authentication tokens and CSRF
  verifier hashes remain outside handler contexts; invalid, expired, and unknown
  credentials share one public response. The focused suite passes 18 tests;
  `pnpm run verify` passes 186 non-database tests plus all workspace formatting,
  lint, typecheck, and build gates; 52 runtime-role database tests and the
  production dependency audit pass. Formal progress remains open pending
  independent review and clean-checkout CI. Affected: S5 authentication, cookie,
  CSRF, Origin/CORS, ownership-disclosure, and transport-policy controls.
- 2026-09-15 — Implemented S5.3c with a shared request/database deadline
  context, deadline-aware parsing and authentication, bounded pool acquisition,
  maximum 1-second lock and 3-second statement limits, pre-commit disconnect
  cancellation by connection destruction, completed rollback/connection-close
  waits, and stable timeout classification. Existing database call forms remain
  compatible while all session, gameplay, profile, and leaderboard operations
  accept the deadline context. Focused API and disposable-PostgreSQL tests cover
  incomplete bodies, pool exhaustion, held locks, long statements, disconnects,
  rollback failure, absence of post-timeout writes, and same-key recovery.
  Formal progress remains open pending independent review and clean-checkout CI.
  Affected: S5 deadline, cancellation, transaction-integrity, idempotency-retry,
  and timeout-disclosure controls.
- 2026-09-15 — Implemented S5.3d with explicit CIDR proxy trust, canonical
  IPv4/IPv6 source identities, right-to-left forwarding-chain resolution, and a
  replica-local fixed-window limiter for the frozen session, mutation, and
  autocomplete guest/IP ceilings. Minute rollover clears state deterministically;
  new identities are rejected at configured hard caps and 429 responses carry an
  integer `Retry-After`. Focused tests cover untrusted forwarding headers,
  left-side spoofing, equivalent IPv6 forms, malformed/oversized chains, storage
  exhaustion, exact category limits, and window expiry. The replica-local
  aggregate weakness is documented in code and must remain as a fallback when a
  shared limiter is added. Formal progress remains open pending independent
  review and clean-checkout CI. Affected: S5 trusted-proxy, abuse-control,
  bounded-memory, availability, and rate-limit response controls.
- 2026-09-15 — Implemented S5.3e with allowlist-only structured request logs,
  fixed metric names and bounded operation/status-class labels, route templates
  sourced only from the frozen operation table, constant unmatched-route labels,
  and capture adapters for disclosure tests. Secret-shaped cookies, raw URLs,
  guesses, identifiers, and arbitrary object properties are absent from captured
  output. Focused telemetry/kernel tests pass 15 tests; all 200 non-database and
  58 database tests, workspace typechecks/builds, formatting, and diff checks
  pass locally. The root wrapper remains affected by the already-recorded host
  pnpm shim defect, so its exact stages were run directly through Corepack; lint
  passed after the final no-op adapter cleanup. Formal completion remains open
  pending independent TypeScript/security review and clean-checkout CI.
  Affected: S5 log/metric disclosure, bounded-cardinality, request-ID, route,
  status, and timing controls.
