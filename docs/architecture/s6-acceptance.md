# S6 web acceptance record

Recorded 2026-09-24. `PASS` means the S6-owned behavior has executable local
evidence. `PARTIAL` names evidence split with a later stage. `DEFERRED (owner)`
is outside the S6 implementation claim.

S6 is locally accepted. The final documentation commit still requires the
repository's clean-checkout `Quality`, `Dependency audit`, and `Secret scan`
jobs before merge; no hosted run exists for the `web-ui` branch at the time of
this record. That delivery gate is a failure if it does not run or pass and is
not treated as a skip.

## Acceptance map

| Claim | Exact executable evidence | Status |
| --- | --- | --- |
| T03 refresh preservation | `tests/web/game-state.test.ts` reconstructs an active attempt on reload; `tests/web/e2e/real-stack.spec.ts` bootstraps, starts explicitly, reloads, and preserves the real PostgreSQL-backed attempt. | PASS |
| T22 UTC revision rollover | `tests/web/game-state.test.ts` moves Current Case to the next slot without replaying an old start; `tests/web/e2e/real-stack.spec.ts` advances controlled server time, selects the new slot, and proves the old attempt remains bound to its revision and expires. | PASS |
| B13 public disclosure boundary | `tests/web/public-boundary.test.ts`, `tests/api/disclosure.test.ts`, and `scripts/web-disclosure.mjs` exclude server modules, authored fixtures, answers, future evidence, explanations, sources, historical text, secret-shaped values, and non-allowlisted build context from source and all Vite JavaScript, CSS, HTML, manifest, and source-map outputs. S8 still owns the scan of the assembled deployed artifact. | PARTIAL (S8) |
| Hostile-text XSS | `apps/web/src/gameplay/gameplay.browser.test.tsx` and `apps/web/src/reporting/reporting.browser.test.tsx` render hostile lore and pseudonyms as text; `tests/web/e2e/real-stack.spec.ts` injects hostile imported public text and proves no script, image, link, navigation, global side effect, or network request is created. | PASS |
| Mutation uncertainty | `tests/web/game-state.test.ts` covers durable pending intent, exact-key replay, stale versions, terminal reconciliation, session expiry, and blocked concurrent action; `tests/web/e2e/real-stack.spec.ts` loses pre-commit and committed responses, reloads, reuses the identical idempotency key, and proves no duplicate effect. | PASS |
| Accessibility | The 11-test Chromium component suite covers semantic navigation, canonical keyboard selection, focus restoration, dialogs, recovery, and reporting; `apps/web/e2e/accessibility.spec.ts` runs keyboard and axe checks across start, active, terminal, uncertain, profile, and ledger states with no serious or critical violations. | PASS |
| Responsive behavior | `apps/web/e2e/accessibility.spec.ts` covers 360 px mobile, desktop, 200%-zoom-equivalent reflow, reduced motion, forced colors, gameplay, profile, and ledger; the four critical-state screenshots were manually reviewed during S6.6. | PASS |
| Reporting presentation | `tests/web/reporting-controller.test.ts` and `apps/web/src/reporting/reporting.browser.test.tsx` prove isolated retry, exact profile values, API order, shared ranks, zero scores, hostile pseudonyms, and pagination; `tests/web/e2e/real-stack.spec.ts` proves profile refresh and two-page real leaderboard presentation. | PASS |

## Verification record

Commands were run from the repository root on 2026-09-24 with Node 22.17.0
and pnpm 11.19.0. Docker or PostgreSQL absence is a hard failure in the named
harnesses; the successful results below contain no skipped prerequisite.

| Suite or gate | Result |
| --- | --- |
| Frozen install (`pnpm install --frozen-lockfile`) | PASS; lockfile already current |
| Focused Chromium components (`pnpm --filter @loremaster/web test:component`) | 11 tests in 3 files, PASS |
| Real browser (`pnpm test:web:e2e`) | 4 composed web/API/PostgreSQL journeys plus 5 accessibility/responsive journeys, PASS |
| Bundle/source-map disclosure (`pnpm test:web:disclosure`) | 5 JavaScript, CSS, HTML, manifest, and source-map artifacts scanned; PASS |
| Repository/database (`pnpm test:database`) | 59 tests in 5 files against disposable PostgreSQL, PASS |
| Composed API/PostgreSQL (`pnpm test:api:database`) | 7 tests in 2 files, PASS |
| Root gate (`pnpm run verify`) | Formatting, lint, 10 workspace typechecks/builds, and 277 tests in 28 files, PASS |
| Dependency audit (`pnpm audit --audit-level moderate`) | No known vulnerabilities |
| Production license inventory | 84 package/version entries: 77 MIT, 6 ISC, 1 BSD-3-Clause; none missing a declared license |
| Full-history secret scan | Gitleaks 8.30.0 scanned 42 commits / about 1.14 MB; no leaks found |
| Diff hygiene (`git diff --check`) | PASS after documentation formatting |
| Hosted clean-checkout CI | DEFERRED (delivery): no run exists for `web-ui`; all three required jobs must pass on the final commit before merge |

The S6.7 implementation received independent TypeScript, accessibility, and
security review. S6.8 changes documentation and status only; it does not change
the frozen HTTP contract, database schema, gameplay rules, runtime dependency
graph, or public build context.

## S7 handoff

S7 may add Redis/BullMQ cache warming only for disposable read paths.
PostgreSQL remains authoritative, and cache loss or worker failure must not
change gameplay truth. S7 must preserve the frozen browser/API request and
response semantics, cookie/CSRF/idempotency behavior, projection disclosure
rules, and the bounded replica-local limiter as the availability fallback when
shared limiting is unavailable. Cache work must not require reopening the S6
browser correctness claims above.

S8 still owns container assembly and deployed-artifact disclosure scanning;
S12 owns two-guest shared-cache isolation. No container, Kubernetes, or cloud
startup instructions are introduced by S6.
