# S4 domain and database acceptance record

Date: 2026-09-14. Scope: pure domain rules, immutable content persistence,
operator import, and PostgreSQL gameplay transactions. The executable database
evidence runs only through `pnpm test:database` against a clean disposable
PostgreSQL instance; a missing database prerequisite is a failure, never a skip.

This record deliberately does not claim HTTP, cookie, browser-build, deployment,
or cloud evidence assigned to later stages.

## Gameplay transitions

| ID | S4 assertion | Executable S4 evidence | Deferred evidence | Status |
| --- | --- | --- | --- | --- |
| T01 | A missing published slot reads and starts as no-case without effects. | `tests/database/gameplay-repository.test.ts`. | HTTP response mapping in S5. | PASS |
| T02 | Repeated and concurrent starts create one ACTIVE attempt with one database start time. | `tests/database/gameplay-repository.test.ts`. | Cookie/session issuance in S5. | PASS |
| T03 | Refresh preserves attempt identity, counters, version, and start time. | `tests/database/gameplay-repository.test.ts`. | Browser refresh journey in S6. | PASS |
| T04 | The 30-second boundary scores 1350; solving persists the domain score, participation, and finalization once. | Boundary in `tests/domain/attempt-engine.test.ts`; persisted score/effects in `tests/database/gameplay-repository.test.ts`. | HTTP timing integration in S5. | PASS |
| T05 | Two wrong guesses at one level persist two accepted guesses and reachable counters. | Domain transition table and `tests/database/gameplay-repository.test.ts`. | Request validation in S5. | PASS |
| T06 | A third wrong guess advances exactly one evidence level and resets the per-level counter. | Domain transition table and `tests/database/gameplay-repository.test.ts`. | HTTP mapping in S5. | PASS |
| T07 | Manual reveal advances one level without a guess or participation. | Domain transition table and `tests/database/gameplay-repository.test.ts`. | HTTP mapping in S5. | PASS |
| T08 | The second wrong guess at level four remains ACTIVE at the reachable limit. | Domain transition table and `tests/database/gameplay-repository.test.ts`. | HTTP mapping in S5. | PASS |
| T09 | The final wrong guess exhausts and finalizes all failed effects once. | Domain transition table and `tests/database/gameplay-repository.test.ts`. | HTTP response mapping in S5. | PASS |
| T10 | Reveal at level four is rejected without mutation or receipt. | Pure rejection and `tests/database/gameplay-repository.test.ts`. | HTTP conflict mapping in S5. | PASS |
| T11 | Give-up without guesses finalizes failure without participation. | Pure transition and `tests/database/gameplay-repository.test.ts`. | HTTP response mapping in S5. | PASS |
| T12 | Give-up after a guess preserves the unique participation day. | `tests/database/gameplay-repository.test.ts`. | HTTP response mapping in S5. | PASS |
| T13 | Database time is sampled after the contended attempt lock; a command acquiring a closed attempt expires it before applying the requested guess. | Bounded lock-contention test in `tests/database/gameplay-repository.test.ts`. | Literal request-arrives-before-midnight/acquires-at-midnight transport race in S5. | PASS |
| T14 | Owned and profile reads lazily expire and finalize once. | Owned-read and profile-only reconciliation tests in `tests/database/gameplay-repository.test.ts`. | HTTP profile integration in S5. | PASS |
| T15 | Terminal reads are stable and terminal mutations add no effects. | Pure rejection and database repository tests. | HTTP conflict mapping in S5. | PASS |
| T16 | Unknown or ineligible entity IDs create no gameplay effects. | `tests/database/gameplay-repository.test.ts`. | Malformed JSON, wrong type, Origin, CSRF, and content-type validation in S5. | PASS |
| T17 | An identical committed key and canonical payload replays without re-execution. | `tests/database/gameplay-repository.test.ts`. | HTTP receipt representation in S5. | PASS |
| T18 | Reusing a committed key with a different fingerprint conflicts without mutation. | `tests/database/gameplay-repository.test.ts`. | HTTP conflict mapping in S5. | PASS |
| T19 | Same-version command races serialize; only one transition commits. | `tests/database/gameplay-repository.test.ts`. | Two-client transport race in S5. | PASS |
| T20 | A repeated wrong entity with new keys and current versions consumes separate guesses. | Pure transition and `tests/database/gameplay-repository.test.ts`. | HTTP request journey in S5. | PASS |
| T21 | Automatic evidence advance followed by solve produces score 940 and one regional effect. | Pure scoring/transition and exact persistence tests. | HTTP timing integration in S5. | PASS |
| T22 | Slot rollover selects the current slot while an old attempt remains bound to and expires against its immutable revision. | `tests/database/gameplay-repository.test.ts`. | Browser rollover journey in S6. | PASS |
| T23 | A historical successful receipt retains its outcome while replay returns the reconciled terminal projection. | `tests/database/gameplay-repository.test.ts`. | HTTP replay representation in S5. | PASS |
| T24 | Owned reads and guest-scoped receipts do not disclose another guest's state. | Projection ownership, schema composite-FK, and repository tests. | Independent browser-session isolation in S5/S8. | PASS |
| T25 | A closed slot that was never started creates no synthetic attempt or effects. | `tests/database/gameplay-repository.test.ts`. | Scheduled production observation in S8. | PASS |

