# Metric label policy drops

**Alert:** `LoremasterMetricLabelPolicyDrops` (ticket).

**Meaning:** the API recorded a metric point whose labels were outside the
bounded vocabulary (an unknown operation name or status class), or whose value
was not finite. The sink dropped the point instead of creating a series. This
guard prevents high cardinality and stops a path or identifier from leaking
into labels.

## Diagnose

The dropped point is never rendered, so find the source in code.
`apps/api/src/http/telemetry.ts` sets `operation` from the route table, and
`packages/observability/src/prometheus.ts` enforces the policy. The usual
cause is a new route registered without `identifyTelemetryOperation`, or an
operation name with invalid characters. Run `pnpm test` and confirm that
`tests/observability/prometheus.test.ts` and `tests/api/telemetry.test.ts`
pass.

## Mitigate

Fix the label source in code. Do not relax the label pattern to accept raw
paths or identifiers.
