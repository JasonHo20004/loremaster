# Loremaster Daily Case

A daily deduction game using original fiction, built as a portfolio for reliable delivery and operations. The MVP is one `WHO` case, a briefing and four evidence levels, guest play, results, participation streaks, regional knowledge, and a daily leaderboard.

New to the project? Read the [Vietnamese onboarding and team handoff guide](docs/development/onboarding-vi.md) for the product, architecture, delivery status, local setup, remaining work, and a proposed split for three developers.

**Status (2026-10-23):** S1–S8 are accepted. [PR #18](https://github.com/JasonHo20004/loremaster/pull/18) closes the independent S8 review and S8.11 handoff after [correction CI passed](https://github.com/JasonHo20004/loremaster/actions/runs/39535223085); [final delivery checks](https://github.com/JasonHo20004/loremaster/pull/18/checks) track its final documentation head. The [review record](docs/architecture/s8-review.md), [acceptance map](docs/architecture/s8-acceptance.md) and [durable evidence snapshot](docs/architecture/s8-evidence-2026-10-21.json) record the local Compose baseline. S9's Kubernetes/GitOps, hosted CI, active drain/replay and Redis 64-PID gates are recorded in the [S9 acceptance map](docs/architecture/s9-acceptance.md); [PR #19 checks](https://github.com/JasonHo20004/loremaster/pull/19/checks) track its final delivery head. Full observability and AWS remain S10–S12 work.

S9 implementation and executed gates are tracked in the [local Kubernetes/GitOps plan](plans/s9-local-gitops.md) and [acceptance map](docs/architecture/s9-acceptance.md). The [S9 operator guide](docs/development/s9-local-gitops.md) covers kind, Helm, Argo CD, immutable local image promotion and recovery. S10–S12 remain separate stages.

The [S8 progress checklist](plans/s8-containers.md#progress) records the accepted container baseline. The [S8.0 preflight](plans/s8-preflight.md) records the accepted S7 base and host gates; [S8 image evidence](plans/s8-images-evidence.md), [Compose evidence](plans/s8-compose-evidence.md), and the [local acceptance map](docs/architecture/s8-acceptance.md) record the gates. [Compose instructions](docs/development/s8-compose.md) cover the isolated stack.

Start with the [architecture](docs/architecture/README.md), [authoritative game rules](docs/architecture/game-rules.md), and [accepted decisions](docs/adr/README.md). The [S1](docs/architecture/s1-acceptance.md), [S2](docs/architecture/s2-acceptance.md), [S3](docs/architecture/s3-acceptance.md), [S4](docs/architecture/s4-acceptance.md), [S5](docs/architecture/s5-acceptance.md), and [S6](docs/architecture/s6-acceptance.md) acceptance records trace stage evidence and explicit deferrals. Local API plus web startup is documented in the [development guide](docs/development/README.md). Security requirements live in the [threat model](docs/threat-model/README.md); content requirements in the [content policy](docs/content-policy.md); cloud remains denied under the [cost admission policy](ops/cost/README.md).

The legacy [product description](docs/DailyRuneterraCase_Description.md) is historical inspiration only. It is not an implementation specification or an approved content pack. Where it differs, accepted ADRs and the game rules govern new work.

## Delivery sequence

S1 governance → S2 pinned pnpm/TypeScript monorepo → S3 untrusted CI → S4 domain/database → S5 API, S6 web, S7 cache worker → S8 containers → S9 local Kubernetes/GitOps → S10 observability/release gate → S11 cloud bootstrap/cleanup qualification → S12 admitted AWS lab and teardown.

S3 applies the S2 command surface to untrusted pull requests with read-only permissions, immutable actions, dependency auditing and secret scanning. Do not treat future runtime or infrastructure as already implemented. Local reproducibility and transactional correctness take priority over cloud demonstrations. Kubernetes is a deliberate operations learning platform, not the cheapest way to host this small game.