## Boundaries and integrity

| ID | S4 assertion | Executable S4 evidence | Deferred evidence | Status |
| --- | --- | --- | --- | --- |
| B01 | Time-bonus boundaries are exact. | `tests/domain/attempt-engine.test.ts`. | None. | PASS |
| B02 | A zero-score SOLVED attempt is valid and leaderboard eligible. | Domain scoring/ranking and persisted leaderboard tests. | API presentation in S5. | PASS |
| B03 | Leaderboard order uses evidence, wrong guesses, and elapsed time rather than score. | `tests/domain/leaderboard.test.ts` and persisted leaderboard tests. | API pagination contract in S5. | PASS |
| B04 | Exact ties use competition ranks and attempt ID only for stable display order. | Domain and persisted competition-rank tests. | API cursor encoding in S5. | PASS |
| B05 | A fresh-region e=1/W=3 solve produces exact alpha 2.70, beta 2.30, and 54%. | `tests/domain/aggregates.test.ts` and exact database numeric assertions. | Profile JSON contract in S5. | PASS |
| B06 | A subsequent failure produces exact alpha 2.70, beta 3.30, and 45% without retry duplication. | Domain aggregate and database finalization tests. | Profile JSON contract in S5. | PASS |
| B07 | Each distinct imported region receives one contribution per finalized attempt. | Content validation and database ledger tests. | None. | PASS |
| B08 | Participation-only UTC days determine the current streak. | Domain aggregate and persisted profile tests. | HTTP profile integration in S5. | PASS |
| B09 | Two participation days and two failures produce streak two and zero accuracy. | Domain aggregate and persisted profile tests. | HTTP profile integration in S5. | PASS |
| B10 | Two solves and one failure round to 67%; ACTIVE attempts are omitted. | Domain aggregate and persisted profile tests. | HTTP profile integration in S5. | PASS |
| B11 | Adjacent windows succeed and concurrent global overlap fails. | `tests/database/schema.test.ts` and `tests/database/content-import.test.ts`. | None. | PASS |
| B12 | Published revision graphs are immutable and existing attempts remain bound to them. | Schema, content-import, and gameplay owned-read tests. | None. | PASS |
| B13 | ACTIVE level-two output recursively excludes the answer, future evidence, explanations, and sources. | Projection tests, content boundary scan, and repository read tests. | Compiled browser bundle/source-map and deployed-artifact scans in S6/S8. | PASS |

B14 and B15 are cloud cost-admission assertions assigned to S11/S12 and are not
part of the S4 exit claim.

## Verification record

- Consecutive clean disposable PostgreSQL runs passed all 47 database tests,
  including bounded lock-contention and concurrency cases.
- All 135 non-database tests passed, including domain arithmetic, transition,
  projection, ranking, content-validation, and import-boundary coverage.
- Formatting, ESLint, every workspace TypeScript check/build, and
  `git diff --check` passed with the pinned local tool versions.
- Review found no critical security issue. Canonical receipt fingerprints,
  stored-outcome narrowing, strict calendar validation, and previously missing
  reconciliation/replay proofs were added before this record was closed.

S4 exit: PASS. S5 can consume the typed database transaction APIs; all remaining
transport and browser/deployment confidentiality proofs are explicit above.
