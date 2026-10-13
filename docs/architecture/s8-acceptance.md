# S8 local container acceptance

S8 packages the accepted S7 runtime for a local, isolated Docker Compose stack.
The source of truth for slice status is the [S8 plan](../../plans/s8-containers.md).
The commands below write machine-readable local results under `.cache/`; a
failing or missing result does not count as acceptance. Hosted clean-checkout CI
and independent review remain release gates until recorded here with links.
The CI image-validation job uploads `s8-acceptance-evidence`, including the
source-commit image IDs, context digests, reproducibility result, per-image
SBOMs, filesystem inventories, scanner summary, lifecycle results, browser
result, and T25 result. The six local image IDs are generated after checkout
so their embedded revision labels match that exact commit.

| Claim | Reproduction command | Evidence and gate |
| --- | --- | --- |
| Six minimal, non-root images and B13 public files | `pnpm test:images`; `pnpm test:web:deployed-disclosure` | `.cache/s8-build-results.json`, `.cache/s8-reproducibility.json`, `.cache/s8-evidence/{summary.json,web-files.txt,web-sbom.cdx.json,web-scan.json}`; [image construction record](../../plans/s8-images-evidence.md) |
| Clean data services and file-secret permissions | `pnpm test:s8:data-services` | [Compose evidence](../../plans/s8-compose-evidence.md) |
| Network, security, and resource topology | `pnpm test:s8:compose` | [Compose evidence](../../plans/s8-compose-evidence.md) |
| Dependency and shutdown behavior | `pnpm test:s8:lifecycle` | `.cache/s8-lifecycle.json` and `.cache/s8-worker-drain.json`; both require `passed: true` and `teardown: PASS` |
| Browser through packaged gateway | `pnpm test:s8:e2e` | `.cache/s8-e2e.json`; requires `passed: true` and `teardown: PASS` |
| T25 unstarted closed slot | `pnpm test:s8:t25` | `.cache/s8-t25.json`; all before/after gameplay effect counts equal zero and `teardown: PASS` |
| Supply-chain disclosure | `pnpm test:images` | CycloneDX SBOM, Trivy vulnerability/license/secret results, saved image layer inventory, no unapproved HIGH/CRITICAL finding |

The six local image IDs and context digests are recorded in
`.cache/s8-build-results.json`. They identify local assembled artifacts; the
reviewed CI build must reproduce them from its own source commit. The pinned
PostgreSQL and Redis references, per-service memory/CPU/PID/file-descriptor
limits, mounted writable data paths, health intervals, and network membership
are in [Compose](../../deploy/compose/compose.yaml). The six image UIDs,
working directories, ports and `/tmp` writable-path contract are in
[image contracts](../../deploy/images/contracts.json). Image filesystems are
read-only at runtime, except bounded `/tmp` and named data or credential
volumes. Only the web gateway publishes `127.0.0.1:8080`.

The 2026-10-12 local run passed all six image behavior checks and repeated
builds with matching IDs. Exported image and layer inspection, CycloneDX
SBOMs, Trivy vulnerability/license/secret scans, and public HTML, JavaScript
and source-map scans found zero unapproved HIGH/CRITICAL vulnerabilities,
zero secret findings, and no private public artifact marker. The 47-file unit
suite passed 404 tests. The packaged Chromium suite passed all three journeys,
and the T25 effect counts were zero in all eight tables before and after
midnight. Every disposable test project reported `teardown: PASS`.

The lifecycle result measured PostgreSQL recovery at 5.544 seconds and API
readiness recovery at 0.458 seconds; Redis recovery at 5.975 seconds, worker
readiness at 0.564 seconds, and observer readiness at 0.811 seconds. API
SIGTERM closed an in-flight connection and exited zero in 1.162 seconds;
idle worker SIGTERM exited zero in 2.463 seconds. The separately held active
warm job drained in 0.614 seconds, then replayed to one completed job after
restart. These are observations from the local run, not S9 timeout budgets.

The local edge uses `http://localhost:8080` and exact gateway address
`172.30.80.2/32`; production mode rejects HTTP and requires its secure cookie
profile. Bootstrap is an explicit credential preparation, migration and role
provisioning operation. Import is an explicit operator operation. Application
startup never runs either. The [Compose guide](../development/s8-compose.md)
names the config, build, bootstrap, import, start, status, logs, stop and test
commands. A PostgreSQL outage should leave API liveness green but readiness
failed. Redis loss should keep PostgreSQL gameplay and the local rate limiter
available. Restart a dependency with `docker compose start <service>` or the
documented wrapper; the lifecycle gate checks bounded automatic recovery and
unchanged API/web container identity. The developer `stop` command retains
data and credential volumes. Only the test harness removes its exactly named
project and verifies zero labeled containers, networks and volumes.

The disposable [T25 test image](../../deploy/compose/t25-postgres.dockerfile)
adds pinned `libfaketime` 0.9.10-r3 to the pinned PostgreSQL 17.6 Alpine
base. A second Compose file mounts its clock control read-only, and the test
controller alone changes it. Only PostgreSQL receives virtual wall time;
monotonic clocks remain real. Neither the override nor its package enters the
six runtime image build contexts or SBOMs. Production Compose uses actual
PostgreSQL `clock_timestamp()`. The package version is listed by
[Alpine v3.22](https://pkgs.alpinelinux.org/package/v3.22/community/x86_64/libfaketime),
and the [upstream timestamp-file behavior](https://github.com/wolfcw/libfaketime)
describes this test control.

S9 should preserve the reviewed image digests, process UIDs, ports, secrets,
network boundaries, explicit operator jobs, probe meanings and measured drain
budgets. S9 adds kind, Helm, Argo CD, Kubernetes policy and drift/recovery
evidence. Compose is local; no registry publication, Kubernetes rollout, or
cloud deployment is part of S8. S12 still owns admitted shared-cache isolation
in AWS.
