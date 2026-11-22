# Cache-warming queue

**Alerts:** `LoremasterQueueWorkerDisconnected`,
`LoremasterQueueObserverDegraded`, `LoremasterQueueBacklog`,
`LoremasterQueueFailedJobs` (ticket).

**Impact:** the queue only warms the suggestion cache. Gameplay never waits on
it, and losing Redis loses no game result. Expect slower or cold suggestions,
not failed play. These alerts never page.

## Diagnose

```bash
$K get pods -n loremaster -l 'app.kubernetes.io/name in (worker,observer,redis)'
$K logs -n loremaster deploy/worker --tail=50
$K logs -n loremaster deploy/observer --tail=50
```

- Worker disconnected: the worker pod is down, or it cannot reach Redis
  (NetworkPolicy `redis-ingress`, ACL user in `ops/redis/acl-policy.json`).
- Observer degraded: the observer cannot read the queue keys. Usually Redis is
  down; go to [data-service.md](data-service.md).
- Backlog: the worker is slow or stuck. Check its CPU and logs.
- Failed jobs: read the cause in the worker logs. The failed set is kept for
  diagnosis and pruned by the retention policy.

`loremaster_queue_oldest_retained_age_seconds` measures how long completed and
failed jobs are retained. It is not a backlog signal, so no alert uses it.

## Mitigate

Restart the worker with `$K rollout restart -n loremaster deploy/worker`. It
drains active work on SIGTERM. Do not flush Redis to clear the queue unless
the S9 recovery guide tells you to.
