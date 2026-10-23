# S9 — Local Kubernetes and GitOps

S9 translates the accepted [S8 contracts](../docs/architecture/s8-acceptance.md)
into a four-node local kind environment. Application behavior and original
content remain governed by the existing API, database and content contracts.
The operator guide is [s9-local-gitops.md](../docs/development/s9-local-gitops.md).

## Scope and acceptance

| Slice | Deliverable                                                                 | Gate                                                                               |
| ----- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| S9.0  | Pinned tools, explicit Linux Docker capacity admission, isolated kubeconfig | `pnpm s9 tools`, `pnpm s9 preflight`                                               |
| S9.1  | kind: one control plane, three workers; hash-verified Calico and Argo       | `pnpm s9 cluster`; four Ready nodes                                                |
| S9.2  | Non-root Helm workloads, probes, grace, resources, PVC retention            | `pnpm test:s9`; effective runtime checks                                           |
| S9.3  | Per-role file secrets and explicit migration/import Jobs                    | `pnpm s9 bootstrap`, `pnpm s9 import`; no automatic Jobs in GitOps                 |
| S9.4  | Current scanned OCI config → verified registry manifest digest              | `pnpm test:images`, `pnpm s9 promote`                                              |
| S9.5  | Separate local Git remote; constrained AppProject; auto-prune/self-heal     | `pnpm s9 sync`; desired Git revision Synced/Healthy                                |
| S9.6  | Networking, drift/PVC/Git recovery, kernel Redis PID limit, active drain    | `pnpm test:s9:runtime`, `pnpm test:s9:drain`                                       |
| S9.7  | Reproducible operator guide, CI policy gate, evidence and bounded teardown  | This record and acceptance map; `destroy --delete-data` on disposable environments |

Static validation uses synthetic image digests and does not prove runtime
acceptance. Runtime acceptance requires `.cache/s9/runtime.json` with
`passed: true`, the exact desired Git revision, and current promotion evidence.
An absent or failed result remains pending. Do not substitute S8 lifecycle
measurements for measurements from Kubernetes.

## Decisions

- Use Calico with the default kind CNI disabled, so NetworkPolicy is enforced.
  A default deny covers ingress and egress. Only DNS and the three reviewed
  application paths are allowed. Web is exposed by loopback port-forward.
- Keep one gateway with a Calico-allocated fixed pod IP and `Recreate` rollout;
  the API trusts exactly that `/32`. The local gateway has a rollout outage.
  Do not expand proxy trust to a pod CIDR to enable extra replicas.
- Mount each secret file through read-only `subPath`, because Kubernetes
  projected-volume symlinks fail the existing secret-reader contract. Rotation
  requires explicit reconciliation and restart; it is not live file rotation.
- Use containerd RuntimeClasses for the 1,024 FD ceiling and container PID
  ceilings of 128 for applications and 64 for Redis. Keep kubelet pod ceiling
  128 on every node. Verify Redis OCI resources and kernel cgroup v1/v2.
  Admission binds Redis to its dedicated handler. Resource
  requests/limits, bounded memory-backed temporary paths, Pod Security
  Admission and a validating admission policy constrain application pods.
- Keep PostgreSQL and Redis in retained PVCs, Redis AOF and `noeviction`.
  Pod recovery retains data. Deleting kind destroys its node-backed local
  volumes: local persistence is not a backup or cross-node recovery guarantee.
- Promote the six S8 images only when current context/source/config IDs match
  fresh successful scans. A registry manifest digest is distinct from a local
  image config ID. Pull each digest back and compare its config ID to the
  scanned image. No public registry or cloud credentials are involved.
- Snapshot only the chart and admitted image values into a separate local
  Git repository. A read-only Git daemon on the kind Docker network serves
  that repository to Argo. Main repository history and remotes are unchanged.
  Secrets, original content packs and private fixture files never enter it.
- Argo manages application Deployments, StatefulSets, Services, service
  accounts, PDB and NetworkPolicies. Namespace, controllers, admission policy,
  RuntimeClass, credentials, migration and import remain explicit platform or
  operator actions. Argo cannot apply Jobs or Secrets through this AppProject.
- Bootstrap creates data services and runs migration/role provisioning before
  Argo owns the runtime. Later schema changes are explicit migration Jobs;
  application rollback uses compatible images and forward schema corrections.

## Delivery status

Implementation and local evidence are recorded in the
[S9 acceptance map](../docs/architecture/s9-acceptance.md). Acceptance is based
on executed gates, not the existence of configuration files. S10 observability
and S11–S12 cloud work remain separate stages.
