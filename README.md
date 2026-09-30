# Loremaster Daily Case

A daily deduction game using original fiction, built as a portfolio for reliable delivery and operations. The MVP is one `WHO` case, a briefing and four evidence levels, guest play, results, participation streaks, regional knowledge, and a daily leaderboard.

**Status:** S6, S7.0, and S7.1 are merged with passing hosted CI. S7.2-S7.6 are implemented and verified locally on `codex/s7-runtime`; [runtime evidence](plans/s7-runtime.md) records the checks and remaining delivery gates. S7.7 health and queue observation are next. Hosted CI and merge have not yet accepted S7.2-S7.6.

The [S7 progress checklist](plans/s7-cache-worker.md#progress) is the canonical current-status source. Stage acceptance records own completed-stage evidence; this README only summarizes them.

Start with the [architecture](docs/architecture/README.md), [authoritative game rules](docs/architecture/game-rules.md), and [accepted decisions](docs/adr/README.md). The [S1](docs/architecture/s1-acceptance.md), [S2](docs/architecture/s2-acceptance.md), [S3](docs/architecture/s3-acceptance.md), [S4](docs/architecture/s4-acceptance.md), [S5](docs/architecture/s5-acceptance.md), and [S6](docs/architecture/s6-acceptance.md) acceptance records trace stage evidence and explicit deferrals. Local API plus web startup is documented in the [development guide](docs/development/README.md). Security requirements live in the [threat model](docs/threat-model/README.md); content requirements in the [content policy](docs/content-policy.md); cloud remains denied under the [cost admission policy](ops/cost/README.md).

The legacy [product description](docs/DailyRuneterraCase_Description.md) is historical inspiration only. It is not an implementation specification or an approved content pack. Where it differs, accepted ADRs and the game rules govern new work.

## Delivery sequence

S1 governance → S2 pinned pnpm/TypeScript monorepo → S3 untrusted CI → S4 domain/database → S5 API, S6 web, S7 cache worker → S8 containers → S9 local Kubernetes/GitOps → S10 observability/release gate → S11 cloud bootstrap/cleanup qualification → S12 admitted AWS lab and teardown.

S3 applies the S2 command surface to untrusted pull requests with read-only permissions, immutable actions, dependency auditing and secret scanning. Do not treat future runtime or infrastructure as already implemented. Local reproducibility and transactional correctness take priority over cloud demonstrations. Kubernetes is a deliberate operations learning platform, not the cheapest way to host this small game.
