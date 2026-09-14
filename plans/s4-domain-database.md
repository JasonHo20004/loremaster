# S4 domain and database construction plan

Status: active. Execution mode: direct changes in the current checkout. The plan is deliberately split into reviewable, independently verifiable slices so a fresh task can execute one slice without loading the entire S4 implementation.

Normative sources: `docs/architecture/game-rules.md`, `docs/architecture/s1-acceptance.md`, ADR 0002/0003, `docs/content-policy.md`, and `docs/threat-model/README.md`.

## Invariants and execution contract

- PostgreSQL is authoritative; Redis/workers are outside S4 correctness.
- ACTIVE/no-case/not-started projections never contain an answer, future evidence, explanations, sources, or another guest's data.
- Publication freezes the revision and every child row; global published windows are exact non-overlapping UTC days.
- Participation, finalization, regional contribution, receipts, and leaderboard inclusion are exactly once.
- A receipt stores a fixed command fingerprint and historical outcome, never a narrative projection, until its guest session expires.
- Original Aster Quay narrative is import-only server data. Domain, contracts, and web cannot import it.
- Each slice has one main output, a focused test command, `pnpm verify`, and a local rollback. Database corrections use forward-compatible migrations; published content is never edited or rolled back in place.

## Dependency graph

```text
S4.1a -> S4.1b -> S4.2a -> S4.6a -> S4.6b -> S4.6c -> S4.6d
                   |          ^        ^        ^
S4.2b -------------+----------|--------|--------+
S4.2c ------------------------|--------|--------+
S4.3a -> S4.3b ---------------+        |        |
      -> S4.3c -------------------------+        |
      -> S4.3d ----------------------------------+
S4.4a -> S4.4b -> S4.5a -> S4.5b
                   |
                   +----------> controlled test seeding for S4.6a
```

S4.3a and S4.4a can start independently of domain work. Gameplay repositories require their named domain/schema inputs, not the operator CLI.

## S4.1a — Domain primitives and scoring

Context: implement deterministic values only in `packages/domain`; callers supply elapsed milliseconds. No clock, persistence, content, IDs, or HTTP concerns.

- Define reachable attempt primitives, terminal outcomes, evidence ranks, and score breakdowns.
- Calculate boundary-exact time bonus and SOLVED-only score; reject invalid/unreachable counters.
- Cover B01–B02 and arithmetic portions of T04/T21.

Verify: focused scoring tests, domain typecheck, `pnpm verify`. Exit: only a valid SOLVED snapshot can be scored. Rollback: remove the scoring module/tests and restore the barrel.

## S4.1b — State transitions and reachable-state tests

Context: build on S4.1a. Ownership, eligibility, time, expected version, and idempotency are repository concerns; this slice transforms a validated ACTIVE snapshot without mutation.

- Implement correct/wrong guess, reveal, give-up, exhaustion, expiry, and typed rejection of terminal commands.
- Enforce reachable `(e,w,W,state)` combinations and maximum W=15 at the domain boundary.
- Cover pure portions of T05–T12/T15/T20/T21 with tables and property-style sequences.

Verify: focused transition tests, domain typecheck, `pnpm verify`. Exit: transitions cannot create or accept an impossible snapshot. Rollback: remove transition exports/tests without touching persistence.

## S4.2a — Allowlisted public projections

Context: projection inputs may include private content, but outputs use discriminated allowlists rather than row serialization/deletion. Narrative remains outside `packages/domain` as test abstractions.

- Define no-case, not-started, ACTIVE, and terminal projections.
- ACTIVE exposes briefing, evidence `1..e`, public suggestions, own history/counters only; terminal exposes answer, four explanations, and internal sources.
- Assert recursive answer/future-evidence absence, cross-guest isolation, and no-case confidentiality (B13); defer built-bundle proof to S6/S8.

Verify: projection tests and an import-boundary test, domain typecheck, `pnpm verify`. Exit: private fields are structurally absent from ACTIVE types. Rollback: remove projection module/tests.

## S4.2b — Profile and regional knowledge math

Context: pure functions consume finalized outcomes and UTC participation days. Persistence uniqueness comes in S4.3d/S4.6c.

