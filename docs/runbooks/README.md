# S10 runbooks

Each alert in [platform/monitoring/rules.yaml](../../platform/monitoring/rules.yaml)
links one page here through `runbook_url`. `pnpm test:s10` fails when a link
has no page.

Commands assume the local kind lab from S9 and the monitoring stack from S10:

```bash
K=".cache/s9/tools/kubectl --kubeconfig .cache/s9/kubeconfig"   # kubectl.exe on Windows
pnpm s10 forward grafana       # http://127.0.0.1:3300; admin password in .cache/s10/grafana-admin.json
pnpm s10 forward prometheus    # http://127.0.0.1:9090
pnpm s10 forward alertmanager  # http://127.0.0.1:9093
```

Severity `page` means players cannot play now. `ticket` means degraded or at
risk; fix it within working hours. Two invariants shape every mitigation:
PostgreSQL is the only source of truth, and Redis and the queue are
disposable. Never delete a PostgreSQL PVC to recover; follow the
[S9 recovery guide](../development/s9-local-gitops.md).

| Alert                                                 | Runbook                                              |
| ----------------------------------------------------- | ---------------------------------------------------- |
| LoremasterApiErrorBudgetBurnFast / Slow               | [api-error-budget-burn.md](api-error-budget-burn.md) |
| LoremasterApiMutationLatencyHigh                      | [api-latency.md](api-latency.md)                     |
| LoremasterApiTargetDown, LoremasterApiNoReadyReplicas | [api-unavailable.md](api-unavailable.md)             |
| LoremasterMetricLabelPolicyDrops                      | [metric-label-drops.md](metric-label-drops.md)       |
| LoremasterQueue\*                                     | [queue-worker.md](queue-worker.md)                   |
| LoremasterDataServiceNotReady                         | [data-service.md](data-service.md)                   |
| LoremasterPodRestarting                               | [pod-restarts.md](pod-restarts.md)                   |
| LoremasterContainerMemoryNearLimit                    | [memory-pressure.md](memory-pressure.md)             |
