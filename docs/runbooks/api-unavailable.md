# API unavailable

**Alerts:** `LoremasterApiTargetDown`, `LoremasterApiNoReadyReplicas` (page).

**Meaning:** Prometheus cannot scrape any API pod, or the API Deployment has
no ready replica. Players get errors from the web gateway.

## Diagnose

```bash
$K get pods -n loremaster -l app.kubernetes.io/name=api -o wide
$K describe pod -n loremaster -l app.kubernetes.io/name=api | tail -30
$K logs -n loremaster deploy/api --previous --tail=50
```

- `CrashLoopBackOff` with a `"level":"fatal"` line: read its `cause`. A
  configuration error prints `Loremaster API failed to start`; compare the
  environment with `deploy/helm/loremaster/values.yaml`.
- Readiness fails while pods run: the API cannot reach PostgreSQL. Go to
  [data-service.md](data-service.md).
- Pods are ready but `TargetDown` fires: the scrape path is broken. Check the
  `monitoring-scrape` NetworkPolicy and the `metrics` port (9464):

  ```bash
  $K get networkpolicy -n loremaster monitoring-scrape -o yaml
  ```

## Mitigate

- Bad image or configuration: roll back through Argo CD to the last healthy
  revision.
- Do not run migrations to fix startup. The API never migrates.

## Verify

Both API pods are `Ready`, `up{service="api"}` is 1 for each, and the web
journey works through `pnpm s9 forward`.
