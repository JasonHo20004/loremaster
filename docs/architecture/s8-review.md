# S8 independent acceptance review — 2026-10-21

Reviewed baseline: merged S8 `c784660f339ee9ba792e28e4535cf2387fa6b656`
([PR #16](https://github.com/JasonHo20004/loremaster/pull/16)). Corrections are
on `codex/s8-final-acceptance`. This is an AI-assisted independent review:
separate code/delivery, security, and database reviewers inspected the source;
the security reviewer also reviewed accessibility. Reviewers did not approve
their own fixes: security reviewed the cleanup changes, and code/delivery
reviewed scanner, Compose, lifecycle and operator-input changes.

## Review coverage

| Review | Scope | Outcome |
| --- | --- | --- |
| TypeScript/JavaScript and delivery | Runtime/config changes since S7; packaging, allowlists, reproducible builds, image artifacts, lifecycle/drain, T25, browser harness and CI | Corrections below peer-reviewed; no remaining actionable finding |
| Container security | Six scratch final images, executable/library/package inventory, non-root users, file secrets/redaction, gateway Origin and forwarded IP, private networks, privileges, resources and scanner admission | Corrections below peer-reviewed; no HIGH/CRITICAL code finding; dynamic image admission remains mandatory |
| Database/operator | Migration/import separation, database login/group roles, Redis ACLs/persistence, bootstrap credentials, bounded import, dependency recovery, T25 and exact teardown | Corrections below peer-reviewed; PostgreSQL remains authoritative |
| Accessibility | Unchanged S6 UI semantics, route/gameplay focus, skip link, keyboard combobox/dialog, live announcements, mobile reflow, reduced motion, forced colors and gateway CSP | No S8 regression identified; recurring Chromium/axe gate added, plus packaged mobile keyboard/focus assertions |
| Acceptance delivery | Baseline and corrected CI/artifact inspection, stale status reconciliation, exact-source CI and S9 handoff | Correction CI PASS on `f6bf7d3`; PR #18 tracks final documentation-head checks and delivery |

## Findings and corrections

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| Vulnerability exceptions could take effect before approval; JavaScript normalized invalid calendar dates | Exact UTC calendar-date validation; reject future approvals, invalid clocks and expired/overlong exceptions | `tests/s8/scan-policy.test.ts` |
| A failed `docker run` could leave a created container untracked | Register before launch; require successful removal or independently proven exact-name absence; daemon failures fail teardown | `tests/s8/image-resources.test.ts`; `pnpm test:images` |
| Compose default 10s grace overlapped the complete API/worker 10s drain budget | Explicit API/worker 20s, observer/web 15s; validate normalized config and effective `StopTimeout`; exercise default stop | `pnpm test:s8:lifecycle` |
| Gateway request buffering could make API drain evidence pass without an API request in flight | Private worker-to-API client waits for `100 Continue` and holds an incomplete body; verify closure after SIGTERM | `tests/s8/lifecycle-client.test.ts`; lifecycle `requestAccepted`/`requestClosed` |
| Missing credentials plus a Docker inspection failure could generate replacement secrets for a retained database | Require a successful volume listing proving the exact PostgreSQL volume absent before creating secrets | `tests/s8/compose-inputs.test.ts` |
| Content preparation read arbitrary input before applying its 256KiB limit | Wrapper checks absolute path/type/size; preparation opens nonblocking/no-follow, verifies descriptor identity/type/size and reads at most 262145 bytes | Operator-input regression; `pnpm test:s8:data-services` |
| Fresh dependency audit found one HIGH and two MODERATE Vite advisories updated after baseline CI | Pin Vite 8.3.3 directly and through the workspace override; regenerate the frozen lock, including its required Rolldown/OXC dependencies | `pnpm install --frozen-lockfile`; `pnpm audit --audit-level moderate`; verify and browser/image gates |

The final CI artifact also retains raw per-image `*-scan.json` reports alongside
SBOMs, file inventories and the policy summary. The data/Compose harness checks
all three labeled resource types after teardown. No vulnerability exception was
introduced, and no gameplay, API contract, registry, Kubernetes or cloud scope
was added.

The Vite patch addresses [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm),
[GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), and
[GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw).
These are build/development-tool advisories; the same admission policy still
requires a clean workspace audit rather than granting an exception.

## Evidence and limits

The historical [main CI run](https://github.com/JasonHo20004/loremaster/actions/runs/38342836326)
passed four jobs on `c784660`. Its `s8-acceptance-evidence` artifact was downloaded
and inspected during this review: six image/context records, repeated image IDs,
six SBOMs/file inventories, zero severe findings/secret findings, three packaged
browser journeys, eight zero-effect T25 tables, lifecycle and worker-drain
results, all with successful disposable teardown. This is baseline evidence;
it does not certify the corrections above.

Local review verification with pinned Node 22.23.3 and pnpm 11.19.0 passed
format, lint, typecheck, 425 unit tests (two platform skips), eleven workspace
builds, and five Chromium shell/accessibility journeys. Test counts describe
their suites, not total coverage. The Chromium axe suite uses Vite preview and
mocked API responses. Packaged browser tests separately exercise actual images,
real PostgreSQL/Redis and gateway behavior, including mobile skip-link and
focus checks; the two scopes must not be conflated.

Final correction evidence and its exact CI source are recorded in the
[S8 acceptance map](s8-acceptance.md). The [corrected-source CI](https://github.com/JasonHo20004/loremaster/actions/runs/39535223085)
passed all four jobs on `f6bf7d38d0eac2a4df3f4e8b6fd5f367f9c9cbf3` after
independent review. Artifact `12317790332` was downloaded and verified: six raw
scanner reports, six SBOMs/inventories, matching repeated image IDs, all runtime
results PASS and exact teardown PASS. The [durable evidence snapshot](s8-evidence-2026-10-21.json)
preserves those source-linked results. [PR #18 checks](https://github.com/JasonHo20004/loremaster/pull/18/checks)
must also pass on the final documentation head before merge; historical or
local-only evidence cannot replace this gate.

The workflow's PR head is `f6bf7d3`; its actual synthetic merge checkout is
`72383ddb6149ba1b315a45a3422f6653759b1d44`, recorded in each image's OCI
revision. Fetching the PR merge ref and comparing complete Git trees verified
both source trees equal `a464c9abd7142a4e47da89e76622f72dd86434a7`. The durable
snapshot distinguishes reviewed branch, workflow head and actual runtime source;
independent review also recomputed and matched all six SBOM SHA-256 hashes and
inspected all six raw reports. CI head SHA must not be substituted for checkout
provenance.

S8.11 is accepted with this reviewed runtime and explicit handoff. Acceptance
applies to the local Compose profile. S9 owns Kubernetes/GitOps;
S10 owns full telemetry/release gates; S11–S12 still require separate cloud
admission. Scan results are time-bound and must be rerun for future builds.
