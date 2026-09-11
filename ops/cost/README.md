# AWS admission policy and evidence

S1 status: **DENIED / evidence not collected**. No account access, credit verification, pricing quote or provisioning occurred. The blueprint reports USD 83.99 expiring 2026-10-27; treat these as planning inputs only. Reserve USD 13.99. No personal spend is acceptable; unknown eligibility or unbounded exposure denies admission.

[AWS Budgets documentation](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html), checked 2026-09-11, explains that billing and notifications can lag and costs can exceed thresholds. Alerts/actions are defense in depth, not a hard provider cap.

## Admission arithmetic

All terms are USD, rounded upward to cents for admission. Let C be verified original eligible credit allocation for the accounting period, G cumulative gross eligible spend before credits/refunds since that allocation (including other workloads consuming it), U unreported spend allowance, R conservative maximum admitted resource hourly rate, T full TTL hours (at most 8), D teardown exposure allowance, and S retained-storage/bootstrap exposure through final deletion. Non-hourly requests, transfer, tax and other charges must be bounded in R/D/S or cause denial. Ineligible charges require separate coverage evidence consistent with zero personal spend; otherwise deny.

`maximum_exposure = G + U + R*T + D + S`

Admit only if `maximum_exposure <= C - 13.99`, inventory/eligibility are complete, and all technical gates pass. If the billing source supplies remaining credit B instead, compare only `U + R*T + D + S <= B - 13.99`; do not subtract G twice. Reconcile B against C/G and explain discrepancies conservatively. The smaller verified headroom governs. Cumulative accounting spans September and October, not a monthly reset. U must cover all known reporting lag, with USD 5 as a planning floor, not proof of sufficiency.

Synthetic arithmetic only: C=83.99, G=10, U=5, R=2, T=8, D=5, S=3 gives exposure 39 and reserve headroom 31 below the 70 ceiling. G=45 with the other terms unchanged gives 74 and is denied. Missing credit eligibility denies even the first example. Neither example constitutes live admission or a price quote.

## Required evidence before each apply

| Evidence | Required recorded value |
| --- | --- |
| Account and credit | Sanitized account reference, capture time, exact expiry/timezone, eligible services/charges, allocation and current remaining credit |
| Existing exposure | Regional and global resource inventory, cumulative gross ledger, pending charges, reporting lag and other credit-consuming workloads |
| Bill of materials | Region, supported versions, exact SKUs/counts, source/date for maximum rates, Spot capacity limits, storage/IPv4/transfer/requests/telemetry bounds |
| Calculation | C/G/U/R/T/D/S, rounding, reserve, remaining-credit cross-check, reviewer and admit/deny rationale |
| Identity and state | Short-lived bootstrap; tested constrained OIDC; encrypted locked remote state; cleanup permissions survive provision deny |
| Cleanup | Exact lab ID, pre-created one-time schedule/execution time, executor outside EKS, tested normal/emergency paths, retained-resource expiry |
| Phase gate | S11 non-EKS cleanup qualification; S12 Session A real minimal EKS cleanup before Session B application lab |
| Capacity for application | All pod requests, system reserve, storage/pod limits, four-worker ceiling and >=30% headroom on priced capacity |

No implicit on-demand fallback or enlarged node is allowed on Spot acquisition failure. Abort and destroy within the admitted timeout. Re-admit on any SKU, count, duration, retention or account-exposure change. Pricing, region and maximum allowances remain unset until verified; an empty worksheet cannot pass.

## Controls and teardown

Track cumulative gross-cost thresholds at USD 5/20/40/60/70. At 60 disable optional recovery; at 70 or failed admission freeze provisioning and clean up. Preserve cleanup, state, diagnostics and billing access. Each runtime TTL is at most eight hours and must leave bounded teardown time before its admitted deadline. Final lab October 23; October 24–26 only teardown/reconciliation; October 27 no creation.

Normal cleanup freezes deployment/provisioning, commits and observes teardown desired state, stops reconciliation, deletes exact ingress/load-balancer objects, waits for finalizers, then destroys runtime through OpenTofu. S11 must assign and test finite per-step timeouts that fit D; no unset timeout passes admission.

When Git, Argo or Kubernetes misses its timeout, keep the freeze and use AWS-native deletion with deterministic lab ownership plus regional/global inventory. Include controller-created ALBs, listeners, target groups, security groups, ENIs, EBS and out-of-state resources; refresh/destroy with bounded retries and record state reconciliation. Never delete ambiguous unrelated resources. Investigate them and keep admission denied. Cleanup cannot depend on the cluster it deletes.

Residual proof covers EKS/nodes, NAT, ALB, EIP/public IPv4, RDS, ElastiCache, EBS/snapshots, ECR, S3, CloudWatch, Secrets Manager, scheduler/build executor, state storage and Route 53. Tags/state alone are insufficient. Preserve cleanup/state until runtime absence is verified, export sanitized evidence, then delete or expire chargeable retained/bootstrap resources. Repeat inventory and billing reconciliation through October 26; delayed charges are not assumed zero.

Use the [ledger](ledger.md) for live evidence. Failed admission leaves local development available and AWS disabled.
