# Loremaster Daily Case

A daily deduction game using original fiction, built as a portfolio for reliable delivery and operations. The MVP is one `WHO` case, a briefing and four evidence levels, guest play, results, participation streaks, regional knowledge, and a daily leaderboard.

**Status:** S3 untrusted CI is implemented locally and awaiting hosted acceptance; runtime feature implementation starts in S4 after its required checks pass. There is no gameplay application or cloud deployment yet.

Start with the [architecture](docs/architecture/README.md), [authoritative game rules](docs/architecture/game-rules.md), and [accepted decisions](docs/adr/README.md). The [S1](docs/architecture/s1-acceptance.md), [S2](docs/architecture/s2-acceptance.md), and [S3](docs/architecture/s3-acceptance.md) acceptance records trace stage exit checks. Local setup is documented in the [development guide](docs/development/README.md). Security requirements live in the [threat model](docs/threat-model/README.md); content requirements in the [content policy](docs/content-policy.md); cloud remains denied under the [cost admission policy](ops/cost/README.md).

The legacy [product description](docs/DailyRuneterraCase_Description.md) is historical inspiration only. It is not an implementation specification or an approved content pack. Where it differs, accepted ADRs and the game rules govern new work.

## Delivery sequence

S1 governance → S2 pinned pnpm/TypeScript monorepo → S3 untrusted CI → S4 domain/database → S5 API, S6 web, S7 cache worker → S8 containers → S9 local Kubernetes/GitOps → S10 observability/release gate → S11 cloud bootstrap/cleanup qualification → S12 admitted AWS lab and teardown.

S3 applies the S2 command surface to untrusted pull requests with read-only permissions, immutable actions, dependency review and secret scanning. Do not treat future runtime or infrastructure as already implemented. Local reproducibility and transactional correctness take priority over cloud demonstrations. Kubernetes is a deliberate operations learning platform, not the cheapest way to host this small game.
