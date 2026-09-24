# Architecture baseline

Accepted for S1 on 2026-09-11 and locally completed through the [S6 web acceptance record](s6-acceptance.md) on 2026-09-24. The [S5 API contract](s5-api-contract.md) remains the frozen browser/API boundary. S6's final documentation commit still requires clean-checkout CI before merge; the [S6 plan](../../plans/s6-web.md) is the canonical delivery-status source. S7 cache-worker work is next. The blueprint defines project scope; later stages are not authorization to provision resources before their gates.

## Boundaries and flow

Browser → React/Vite web → Express API → PostgreSQL. API → Redis/BullMQ → cache-warming worker. A single queue observer exposes metrics. PostgreSQL is authoritative for content revisions, attempts, guesses, sessions, score, streaks, regional knowledge and leaderboard. Redis contains disposable caches and queue state; losing it must not lose a game result.

The API authenticates and validates mutations, locks the attempt, applies the [state machine](game-rules.md), and commits authoritative effects synchronously. No gameplay write waits for a background job. Public response projections expose only the permitted evidence. Neither web assets nor shared browser contracts contain secret content fixtures.

| Repository boundary | Responsibility |
| --- | --- |
| `apps/web`, `apps/api`, `apps/worker`, `apps/queue-observer` | UI, HTTP, cache processing, queue metrics |
| `packages/domain`, `packages/contracts` | Pure rules; validated HTTP/job contracts |
| `packages/database`, `packages/queue` | Migrations/repositories; versioned job configuration |
| `packages/config`, `packages/observability` | Validated environment; redacted logs/metrics/traces |
| `deploy/` | Images, application Helm chart and desired release state |
| `platform/` | Local cluster, controllers, CRDs and cluster policies |
| `infra/` | AWS bootstrap and separately admitted runtime |
| `ops/`, `tests/`, `docs/` | Operational evidence, verification, accepted decisions |

The API, domain, contracts, database, config, observability, and React/Vite web boundaries now exist. The web client provides validated session bootstrap, refresh-safe gameplay, mutation recovery, profile, leaderboard, responsive presentation, and accessible browser behavior without owning game truth. Worker, queue, and deployment boundaries remain staged targets. Engine rules use entity/region IDs; content packs supply original names, narrative, evidence and explanations. A non-public operator CLI imports validated packs into PostgreSQL.

## Deployment progression

Local containers precede a pinned kind cluster (one control plane, three workers), Helm and Argo CD. Redis persists with `noeviction`; caches remain reconstructible. Containers run non-root with resources, probes and graceful shutdown. Image releases use verified immutable digests. Schema rollback uses compatible application images and forward corrections.

The optional bounded AWS profile uses CloudFront with private S3 web assets and an ALB forwarding API traffic to EKS, RDS and ElastiCache. No NAT or paid domain is planned. Public-subnet node egress is a cost compromise. The lab-only CloudFront-to-ALB HTTP hop requires origin restrictions and a secret origin header; browser traffic uses HTTPS. S12 must test direct-origin denial and session isolation before claiming the path works.

One small Spot node is a target subject to measured capacity admission, including a four-worker ceiling and 30% headroom. Admission failure means no lab, not automatic larger capacity. Minimal AWS telemetry differs from the fuller local stack. Independent cleanup runs outside EKS and survives provisioning denial.

## Scope limits

No password accounts, admin UI, multiple case types, permanent public service, service mesh, Kafka, Vault, multi-region or durable asynchronous gameplay. Only daily cache warming is queued. A future durable asynchronous effect requires a new ADR for a PostgreSQL outbox and processed-event uniqueness.
