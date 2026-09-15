# S5 API transport acceptance record

Recorded 2026-09-15. This record closes only locally executable S5 transport
claims. `PASS` means the S5-owned behavior has executable local evidence;
`PARTIAL` names evidence still owned by a later stage; `DEFERRED (owner)` is not
part of the S5 exit claim. Independent review and clean-checkout CI are still
pending, so the S5 plan remains formally open.

## Gameplay transitions

| ID | S5 transport evidence | Status |
| --- | --- | --- |
| T01 | `tests/database/gameplay-repository.test.ts` (NO_CASE/no effects); `tests/api/gameplay-routes.test.ts` (validated route mapping); `tests/api/composition.database.test.ts` (composed current-case boundary). | PASS |
| T02 | `tests/database/gameplay-repository.test.ts` (one attempt under repeated/concurrent starts); `tests/api/adversarial.database.test.ts` (canonical start replay through HTTP). | PASS |
| T03 | Database refresh persistence is covered by `tests/database/gameplay-repository.test.ts`; the real browser refresh journey remains outside S5. | DEFERRED (S6) |
| T04 | `tests/domain/attempt-engine.test.ts` (30-second score); `tests/database/gameplay-repository.test.ts` (atomic persisted effects); `tests/api/gameplay-routes.test.ts` and `tests/contracts/api-contract.test.ts` (result projection/status). | PASS |
| T05 | `tests/domain/attempt-engine.test.ts` and `tests/database/gameplay-repository.test.ts` (two accepted wrong guesses); `tests/api/gameplay-routes.test.ts` (validated command adapter). | PASS |
| T06 | `tests/database/gameplay-repository.test.ts` (third wrong guess advances exactly one level); `tests/api/gameplay-routes.test.ts` (command outcome mapping). | PASS |
| T07 | `tests/database/gameplay-repository.test.ts` (manual reveal without participation); `tests/api/gameplay-routes.test.ts` (reveal command transport). | PASS |
| T08 | `tests/domain/attempt-engine.test.ts` and `tests/database/gameplay-repository.test.ts` (reachable level-four limit); `tests/api/gameplay-routes.test.ts` (ACTIVE projection). | PASS |
| T09 | `tests/database/gameplay-repository.test.ts` (fifteenth wrong guess and exactly-once finalization); `tests/contracts/api-contract.test.ts` (terminal response). | PASS |
| T10 | `tests/domain/attempt-engine.test.ts` and `tests/database/gameplay-repository.test.ts` (level-four reveal rejected without receipt); `tests/contracts/api-contract.test.ts` (frozen conflict mapping). | PASS |
| T11 | `tests/domain/attempt-engine.test.ts` and `tests/database/gameplay-repository.test.ts` (give-up without participation); `tests/api/gameplay-routes.test.ts` (give-up transport). | PASS |
| T12 | `tests/database/gameplay-repository.test.ts` (prior participation preserved exactly once); `tests/api/gameplay-routes.test.ts` (command transport). | PASS |
| T13 | `tests/database/gameplay-repository.test.ts` proves post-lock database time and expiry; `tests/api/adversarial.database.test.ts` proves a held-lock HTTP timeout rolls back and permits same-key recovery. The literal arrives-before-close/acquires-at-close transport race is not isolated as its own HTTP test. | PARTIAL |
| T14 | `tests/database/gameplay-repository.test.ts` proves owned/profile lazy reconciliation; `tests/api/reporting-routes.test.ts` and `tests/api/composition.database.test.ts` exercise the profile boundary. | PASS |
| T15 | `tests/database/gameplay-repository.test.ts` proves terminal stability; `tests/api/adversarial.database.test.ts` proves terminal mutations and suggestions use the non-disclosing denied shape. | PASS |
| T16 | `tests/api/adversarial.database.test.ts` rejects malformed/duplicate JSON, types, fields, content type, Origin, CSRF, repeated inputs, encoded paths and oversized bodies before any attempt, version or receipt mutation. | PASS |
| T17 | `tests/contracts/api-contract.test.ts` freezes canonical identity; `tests/database/gameplay-repository.test.ts` and `tests/api/adversarial.database.test.ts` prove identical committed replay without re-execution. | PASS |
| T18 | `tests/database/gameplay-repository.test.ts` and `tests/api/adversarial.database.test.ts` prove changed-payload/key conflict without mutation. | PASS |
| T19 | `tests/database/gameplay-repository.test.ts` and `tests/api/adversarial.database.test.ts` prove only one same-version command commits. | PASS |
| T20 | `tests/domain/attempt-engine.test.ts` and `tests/database/gameplay-repository.test.ts` prove repeated wrong entities with fresh keys consume guesses; `tests/api/gameplay-routes.test.ts` validates the HTTP command tuple. | PASS |
| T21 | `tests/domain/attempt-engine.test.ts` and `tests/database/gameplay-repository.test.ts` prove the 940 score and exact regional effect; `tests/contracts/api-contract.test.ts` validates the public result. | PASS |
| T22 | Immutable revision rollover is covered by `tests/database/gameplay-repository.test.ts`; the browser rollover journey remains outside S5. | DEFERRED (S6) |
| T23 | `tests/database/gameplay-repository.test.ts` proves the historical outcome/reconciled projection split; `tests/contracts/api-contract.test.ts` freezes it and `tests/api/adversarial.database.test.ts` exercises HTTP replay. | PASS |
| T24 | `tests/database/gameplay-repository.test.ts`, `tests/api/gameplay-routes.test.ts`, and the two-cookie-jar journeys in `tests/api/adversarial.database.test.ts` prove cross-guest reads, receipts, mutations and suggestions do not disclose ownership. | PASS |
| T25 | Local no-synthetic-attempt behavior is covered by `tests/database/gameplay-repository.test.ts`; scheduled/deployed closed-slot observation remains outside S5. | DEFERRED (S8) |