- Calculate current/longest streak, solved/failed counts, and half-up accuracy.
- Calculate exact regional alpha/beta deltas and half-up display percentage without per-update rounding.
- Cover B05–B06 arithmetic, B08–B10, multi-region de-duplication, and no-sample 50%.

Verify: focused aggregate tests, domain typecheck, `pnpm verify`. Exit: aggregate math is deterministic and precision-safe. Rollback: remove aggregate module/tests.

## S4.2c — Leaderboard ordering and competition rank

Context: ranking uses `(e,W,elapsed_ms)` independently of score; immutable attempt ID only stabilizes display inside exact ties.

- Implement comparison, pagination order, and competition ranks `1,1,3`.
- Exclude ACTIVE and failed outcomes by accepted input type.
- Cover B03–B04 and zero-score SOLVED eligibility.

Verify: focused ranking tests, domain typecheck, `pnpm verify`. Exit: ties never use score or ID to change rank. Rollback: remove ranking module/tests.

## S4.3a — Pinned PostgreSQL toolchain and test harness

Context: establish database infrastructure before schema. It must run locally and in untrusted CI with no cloud credentials and must never silently skip.

- Pin the PostgreSQL version/container image (including digest), query/migration dependencies, and lockfile.
- Add distinct migration, importer, and runtime roles; only migration can create extensions/DDL.
- Add one stable root command that starts disposable PostgreSQL, migrates, tests, and tears down; make CI run it with ephemeral non-secret credentials and fail clearly when prerequisites are missing.

Verify: empty-DB migration smoke locally and in Quality CI, then `pnpm verify`. Exit: a clean database test is reproducible. Rollback: remove harness/workflow additions and dependencies; no persistent DB is touched.

## S4.3b — Immutable revision and content schema

Context: PostgreSQL enforces publication integrity even if validators/importers are bypassed. Eligible catalog/name/role/aliases/regions/evidence/sources must be revision-scoped snapshots or immutable versioned references.

- Add content/revision tables and restrictive attempt FK, using `timestamptz` windows.
- Check open at 00:00 UTC, close=open+1 day, open<close; add global published-only `[)` exclusion with adjacent days allowed.
- Freeze answer/window/publication and reject INSERT/UPDATE/DELETE on every frozen child after publication, including concurrent writes.

Verify: B11–B12 constraint/concurrency tests against clean PostgreSQL, then `pnpm verify`. Exit: SQL alone protects exact UTC slots and the full published graph. Rollback: disposable DB reset or forward-compatible schema migration only.

## S4.3c — Guest, session, attempt, guess, and receipt schema

Context: store only session token hashes. Receipt identity is guest-scoped, has a canonical fixed fingerprint, stores a historical command outcome (not content/projection), and cannot be deleted while its identity authenticates.

- Add guest/session expiry, attempts, guesses, version bounds, and unique `(guest_id,slot_id)` start.
- Add receipt unique `(guest_id,idempotency_key)`, fixed fingerprint representation, outcome fields, and retention constraints compatible with 30-day absolute sessions.
- Add indexes/checks for ownership, slot-ordered reconciliation, W/e/w bounds, and safe lock access.

Verify: constraint and retention tests on clean PostgreSQL, then `pnpm verify`. Exit: invalid identities/attempt counters/replay rows are rejected. Rollback: disposable reset or forward schema correction.

## S4.3d — Exactly-once effect ledgers

Context: constraints are the final retry/race guard; regional values use exact `NUMERIC` or fixed integer units, never floating point.

- Add one finalization marker per attempt and participation unique `(guest_id,utc_day)`.
- Add knowledge contribution unique `(attempt_id,region_id)` and aggregate storage with exact precision.
- Add leaderboard uniqueness by attempt and `(guest_id,slot_id)`, solved-only checks, and pseudonym-only public row fields.

Verify: duplicate/concurrent insertion tests, exact precision tests, `pnpm verify`. Exit: every authoritative effect is schema-protected exactly once. Rollback: disposable reset or forward schema correction.

## S4.4a — Bounded content pack schema and diagnostics

Context: define numeric bounds before S5 for IDs, aliases, names, roles, briefing, evidence, explanations, provenance, source IDs, and cardinalities. Diagnostics report stable code/path only and never echo narrative.

