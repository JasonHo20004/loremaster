# S10 — Observability and release gate

S10 makes the accepted [S9 local lab](s9-local-gitops.md) observable and
gives it an operations practice surface: metrics, logs, dashboards, SLO
alerts, runbooks, backup/restore and failure drills. Application behavior,
disclosure rules and the S5 API contract do not change.

## Scope and acceptance

| Slice | Deliverable                                                                                     | Gate                                                 | Status                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| S10.0 | Pinned toolchain on the operator host; Windows path guard in build contexts                     | `pnpm run verify`, Docker suites                     | Done locally (2026-11-05)                                                                               |
| S10.1 | API Prometheus sink and process metrics on an optional private port                             | `pnpm test`, `tests/api/server.test.ts`              | Done; live series in kind                                                                               |
| S10.2 | Structured request logs (`ts`, `level`, `service`, `event`), redacted 5xx cause, fatal handlers | `tests/api/telemetry.test.ts`, `tests/observability` | Done; JSON lines in Loki                                                                                |
| S10.3 | kube-prometheus-stack on kind via `pnpm s10 install`; ServiceMonitors; dashboards               | `pnpm test:s10`; targets `up`                        | Done; api×2 and observer targets up                                                                     |
| S10.4 | SLO recording rules, burn-rate and platform alerts, runbooks                                    | `pnpm test:s10:rules` (promtool), `pnpm test:s10`    | Rules and tests done; Alertmanager receiver not chosen                                                  |
| S10.5 | Loki and Alloy log collection, Grafana Loki datasource                                          | Loki labels show `loremaster` apps                   | Installed and verified                                                                                  |
| S10.6 | PostgreSQL backup, restore and drill                                                            | `pnpm test:s10:restore`                              | [ADR 0006](../docs/adr/0006-backup-and-restore.md) proposed; awaiting acceptance and adversarial review |
| S10.7 | TLS edge for the lab                                                                            | HTTPS browser journey                                | Not started; needs a decision on proxy trust                                                            |
| S10.8 | Load test and failure drills                                                                    | k6 thresholds; drill records                         | Not started                                                                                             |
| S10.9 | Content for current slots                                                                       | `GET /api/v1/cases/current` playable today           | Not started                                                                                             |

## Decisions

- Metrics are rendered by `packages/observability` without a new dependency,
  matching the existing queue-metric renderer. Labels are limited to
  allowlisted `operation` IDs and status classes. Other points are dropped
  and counted in `loremaster_api_metric_points_dropped_total`, and the
  number of series is capped at 128.
- The API metrics listener is off unless `LOREMASTER_API_METRICS_PORT` is
  set. It is a separate listener (9464 in Helm) that nginx never proxies.
  Only Prometheus pods in the `monitoring` namespace may reach it, enforced
  by the `monitoring-scrape` NetworkPolicy.
- Logs never contain request bodies, URLs, error messages or stacks. A 5xx
  log carries the public `errorCode` and a `cause` limited to a SQLSTATE or
  a plain error class name.
- The monitoring stack is platform-owned and installed from hash-verified
  chart archives. Every image is rewritten to the digest in
  `platform/monitoring/versions.json`, and an unpinned image fails the
  install. The Argo AppProject is unchanged.
- Queue alerts are tickets, never pages: gameplay never waits on the queue.
  `loremaster_queue_oldest_retained_age_seconds` measures retention, not
  backlog, so no alert uses it.
- Logs reach Loki through the Kubernetes API (`loki.source.kubernetes`), so
  no host mounts are needed. `requestId` stays out of labels.
- `minimatch` is overridden to 11.0.5 for GHSA-g3hv-75wg-m249 (moderate,
  ESLint only, not shipped). It is a major bump outside ESLint's `^10`
  range; ESLint lints the same files with it. 11.0.5 (2026-11-05) is the
  newest release older than two weeks.

## Open items

- Alertmanager receiver: the chart default routes to `null`. Pick a lab
  receiver (webhook sink, email or chat) and store its secret file-backed.
- PostgreSQL and Redis exporters need new least-privilege roles and ACL
  users. They are deferred to the ADR 0006 role work.
- On Windows, run `pnpm s9 …` from PowerShell. Git Bash's GNU tar reads `C:`
  as a remote host.
- Chart rule `AlertmanagerClusterCrashlooping` is disabled. On Docker
  Desktop/WSL2, boot-time drift moves `process_start_time_seconds` about 3 s
  per minute, so `changes()`-based rules false-fire. Do not build alerts on
  that series locally.
- `KubeQuotaFullyUsed` (info) fires for `requests.storage` 2Gi/2Gi in
  `loremaster`. This is expected today and blocks a backup PVC; see ADR 0006.
