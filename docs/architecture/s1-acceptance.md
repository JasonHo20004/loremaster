# S1 documentation acceptance record

Date: 2026-09-11. Method: table-driven desk execution against the normative rules, arithmetic evaluation and repository document/link inspection. This is a documentation acceptance check, not a runtime, database, security or cloud test. S4–S12 must supply the executable proofs identified below.

## Transition examples

Unless stated otherwise, the slot is 2026-09-11T00:00:00Z to 2026-09-12T00:00:00Z, identity owns the attempt, commands have distinct keys/current versions, and database time is inside the slot.

| ID | Given / action | Expected desk result |
| --- | --- | --- |
| T01 | No published slot; read then start | No-case twice; no attempt or profile change |
| T02 | At opens_at; start twice | One ACTIVE attempt at e=0,w=0,W=0; same started_at |
| T03 | ACTIVE e=0; refresh 90 seconds later | Same level/counters/start; elapsed time continues |
| T04 | ACTIVE e=0,w=0,W=0; correct at 30,000 ms | SOLVED, 1350 points; participation once; no first-clue credit |
| T05 | e=2,w=0,W=3; wrong then wrong | ACTIVE e=2,w=2,W=5; two accepted guesses |
| T06 | For each e in 0,1,2,3 with w=2; wrong | Advance exactly to e+1,w=0; W increases by 1 |
| T07 | For each e in 0,1,2,3; manual reveal | Advance to e+1,w=0; W unchanged; no participation |
| T08 | e=4,w=1; wrong | ACTIVE e=4,w=2; W increases by 1 |
| T09 | e=4,w=2,W=14; wrong | EXHAUSTED,W=15, score 0; full result unsealed; failed/knowledge update once |
| T10 | ACTIVE e=4; reveal | Evidence-limit rejection; no mutation |
| T11 | ACTIVE with no guesses; give up | GIVEN_UP, score 0, failed +1; no participation; all evidence explained |
| T12 | ACTIVE after one wrong; give up | GIVEN_UP; that day's participation remains; no duplicate day |
| T13 | ACTIVE; correct command obtains lock exactly at closes_at | EXPIRED at close, score 0; command does not count as guess |
| T14 | ACTIVE; read after close, then profile/read again | EXPIRED finalized once; failed and regional outcome each increment once |
| T15 | For each terminal state; refresh then new mutation | Same result; mutation rejected; no extra effects |
| T16 | ACTIVE; unknown ID / wrong type / malformed body | Validation error; no counters, participation or version change |
| T17 | Commit wrong guess; retry identical key/payload | One wrong guess total; same command receipt and current projection |
| T18 | Reuse committed key for a different guess or reveal | Conflict; no mutation |
| T19 | Guess and reveal race from same version | First lock holder commits; other conflicts; no action silently moves to new level |
| T20 | Same wrong entity twice with new keys/current versions | Two wrong guesses; exact transport retry still counts once |
| T21 | Third wrong at e=0, then correct at e=1 after 60,001 ms | SOLVED; 1000-120+60=940; first-clue +1 |
| T22 | At closes_at next slot starts; read old attempt | Current slot selectable; old attempt expires; old mutation cannot target new slot |
| T23 | Replay pre-close success after close | Historical receipt, current terminal projection; no timer reset or extra guess |
| T24 | Second guest requests first guest's attempt/key | Ownership rejection; no private state or receipt disclosed |
| T25 | No attempt ever started; day closes | No synthetic failure/knowledge update; no participation |

Desk outcome: T01–T25 resolve to a single outcome under the table. New invalid or stale requests have no gameplay effects, except effective expiry reconciliation when the owned attempt has already closed.

## Boundaries and integrity examples

| ID | Example | Expected result |
| --- | --- | --- |
| B01 | Bonus at 30000/30001/60000/60001/120000/120001/300000/300001 ms | 150/100/100/60/60/25/25/0 |
| B02 | e=4,W=14, solve after five minutes | max(0,250-560)=0; still SOLVED and leaderboard eligible |
| B03 | A:e=0,W=2,301000ms,score1120; B:e=1,W=0,1000ms,score1150 | A ranks before B despite lower score |
| B04 | Triples (1,0,42000),(1,0,42000),(1,0,42001) | Ranks 1,1,3; stable ID order only within the tie |
| B05 | One e=1,W=3 solve in fresh region | p=0.70; alpha=2.70,beta=2.30; 54% |
| B06 | Then failure in same region | alpha=2.70,beta=3.30; 45%; retry does not change it |
| B07 | Two regions including duplicate region ID in imported list | Import normalizes/rejects duplicates; each distinct region gets one outcome |
| B08 | Guess Sep 10; start/reveal/give-up only Sep 11 | Streak 1 on Sep 11; 0 on Sep 12 without another guess |
| B09 | Guesses Sep 10 and Sep 11, even with give-up | Streak 2; solved 0, failed 2, accuracy 0% |
| B10 | Two solves and one failure, plus ACTIVE attempt | Accuracy 67%; ACTIVE omitted |
| B11 | Adjacent UTC windows; then concurrent overlapping import | Adjacent accepted; overlap rejected globally, including other packs |
| B12 | Edit published answer/evidence/window or replace opened revision | Rejected; old attempt retains immutable revision |
| B13 | ACTIVE e=2 projection | Briefing and evidence 1–2 only; no answer or evidence 3–4/explanation |
| B14 | C=83.99,G=10,U=5,R=2,T=8,D=5,S=3 | Exposure39 <=70; arithmetic passes, live evidence still required |
| B15 | Same cost inputs but G=45; or eligibility missing | Exposure74 denied; missing eligibility also denied |

## Consequence and fixture review

ADRs 0001–0004 each record context, alternatives, consequences and verification. Review explicitly checked the trade-offs: Kubernetes overhead, immutable content correction limits, latency-sensitive timing, failed-start expiry, no-case streak gaps, guest identity loss/Sybil limitations, synchronous database load and cloud refusal. No conflicting second state machine is introduced; the historical description is labeled non-normative.

The only planned narrative fixture is the text-only Aster Quay pack in the content policy: four original entities, one original region, one WHO briefing, four evidence levels and explanations. Desk review found no Riot narrative/assets in that planned pack. The repository still contains the pre-existing historical Riot-inspired document; this is deliberately not claimed to be a repository-wide absence of Riot references. No seed or browser bundle exists yet; S4/S6/S8 must prove implementation exclusions.

S1 exit: PASS for documentation scope. Runtime verification, AWS account evidence and cleanup qualification remain pending their assigned stages. Changes to accepted decisions require a superseding ADR and updated acceptance examples.
