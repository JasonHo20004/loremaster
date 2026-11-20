# API error budget burn

**Alerts:** `LoremasterApiErrorBudgetBurnFast` (page),
`LoremasterApiErrorBudgetBurnSlow` (ticket).

**Meaning:** more than 7.2% (fast) or 3% (slow) of player-facing requests
return 5xx. Health probes are excluded. At the fast rate, the 30-day budget of
0.5% is spent in about two days.

## Diagnose

1. Grafana → _Loremaster API (RED)_ → **5xx ratio** and **Request rate by
   operation**. Find the `operation` that carries the errors.
2. Read the logs. Every 5xx line has `level: "error"`, a public `errorCode`
   and a redacted `cause`:

   ```bash
   $K logs -n loremaster deploy/api --since=15m | grep '"level":"error"'
   ```

   - `cause: "sqlstate:57P01"` or `"sqlstate:08006"`, or `errorCode:
"REQUEST_TIMEOUT"`: PostgreSQL is unavailable or slow. Go to
     [data-service.md](data-service.md).
   - `sqlstate:40P01` (deadlock) or `sqlstate:55P03` (lock not available):
     lock contention on attempts. Look for a stuck transaction (step 3).
   - `errorCode: "SERVICE_UNAVAILABLE"`: the readiness dependency gate failed.

3. Look for long-running transactions:

   ```bash
   $K exec -n loremaster postgres-0 -- psql -U postgres -d loremaster -c \
     "select pid, state, now() - xact_start as age, wait_event_type from pg_stat_activity where xact_start is not null order by age desc limit 5"
   ```

## Mitigate

- Bad release: roll back through Argo CD to the previous admitted revision
  ([S9 guide](../development/s9-local-gitops.md)). Schema changes are
  forward-only, so roll back only to an image that is compatible with the
  current schema.
- PostgreSQL overload: reduce load (stop the load test) before you restart
  anything. Restarting the API does not fix database saturation.
- Never fix errors by disabling CSRF, origin or rate-limit checks.

## Verify

The 5xx ratio is below 0.5% and the alert resolves. Record the cause and the
time window in the incident notes.