- Record explicit limits in the schema and supporting documentation; validate all fields and exact four evidence orders.
- Reject unknown answer/region IDs, ambiguous aliases, duplicates, unsafe markup, external URLs, unknown provenance, and non-UTC-day windows.
- Return all independently detectable errors deterministically; normalize or reject duplicate regions per one documented rule.

Verify: focused valid/invalid/determinism tests, database package typecheck, `pnpm verify`. Exit: validation is bounded and safe to log by code/path. Rollback: remove validator/schema/tests.

## S4.4b — Aster Quay server-only fixture

Context: implement exactly the original pack in `docs/content-policy.md`; never read narrative from the historical Riot-inspired document.

- Store Aster Quay under the database importer boundary with authorship/provenance/version/source identifiers.
- Enforce dependency rules preventing `apps/web`, `packages/contracts`, and `packages/domain` from importing server content.
- Add source/build-context allowlist checks excluding the historical document and private pack sources; explicitly defer bundle/deployment artifact proof to S6/S8.

Verify: fixture validation plus boundary scans/tests, `pnpm verify`. Exit: the approved fixture is importable but unavailable to browser/domain builds. Rollback: remove fixture/boundary test.

## S4.5a — Transactional draft and publication repository

Context: combine S4.3b with S4.4. Validation and write/publication occur as one transaction; exclusion constraints arbitrate concurrency.

- Implement draft insert and atomic publication through the importer role.
- Map constraint failures to stable diagnostics without returning narrative or raw SQL parameters.
- Test success, malformed rollback, duplicate/re-import, immutable children, and concurrent overlap.

Verify: focused importer integration tests on clean PostgreSQL, `pnpm verify`. Exit: no partial or overlapping publication is possible. Rollback: drafts only may be removed in disposable/local DB; published corrections require a new revision in a future unused slot.

## S4.5b — Dry-run and operator CLI

Context: CLI is local/operator-only, never an HTTP route. Dry-run may query authoritative overlap state but never writes.

- Add bounded file input, dry-run, machine-readable exit status, and redacted diagnostics.
- Exercise no-write dry-run, invalid files, connection/constraint failures, and successful operator flow.
- Document narrow credentials and a future-slot correction procedure.

Verify: CLI/integration tests, `pnpm verify`. Exit: operation is all-or-nothing and repeatable without content logging. Rollback: remove CLI entry/documentation; never mutate published rows.

## S4.6a — Current-slot, start, and owned read transactions

Context: expose repository transactions for S5, not HTTP handlers. Controlled test seeding can bypass the CLI but must use valid frozen revisions.

- Read current published slot without creating an attempt; implement unique guest/slot start and same-attempt refresh.
- Return allowlisted S4.2a projections and verify attempt-to-revision immutability.
- Cover DB portions of T01–T03/T22/T24/T25; token/cookie/session E2E remains S5.

Verify: focused repository integration tests, `pnpm verify`. Exit: reads cannot start clocks or cross guests. Rollback: remove repository module/tests.

## S4.6b — Locked commands, versions, and idempotency

Context: lock guest/profile before attempt, then sample PostgreSQL `clock_timestamp()` after locks (`now()` is forbidden). Unique receipts arbitrate retries; HTTP mapping remains S5.

- Implement guess/reveal/give-up with eligible-ID check, expected version, fingerprinted receipt, and atomic history/effect writes.
- Test same/different-key replay, same-version races, repeated wrong guesses, ownership, and lock-at-close expiry.
- Cover DB portions of T05–T13/T15/T17–T20/T23/T24; malformed JSON/type/Origin/CSRF/content-type tests remain S5.

Verify: focused race/integration tests with bounded locks, `pnpm verify`. Exit: no stale/replayed command applies twice and a lock acquired at close expires first. Rollback: remove repository commands/tests; forward schema correction only.

## S4.6c — Expiry and exactly-once finalization

Context: use the same guest/profile-before-attempt lock order and slot ordering for reconciliation. All profile, participation, regional, and leaderboard effects commit with finalization.