## Boundaries and integrity

| ID | S5 transport evidence | Status |
| --- | --- | --- |
| B02 | `tests/domain/leaderboard.test.ts` and `tests/database/gameplay-repository.test.ts` keep zero-score SOLVED attempts eligible; `tests/api/reporting-routes.test.ts` preserves repository rows in the response. | PASS |
| B03 | `tests/domain/leaderboard.test.ts` and `tests/database/gameplay-repository.test.ts` prove performance ordering; `tests/api/reporting-routes.test.ts` proves cursor pagination. | PASS |
| B04 | `tests/domain/leaderboard.test.ts` and `tests/database/gameplay-repository.test.ts` prove competition ranks and stable tie ordering; `tests/api/reporting-routes.test.ts` proves authenticated cursor continuation/tamper rejection. | PASS |
| B05 | `tests/domain/aggregates.test.ts` and `tests/database/gameplay-repository.test.ts` prove exact 2.70/2.30 and 54%; `tests/api/reporting-routes.test.ts` returns the reconciled profile unchanged. | PASS |
| B06 | `tests/domain/aggregates.test.ts` and `tests/database/gameplay-repository.test.ts` prove exact 2.70/3.30 and 45% without duplication; `tests/api/reporting-routes.test.ts` preserves the values. | PASS |
| B08 | `tests/domain/aggregates.test.ts` and `tests/database/gameplay-repository.test.ts` prove participation-day streaks; `tests/api/reporting-routes.test.ts` proves the profile JSON boundary. | PASS |
| B09 | `tests/domain/aggregates.test.ts` and `tests/database/gameplay-repository.test.ts` prove streak two/zero accuracy; `tests/api/reporting-routes.test.ts` preserves the projection. | PASS |
| B10 | `tests/domain/aggregates.test.ts` and `tests/database/gameplay-repository.test.ts` prove 67% and ACTIVE omission; `tests/api/reporting-routes.test.ts` preserves the projection. | PASS |
| B13 | `tests/domain/projections.test.ts`, `tests/contracts/api-contract.test.ts`, `tests/api/disclosure.test.ts`, and `tests/api/adversarial.database.test.ts` prove the server/API boundary excludes answers, future evidence, fixtures, raw content and high-cardinality telemetry. Compiled browser bundle/source-map proof remains with S6 and deployed-artifact proof with S8. | PARTIAL |

## Threat-model controls

