# S9 local Kubernetes/GitOps evidence

The [S9 plan](../../plans/s9-local-gitops.md) and
[operator guide](../development/s9-local-gitops.md) define the local setup.
The non-secret [2026-10-23 snapshot](s9-evidence-2026-10-23.json) records
the executed gates, image/config/context identities, desired Git revision,
node versions and runtime measurements. Missing or failing evidence does
not count as a pass.

Technical acceptance for S9's local scope is **PASS**: hosted CI,
active Kubernetes drain and Redis PID gates are verified.
[PR #19](https://github.com/JasonHo20004/loremaster/pull/19) carries the delivery;
its [checks page](https://github.com/JasonHo20004/loremaster/pull/19/checks)
tracks the final documentation head. The [hosted record](s9-ci-2026-10-23.json)
binds successful runs, checkout revisions, artifact identity and clean-lab
measurements. This stage does not require merging later S10–S12 work.

## Implemented gates

| Contract | Reproduction | Evidence |
| --- | --- | --- |
| Hash-pinned tools, four-node capacity admission | `pnpm s9 tools`, `pnpm s9 preflight` | `.cache/s9/preflight.json` |
| One control plane/three workers; Calico policy enforcement; Argo controllers | `pnpm s9 cluster` | `.cache/s9/platform.json`; runtime node/readiness checks |
| Rendered Helm policy and isolated operators | `pnpm test:s9` | `.cache/s9/static-policy.json`; 21 focused tests |
| Six reproducible, minimal, scanned S8 images | `pnpm test:images` | `.cache/s8-build-results.json`, `.cache/s8-reproducibility.json`, `.cache/s8-evidence/summary.json` and raw SBOM/scan files |
| Patched musl in six application and two data images | `pnpm test:s9:musl` | `.cache/s9/musl.json`; exact package versions and CVE-2026-107891 absence in all eight raw scans; UNKNOWN findings block application image admission |
| Registry manifest/config binding | `pnpm s9 promote` | `.cache/s9/promotion.json`; hash raw registry manifests and compare their config digest to saved scanner config hash |
| Explicit migration and role provisioning | `pnpm s9 bootstrap` | `.cache/s9/bootstrap.json`; no Job or Secret in Argo-managed chart output |
| Git desired state, self-heal and rollback | `pnpm s9 sync`, `pnpm test:s9:runtime` | `.cache/s9/gitops-source.json`, `.cache/s9/runtime.json`; exact desired revision Synced/Healthy |
| Effective secret files and FD bound | `pnpm test:s9:runtime` | Read-only regular files with root/process ownership and accepted modes; effective `nofile=1024` |
| Redis-only PID bound | `pnpm test:s9:runtime` | Dedicated RuntimeClass; OCI `linux.resources.pids.limit=64` and kernel `pids.max=64` on cgroup v1/v2 |
| Active Kubernetes shutdown and replay | `pnpm test:s9:drain` | `.cache/s9/drain.json`; actual kubelet SIGTERM, CRI exit zero, active worker/read barrier, acknowledged incomplete HTTP request, observer/web idle exit, replay once and zero gameplay effects; isolated test namespace/PVs reclaimed |
| Allowed/denied paths and persistence | `pnpm test:s9:runtime` | DNS must resolve before denial is counted; PostgreSQL schema/PVC unchanged; Redis cache marker survives pod replacement using AOF/PVC |
| Packaged web and real guest session | `pnpm test:s9:runtime` | Gateway HTML and POST session through real API with local cookies |
| Exact teardown of a disposable local lab | `pnpm s9 destroy --delete-data` | `.cache/s9/teardown.json`; final lab remains running |
| Hosted CI and fresh Linux lab | PR/push/manual workflows | [CI](https://github.com/JasonHo20004/loremaster/actions/runs/39904324826), [S9 runtime](https://github.com/JasonHo20004/loremaster/actions/runs/39904324620); non-secret artifacts include runtime, drain, raw scans/SBOM and teardown |

The local runtime passed all 12 checks on 2026-10-23: replica drift repair
1.739s, PostgreSQL pod/PVC recovery 4.099s and Redis AOF/PVC recovery 4.044s.
The active worker drained in 1.246s; the acknowledged incomplete HTTP request
closed in 9.928s. Observer and web exited in 0.305s and 2.165s. All four
containers exited zero within their unchanged 20s/15s budgets. The exact
warm job ID was the sole retained completed job after worker replacement, and all eight gameplay
tables remained empty. Test namespace storage was reclaimed.
This is a cache replay observation, not an exactly-once queue execution guarantee.

Drain timings are conservative monotonic measurements from the host's
deletion request to observation of `CONTAINER_EXITED` in CRI. They include
RPC/poll overhead; CRI's wall-clock finish timestamp is retained separately.
Host/VM clocks are never subtracted. These observations are not universal
latency promises. `verify` passed (446 tests, 2 configured skips), the S9
policy gate passed 21 tests, and the patched Vitest browser provider passed
11 component tests. Local logs remain in `.cache/s9/`.

## Corrections verified during local setup

- The musl regcomp advisory [CVE-2026-107891](https://www.openwall.com/lists/oss-security/2026/10/21/18)
  requires Alpine's backport even while scanner severity is UNKNOWN. Runtime
  assembly now installs exact musl `1.2.6-r3` before copying libraries and
  package records. PostgreSQL 17.11 carries `1.2.6-r3`; Redis 7.4.11 carries
  Alpine 3.21's fixed `1.2.5-r12`. Both data images are pinned by digest.
  CI rejects UNKNOWN/unclassified application findings and verifies actual
  package inventory and advisory absence in all eight images. No exception
  was added. Current-head execution is reported by PR checks and its artifacts.
- CI uses checksum-pinned kubectl 1.34.1 rather than the runner's newer
  preinstalled client. The dependency audit found new Vitest 5.0.0 advisories;
  Vitest and its browser provider are pinned together at patched 5.0.5.
- The S9 image gate installs Chromium explicitly, as required by the packaged
  browser behavior check. Artifact capture distinguishes the retained local
  lab from the hosted job's following `always` teardown step.
- Calico uses iptables and omits the optional eBPF securityfs mount that
  cannot be created inside kind's read-only nested `/sys` on Docker Desktop.
- The dedicated RuntimeClass extends kind's original OCI base spec and its
  v2 containerd config namespace. It retains the existing systemd cgroup
  driver and explicitly enables `/etc/containerd/certs.d` registry hosts.
- Secret mode is decimal 292, equivalent to `0444`, so YAML 1.1/1.2 and
  JSON rendering cannot reinterpret the permission value. Per-file `subPath`
  mounts preserve the S8 reader's symlink rejection.
- The separate local Git remote uses a read-only Git daemon from the pinned
  Argo image. Argo's list-refs path rejected the initial dumb HTTP server.
  Sync waits for actual repo-server access before requesting a hard refresh.

## Evidence revisions and operating boundaries

The local snapshot labels image inputs at `fa00460563bf744da82d3b3251fc68c7f0e81c8e`
and marks the pending test/workflow corrections explicitly. Those corrections
are committed in `29ebba3e64eb91433d832169d80be528bc4dfa44`; the hosted record
proves that clean revision, including its synthetic PR merge checkout. Image
context hashes bind actual build inputs. Git desired-state commits belong to
the separate local repository. The checks page covers the subsequent
documentation head. Public registry release, independent peer review,
full observability and AWS admission remain outside these runtime claims.

The gateway is one fixed Calico IP with a Recreate rollout. Secrets mounted
through `subPath` require a restart after deliberate rotation. PVCs use kind's
node-local storage; pod recovery does not prove recovery after node/cluster
loss. The kubelet imposes a uniform 128 PID ceiling per pod; dedicated
containerd handlers impose container ceilings of 128 and Redis-only 64.
OCI resources and the effective kernel cgroup limit are both checked.
CPU/memory limits and the 1,024 FD ceiling are retained.

S8's browser gameplay and T25 gates remain in the main CI workflow.
S9 adds cluster-specific active-work/drain measurements in a disposable
namespace. No original content pack is automatically imported into the retained lab;
the gateway smoke test creates one anonymous guest/session. Release rollback
uses compatible images and forward schema corrections.
