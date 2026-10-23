# S9 local Kubernetes/GitOps evidence

The [S9 plan](../../plans/s9-local-gitops.md) and
[operator guide](../development/s9-local-gitops.md) define the local setup.
The non-secret [2026-10-23 snapshot](s9-evidence-2026-10-23.json) records
the executed gates, image/config/context identities, desired Git revision,
node versions and runtime measurements. Missing or failing evidence does
not count as a pass.

## Implemented gates

| Contract | Reproduction | Evidence |
| --- | --- | --- |
| Hash-pinned tools, four-node capacity admission | `pnpm s9 tools`, `pnpm s9 preflight` | `.cache/s9/preflight.json` |
| One control plane/three workers; Calico policy enforcement; Argo controllers | `pnpm s9 cluster` | `.cache/s9/platform.json`; runtime node/readiness checks |
| Rendered Helm policy and isolated operators | `pnpm test:s9` | `.cache/s9/static-policy.json`; 21 focused tests |
| Six reproducible, minimal, scanned S8 images | `pnpm test:images` | `.cache/s8-build-results.json`, `.cache/s8-reproducibility.json`, `.cache/s8-evidence/summary.json` and raw SBOM/scan files |
| Registry manifest/config binding | `pnpm s9 promote` | `.cache/s9/promotion.json`; hash raw registry manifests and compare their config digest to saved scanner config hash |
| Explicit migration and role provisioning | `pnpm s9 bootstrap` | `.cache/s9/bootstrap.json`; no Job or Secret in Argo-managed chart output |
| Git desired state, self-heal and rollback | `pnpm s9 sync`, `pnpm test:s9:runtime` | `.cache/s9/gitops-source.json`, `.cache/s9/runtime.json`; exact desired revision Synced/Healthy |
| Effective secret files and FD bound | `pnpm test:s9:runtime` | Read-only regular files with root/process ownership and accepted modes; effective `nofile=1024` |
| Redis-only PID bound | `pnpm test:s9:runtime` | Dedicated RuntimeClass; OCI `linux.resources.pids.limit=64` and kernel `pids.max=64` on cgroup v1/v2 |
| Active Kubernetes shutdown and replay | `pnpm test:s9:drain` | `.cache/s9/drain.json`; actual kubelet SIGTERM, CRI exit zero, active worker/read barrier, acknowledged incomplete HTTP request, observer/web idle exit, replay once and zero gameplay effects; isolated test namespace/PVs reclaimed |
| Allowed/denied paths and persistence | `pnpm test:s9:runtime` | DNS must resolve before denial is counted; PostgreSQL schema/PVC unchanged; Redis cache marker survives pod replacement using AOF/PVC |
| Packaged web and real guest session | `pnpm test:s9:runtime` | Gateway HTML and POST session through real API with local cookies |
| Exact teardown of a disposable local lab | `pnpm s9 destroy --delete-data` | `.cache/s9/teardown.json`; final lab remains running |

The first complete local runtime run passed all ten checks on 2026-10-23.
It measured replica drift repair at 1.724s, PostgreSQL pod/PVC recovery at
3.958s and Redis AOF/PVC recovery at 4.440s. These are observations, not
universal budgets. The durable snapshot carries the final reproduction run.
The full repository `verify` gate passed; the final validation record is
`.cache/s9/verify.log`. Hosted CI is configured but has not been run for this
working tree.

## Corrections verified during local setup

- CI uses checksum-pinned kubectl 1.34.1 rather than the runner's newer
  preinstalled client. The dependency audit found new Vitest 5.0.0 advisories;
  Vitest and its browser provider are pinned together at patched 5.0.5.
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

## Boundaries and remaining acceptance

This is local setup evidence. It does not claim a public registry release,
hosted CI acceptance, an independent S9 review, full observability or AWS
admission. The source revision is the repository HEAD; context hashes bind
the actual working-tree image inputs. The snapshot marks uncommitted changes
explicitly. Git desired-state commits belong to the separate local repository.

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
