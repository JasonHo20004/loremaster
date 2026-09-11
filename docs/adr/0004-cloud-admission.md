# ADR 0004: Default-deny AWS admission and independent cleanup

Status: Accepted | Date: 2026-09-11

Context: The blueprint reports USD 83.99 credit expiring October 27, 2026 and permits no personal spend. Neither credit eligibility nor account exposure has been verified in S1. Delayed billing and failed teardown can exceed a nominal budget.

Decision: AWS stays denied until the [admission evidence](../../ops/cost/README.md) proves conservative exposure preserves USD 13.99. S11 establishes short-lived bootstrap identity, remote state, constrained OIDC publication, and an independent EventBridge Scheduler → CodeBuild cleanup role before runtime. Cleanup privileges survive provisioning denial. S12 first qualifies real minimal EKS cleanup; only afterward may a separately admitted application lab run. Every runtime has a pre-created cleanup schedule and maximum eight-hour TTL. October 23 is the final planned lab; October 24–26 are cleanup only; October 27 creates nothing.

Alternatives: Budget notifications alone, TTL tags without an executor, cleanup hosted on EKS, and manual best-effort deletion are rejected. An always-on cluster or silent larger node fallback cannot fit the intended governance.

Consequences: Safe refusal of AWS is a valid outcome; local work continues. No control guarantees a provider-enforced spending cap. Missing evidence, ineligible charges, or unbounded exposure means denial. Preserve cleanup, billing, diagnostics and state access while freezing provisioning. A normal Git/Argo/Kubernetes teardown must time out into AWS-native emergency deletion and residual reconciliation, never wait forever.

Verification: S1 worksheet arithmetic and fail-closed examples; S11 non-EKS executor and simulated dependency failures; S12 real normal/emergency cleanup before application admission. No such infrastructure tests are claimed by S1.