| Threat/control | Executable evidence and remaining owner | Status |
| --- | --- | --- |
| Answer or future evidence disclosure | `tests/domain/projections.test.ts`, `tests/contracts/api-contract.test.ts`, `tests/api/disclosure.test.ts`, `tests/api/telemetry.test.ts`, `tests/observability/capture.test.ts`, and `tests/api/adversarial.database.test.ts` cover server/API JSON, errors, code boundaries and telemetry. Browser bundle/source-map and deployed scans remain S6/S8; shared-cache isolation remains S12. | PARTIAL |
| Replay or changed-body key reuse | `tests/database/gameplay-repository.test.ts` and `tests/api/adversarial.database.test.ts` cover canonical replay, changed payload, expired identity and cross-guest denial. | PASS |
| Concurrent commands or expiry | `tests/database/schema.test.ts`, `tests/database/gameplay-repository.test.ts`, `tests/database/transaction-timeout.test.ts`, and `tests/api/adversarial.database.test.ts` cover uniqueness, serialization, post-lock time, timeout rollback and recovery. The literal exact-close HTTP race remains the T13 partial above. | PARTIAL |
| Brute force or account farming | `tests/domain/attempt-engine.test.ts`, `tests/database/gameplay-repository.test.ts`, `tests/api/rate-limit.test.ts`, and `tests/api/adversarial.database.test.ts` cover gameplay ceilings, generic denial, trusted-source limits and bounded identity storage. Disposable-identity Sybil abuse remains an accepted residual risk. | PASS |
| Stolen session, CSRF or client identity | `tests/database/session-repository.test.ts`, `tests/api/auth-policy.test.ts`, `tests/api/gameplay-routes.test.ts`, and `tests/api/adversarial.database.test.ts` cover hash-only tokens, exact Origin, session-bound CSRF, server-selected identity and two-guest ownership. | PASS |
| XSS through names or lore | Contract/import bounds and CSP/security-header tests pass in `tests/contracts/api-contract.test.ts`, `tests/database/content-import.test.ts`, and `tests/api/kernel.test.ts`. Rendering hostile text inert remains an S6 browser journey. | PARTIAL |
| Malicious import or changed opened answer | `tests/database/content-import.test.ts`, `tests/database/schema.test.ts`, `tests/database/session-repository.test.ts`, and `tests/api/disclosure.test.ts` prove transactional validation, immutable publication, narrow runtime privilege and no public importer route. | PASS |
| SSRF through source/asset URL | `tests/api/disclosure.test.ts` statically rejects URL-fetch paths and content/import dependencies in the API and public package exports. | PASS |
| Secrets from PR, config or logs | `tests/config/server-environment.test.ts`, telemetry/capture tests, S3 read-only CI configuration, and the local source/history scan below cover S5. The authoritative CI history scan is still pending; constrained cloud OIDC remains S11. | PARTIAL |
| Redis outage or poisoned/replayed cache work | S5 keeps PostgreSQL authoritative and documents the bounded local rate-limit fallback. Queue/cache behavior does not exist in S5. | DEFERRED (S7) |
| Cloud origin, cost or destroy failure | S5 production configuration rejects unsafe origin/cookie settings, but origin restriction, admission and independent cleanup are cloud/deployment claims. | DEFERRED (S11/S12) |

## Verification record

All counts are from clean commands run locally on 2026-09-15. Docker being
unavailable is a hard failure in both database harnesses; neither suite has a
skip path.

| Suite/gate | Result |
| --- | --- |
| Unit/contract/kernel/static aggregate (`pnpm test` stages) | 223 tests in 22 files, PASS |
| Non-database aggregate | 223 tests in 22 files, PASS |
| Repository/database (`pnpm test:database`) | 59 tests in 5 files against clean PostgreSQL 17.6, PASS |
| Composed HTTP/PostgreSQL (`pnpm test:api:database`) | 7 tests in 2 files (1 smoke + 6 adversarial), PASS |
| Race evidence | 1 composed same-version HTTP race journey plus 6 named repository/schema/import concurrency tests within the database aggregate, PASS; exact-close HTTP timing remains T13 PARTIAL |
| Timeout evidence | 3 request-deadline tests + 6 database transaction-timeout tests + 1 composed held-lock timeout/recovery journey, PASS |
| Rate-limit evidence | 7 focused policy tests + 1 composed forged-forwarding/bounded-identity journey, PASS |
| Disclosure evidence | 6 focused static/telemetry/capture tests + 1 composed capture scan, PASS; browser/deployed scans remain B13 PARTIAL |
| Formatting, lint, 10 workspace typechecks, 10 workspace builds, diff check | PASS by direct pinned stages |
| Dependency audit | `pnpm audit --audit-level moderate`: no known vulnerabilities |
| Production runtime licenses | MIT, ISC and BSD-3-Clause only; direct runtime dependencies Express 5.2.1, pg 8.16.3 and Zod 4.6.4 are MIT |
| Lockfile review | No uncommitted `pnpm-lock.yaml` change in the S5.7/S5.8 acceptance diff |
| Local secret scan | Zero high-confidence AWS/GitHub/Slack/Google token or private-key signatures in the working tree and full Git patch history; only tracked env/key-named file is the placeholder-only environment test |
| Clean-checkout CI and independent review | PENDING; therefore formal S5 exit is not claimed |

The exact root `pnpm run verify` wrapper remains affected on this Windows host by
the previously recorded stale global pnpm child-process shim. Its five pinned
constituent stages all pass directly; clean-checkout CI remains the authoritative
wrapper proof.

## S6 handoff

S6 may consume only the browser-safe exports from `@loremaster/contracts` and
the frozen `/api/v1` base behavior. It must not import `apps/api`,
`@loremaster/database`, the operator importer, authored fixtures, answers,
explanations or sources. Cookie/CSRF, CORS, status/error, cursor, replay and
timeout behavior are stable inputs to the web client. S6 still owns real browser
refresh and rollover journeys (T03/T22), hostile-text inert rendering, and
compiled browser bundle/source-map disclosure scans. S8 owns T25 scheduled
closed-slot observation and deployed-artifact scans.
