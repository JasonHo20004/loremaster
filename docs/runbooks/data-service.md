# Data service not ready

**Alert:** `LoremasterDataServiceNotReady` (page) for `postgres` or `redis`.

## PostgreSQL

PostgreSQL holds every game result. Treat this as the most serious alert.

```bash
$K get pod -n loremaster postgres-0 -o wide
$K describe pod -n loremaster postgres-0 | tail -30
$K logs -n loremaster postgres-0 --tail=80
$K get pvc -n loremaster data-postgres-0
```

- `No space left on device`: the PVC is 1 Gi. Do not delete data. Expand the
  storage, or restore into a larger volume once the backup gate (G5) exists.
- Crash after node loss: kind local volumes are bound to one node. Follow the
  [S9 recovery guide](../development/s9-local-gitops.md).
- **Never delete the PVC, and never delete the StatefulSet with cascading
  deletion, to recover.**

## Redis

Redis is disposable. Gameplay continues with degraded suggestions, and the
shared limiter falls back to its documented behavior.

```bash
$K logs -n loremaster redis-0 --tail=80
```

- Memory at the limit with `noeviction`: writes fail. Go to
  [memory-pressure.md](memory-pressure.md).
- Restarting the pod is safe; AOF restores the queue state.

## Verify

The StatefulSet has one ready replica, API readiness returns 200, and the
alert resolves.
