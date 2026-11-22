# API mutation latency

**Alert:** `LoremasterApiMutationLatencyHigh` (ticket). The p95 latency of
`createSession`, `startCurrentAttempt` and `runGameplayCommand` is above
500 ms for 10 minutes.

## Diagnose

1. Grafana → _Loremaster API (RED)_ → **p95 latency by operation**. Compare it
   with **Event loop lag p99** and **CPU**.
   - High event-loop lag: the API process is CPU-bound. Check the pod CPU
     limit (1 core) and the load generator.
   - Normal event-loop lag: time is spent waiting on PostgreSQL. Mutations
     lock the attempt row (lock timeout 1 s, statement timeout 3 s).
2. Look for lock waits:

   ```bash
   $K exec -n loremaster postgres-0 -- psql -U postgres -d loremaster -c \
     "select wait_event_type, wait_event, count(*) from pg_stat_activity group by 1, 2 order by 3 desc"
   ```

3. Check the pool. Each API replica has 10 connections, and two replicas run.

## Mitigate

- Stop or reduce the load test. Add API replicas only when CPU is the
  bottleneck, because each replica adds database connections.
- Commands for one attempt serialize by design. A single hot attempt is not a
  defect.

## Verify

The p95 latency is below 500 ms and the alert resolves.
