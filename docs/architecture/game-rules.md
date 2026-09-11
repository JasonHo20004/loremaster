# Authoritative game rules

Normative S1 baseline, 2026-09-11; decisions [0002](../adr/0002-game-integrity.md) and [0003](../adr/0003-identity-and-transactions.md). S4/S5 must turn the acceptance examples into automated tests.

## Case and time model

One global daily slot is a UTC calendar day, with `opens_at` at 00:00 UTC and `closes_at` at the next 00:00 UTC. Availability is `opens_at <= server_now < closes_at`; no-case is a valid response when no published slot exists. No job is needed to open a case. Adjacent windows are allowed; overlapping windows across all packs/revisions are rejected by a database constraint, including concurrent imports.

Publishing freezes a revision's answer, eligible entities/aliases, briefing, four evidence texts, explanations, regions and window. An attempt references that exact revision. Drafts may be edited; a published revision may not be overwritten, rescheduled or deleted. Corrections create a new revision for a future unused slot. There is no in-place hotfix to an opened case; any emergency withdrawal requires a superseding ADR.

`POST start` creates at most one attempt per guest and slot, returning briefing and `started_at`. Start is explicit so prefetch/refresh does not start a clock. Its server timestamp approximates briefing display; network latency is included. Reading a case never creates an attempt. Time is elapsed server milliseconds, never paused by navigation, refresh or inactivity.

States: `ACTIVE`, `SOLVED`, `GIVEN_UP`, `EXHAUSTED`, `EXPIRED`. No-case and not-started are view conditions, not persisted attempt states. All but ACTIVE are terminal. Fields include evidence level `e` (0–4), wrong guesses at that level `w` (0–2 while ACTIVE), total wrong guesses `W`, version, timestamps and terminal outcome. Briefing is level 0. A manual reveal discards unused guesses at the previous level.

## Transition table

Rules are evaluated after guest ownership validation, idempotency resolution and acquiring the attempt lock. Sample database wall-clock time after the lock; a request arriving before close but obtaining the lock at close expires. Requests serialize by lock order, not browser click time. Successful mutations require the current expected attempt version; a distinct stale command returns conflict without consuming a guess.

| From / guard | Command | Outcome and effects |
| --- | --- | --- |
| No open slot | Read or start current | No-case; no attempt, timer or profile effect |
| Open slot, no attempt | Start | ACTIVE, e=0, w=0, W=0, server started_at |
| Existing attempt | Start again / refresh | Return same effective state; no reset |
| ACTIVE, now >= close | Any read or mutation | EXPIRED at close; zero score; finalize once before other new command effects |
| ACTIVE, before close | Correct eligible entity ID | SOLVED at current e; finalize score/profile/leaderboard once |
| ACTIVE, e=0..4, w=0..1 | Wrong eligible ID | Increment w and W; record participation; remain ACTIVE |
| ACTIVE, e=0..3, w=2 | Wrong eligible ID | Increment W; advance e by one; reset w=0 atomically |
| ACTIVE, e=4, w=2 | Wrong eligible ID | Increment W; EXHAUSTED; zero score; finalize once; no evidence #5 |
| ACTIVE, e=0..3 | Reveal | Advance e by one; reset w=0; W unchanged; no participation |
| ACTIVE, e=4 | Reveal | Reject evidence limit; no mutation or version increment |
| ACTIVE | Give up | GIVEN_UP; zero score; finalize once; does not itself record participation |
| Any terminal | Read / refresh | Stable outcome; no new score, knowledge or streak effect |
| Any terminal | New guess/reveal/give-up | Reject terminal conflict; no mutation |
| Any | Unknown ID, invalid payload or wrong entity type | Validation error; no guess, penalty or participation |
| Any | Previously committed identical idempotency key/payload | No re-execution; return recorded command receipt and current authorized projection |
| Any | Same key with different command/payload | Conflict; no mutation |

At expiry, a read may lazily finalize a persisted ACTIVE attempt in a transaction. Profile reads also finalize that guest's elapsed ACTIVE attempts before computing aggregates. This makes expiry independent of workers. Unstarted slots do not create failures. Replay receipts describe historical command outcomes but never grant a new action, restart time, or expose a previous guest's data. Replaying a successful pre-close command after close returns the receipt with the now-terminal projection.

Each valid guess is an opportunity: repeating the same wrong entity with a new key and current version consumes another guess. Retransmission using the same key does not. Maximum wrong guesses is 15 (three at each of five levels). No fuzzy acceptance: autocomplete resolves canonical names or explicit aliases to eligible entity IDs; ambiguous text requires selection. Wrong-answer feedback is generic and reveals no relationship to the hidden answer.

## Disclosure

ACTIVE responses contain the briefing, public entity suggestions, evidence 1..e, own guess history and public attempt counters only. The answer ID, future evidence and explanation are absent, including nested metadata. Each terminal state unseals the answer, all four evidence explanations and original source references. Thus “unsolved” confidentiality means a still-playable ACTIVE attempt; failed terminal attempts intentionally reveal the solution. Other guests never receive an attempt's private projection. No-case exposes no future answer. Logs and traces never contain answers or narrative payloads even after unsealing.

## Score and rank

| Evidence e | Rank | Tier score | Knowledge base |
| --- | --- | ---: | ---: |
| 0 | Cold Case Solve | 1200 | 1.00 |
| 1 | Loremaster | 1000 | 0.85 |
| 2 | Investigator | 750 | 0.65 |
| 3 | Detective | 500 | 0.45 |
| 4 | Case Closed | 250 | 0.25 |

For SOLVED only: `max(0, tierScore - 40*W + timeBonus)`. Bonus uses unrounded elapsed milliseconds: <=30,000 gives 150; <=60,000 gives 100; <=120,000 gives 60; <=300,000 gives 25; otherwise 0. Failed terminal states receive 0 and no solve rank. First-clue solve means SOLVED at e=1, including automatic unlock; e=0 does not count.

## Profile and leaderboard

A UTC day counts as participation only upon at least one accepted valid guess, correct or wrong. Reveal/start/give-up alone do not count. Participation is unique per guest/day and commits with the guess. Current streak is the consecutive run of participated calendar days ending today, or yesterday if today has not yet been played; otherwise 0. A missed calendar day, including a no-case day, breaks the streak. Historical longest streak is retained. This explicit MVP choice avoids scheduled-content gaps silently changing the calendar definition.

Solved count counts SOLVED; failed count counts GIVEN_UP, EXHAUSTED and EXPIRED for started attempts. Accuracy is solved/(solved+failed), rounded to nearest whole percent (half up), or 0% with zero completed cases; ACTIVE attempts are excluded.

For each distinct region on a finalized case, once only: `p=max(0, base-0.05*W)` for a solve and 0 for failure; add p to alpha and 1-p to beta, starting at (2,2). Display `round-half-up(100*alpha/(alpha+beta))`. Regions without outcomes show 50% and zero samples. Preserve precision internally, never round per-update; a multi-region case contributes once to each region, not fractions. Expiry of a started but untouched attempt counts as failure and zero knowledge performance.

Only SOLVED attempts enter the daily leaderboard, one per guest/slot. Sort ascending by `(e, W, elapsed_ms)` independently of score. Identical triples share competition rank (1,1,3); immutable attempt ID ascending is only a stable pagination/display order within a tie and never changes rank. Server-generated pseudonyms identify rows; no session IDs or user-entered markup are public. Active and failed attempts are omitted.