- Implement lazy read expiry and profile reconciliation using post-lock database time.
- Apply S4.2b/S4.2c math through S4.3d ledgers for solve/failure exactly once.
- Test T04/T09/T11–T15/T21/T23 and persistent portions of B05–B10 under retries/concurrency.

Verify: focused reconciliation/race tests, `pnpm verify`. Exit: retries cannot duplicate any terminal effect. Rollback: remove orchestration code/tests; do not delete published/outcome history outside disposable DBs.

## S4.6d — Layered acceptance and S4 exit

Context: close only S4-assigned proofs. Do not claim S5 transport/session security or S6/S8 bundle proofs.

- Build an acceptance matrix splitting every T01–T25/B01–B13 assertion into pure S4, DB S4, and deferred S5/S6/S8 portions.
- Run from a clean disposable DB, concurrency suite, answer-absence/import-boundary scans, and full verification with no silent skips.
- Write `docs/architecture/s4-acceptance.md` and update README status only when every S4 matrix cell has executable evidence.

Verify: stable root database test command, `pnpm verify`, CI evidence. Exit: S5 can consume transaction APIs and deferred proofs are explicit. Rollback: documentation/status only; schema remains forward-managed.

## Plan mutation protocol

If a slice still exceeds one focused review, split it with another suffix before coding and update the graph. New product/security invariants require an ADR or normative-doc update first. Mark progress only after focused tests, typecheck, full verification, and review all pass.

## Progress

- [x] S4.1a Domain primitives and scoring — 2026-09-11; focused domain tests and full gate passed.
- [x] S4.1b State transitions and reachable-state tests — 2026-09-11; reachable-state validation and acceptance sequences passed review.
- [x] S4.2a Allowlisted public projections — 2026-09-12; ownership/revision guards, recursive disclosure tests, boundary scan, review, and full gate passed.
- [x] S4.2b Profile and regional knowledge math — 2026-09-13; focused aggregate tests, domain typecheck, review, and full gate passed.
- [x] S4.2c Leaderboard ordering and competition rank — 2026-09-13; focused ranking tests, domain typecheck, review, and full gate passed.
- [x] S4.3a Pinned PostgreSQL toolchain and test harness — 2026-09-13; pinned disposable PostgreSQL, least-privilege roles, clean migration command, and Quality CI gate passed.
- [x] S4.3b Immutable revision and content schema — 2026-09-13; exact UTC exclusion, restrictive attempt FK, graph completeness, freeze triggers, and publication race passed.
- [x] S4.3c Guest/session/attempt/guess/receipt schema — 2026-09-13; identity, reachability, eligibility, fingerprint, immutable receipt, and retention constraints passed.
- [x] S4.3d Exactly-once effect ledgers — 2026-09-13; duplicate/concurrent effects, solved-only consistency, and exact numeric precision passed.
- [x] S4.4a Bounded content pack schema and diagnostics — 2026-09-13; bounded strict validation, redacted deterministic diagnostics, and invalid-pack coverage passed.
- [x] S4.4b Aster Quay server-only fixture — 2026-09-13; original fixture validation, source boundaries, and public build-context allowlist passed.
- [x] S4.5a Transactional draft and publication repository — 2026-09-13; importer-role atomic graph writes, redacted constraint mapping, rollback, immutability, re-import, and publication races passed.
- [x] S4.5b Dry-run and operator CLI — 2026-09-13; bounded files, read-only authoritative dry-run, machine-readable exits, compiled operator flow, and credential guidance passed.
- [x] S4.6a Current-slot, start, and owned read transactions — 2026-09-14; allowlisted reads, immutable-revision starts, ownership isolation, and concurrent start tests passed.
- [x] S4.6b Locked commands, versions, and idempotency — 2026-09-14; guest-before-attempt locking, post-lock database time, canonical receipts, replay, version races, and command transitions passed.
- [x] S4.6c Expiry and exactly-once finalization — 2026-09-14; lazy reconciliation, exact regional effects, profiles, score, and competition leaderboard persistence passed under retries and contention.
- [x] S4.6d Layered acceptance and S4 exit — 2026-09-14; 47 clean PostgreSQL tests, 135 non-database tests, boundary scans, full local gates, and review passed with S5/S6/S8 deferrals recorded.
