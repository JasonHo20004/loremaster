# Container memory near limit

**Alert:** `LoremasterContainerMemoryNearLimit` (ticket). The working set is
above 90% of the container memory limit for 10 minutes.

## Diagnose

Grafana → _Loremaster cache-warming queue_ → **Container memory vs limit**.
Limits: API and worker 256 Mi, observer and web 128 Mi, PostgreSQL 512 Mi,
Redis 192 Mi.

- **Redis** runs `noeviction`. At the limit, writes fail instead of evicting
  keys. Gameplay is unaffected because Redis holds only caches and queue
  state, but cache warming and the shared limiter degrade. Check the key
  count and the retained completed and failed job sets.
- **API**: compare `nodejs_heap_used_bytes` with
  `process_resident_memory_bytes`. Steady growth under constant load suggests
  a leak. Capture a heap snapshot in a local run, not in the cluster.

## Mitigate

Raise a limit only through the Helm values and a reviewed change, within the
`local-budget` ResourceQuota. Do not switch Redis to an eviction policy; the
[architecture baseline](../architecture/README.md) and the
[Redis runtime policy](../../ops/redis/README.md) require `noeviction`.
