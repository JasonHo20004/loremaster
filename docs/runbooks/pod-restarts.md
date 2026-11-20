# Pod restarting

**Alert:** `LoremasterPodRestarting` (ticket). A container restarted more than
twice in 15 minutes.

## Diagnose

```bash
$K get pod -n loremaster <pod> -o jsonpath='{.status.containerStatuses[*].lastState}'
$K logs -n loremaster <pod> --previous --tail=80
```

- `OOMKilled`: go to [memory-pressure.md](memory-pressure.md).
- Exit code 1 with a `"level":"fatal"` line: an unhandled error. The `cause`
  field names the error class or SQLSTATE.
- Liveness probe failures: the process stopped answering `/health/live`.
  Check event-loop lag in Grafana.
- The PID ceiling (128 for applications, 64 for Redis) can stop processes
  that fork.

## Mitigate

Fix the cause, because repeated restarts hide evidence. Roll back the release
if the restarts began with a new revision.
