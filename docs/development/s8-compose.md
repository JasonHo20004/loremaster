# S8 local Compose stack

The stack uses the six reviewed `loremaster/*:s8` images, PostgreSQL 17.6 and
Redis 7.4.5 at immutable digests. The only default host listener is the web
gateway at `127.0.0.1:8080`. PostgreSQL and Redis store data in separate named
volumes on the internal backend network. Web and API share the fixed edge
network from [`local-edge.json`](../../ops/s8/local-edge.json).

Run these commands from the repository root after `pnpm build` and
`pnpm build:images`:

```sh
node scripts/s8-compose.mjs config
node scripts/s8-compose.mjs bootstrap
node scripts/s8-compose.mjs start
node scripts/s8-compose.mjs status
node scripts/s8-compose.mjs logs
```

`bootstrap` creates `deploy/compose/local-secrets` with random credentials,
runs the isolated credential preparation job, starts the two data services,
applies forward migrations with the migration image, and grants four distinct
login roles. It is explicit and repeatable.
`start` never migrates or imports. The API, worker, and observer receive only
their own file secrets. The generated directory is ignored by Git; back it up
with the volumes, since regenerating passwords for a retained database would
strand its logins. The script refuses a new secret directory when it finds an
existing PostgreSQL volume. The
volume listing must succeed before new credentials can be generated; daemon or
permission failures abort bootstrap. Compose file secrets are bind mounts: the local
tests inspect actual owner and mode inside the Linux containers rather than
assuming the YAML `mode` field is enforced.

To publish a reviewed content pack, set `LOREMASTER_S8_CONTENT_FILE` to an
absolute path of a regular `pack.json`, then run:

```sh
node scripts/s8-compose.mjs import --dry-run
node scripts/s8-compose.mjs import
```

The wrapper rejects empty, non-regular or larger-than-256KiB packs before
starting Compose. The preparation job independently validates the opened file
and performs a bounded read, so direct profile invocation has the same limit.
The content preparation job copies that file into an importer-only volume as
UID 10006 with mode `0400`; this also handles Docker Desktop's bind-mount mode.
The importer is a one-shot `operator` profile. The migration image is also an
operator profile, and its entrypoint accepts apply only. Production corrections
use new forward migrations. Teardown never invokes down migrations.

For a browser smoke test, open `http://localhost:8080`. `status` shows
container health; `logs api` or `logs redis` shows bounded, rotated logs. To
stop without deleting database or queue state:

```sh
node scripts/s8-compose.mjs stop
```

Only an isolated test project is removed with volumes by the test harness.
Developer volume deletion is an explicit operator action after a backup. Do
not run a broad Docker prune command for this stack.

The two acceptance commands use unique `loremaster-s8-test-*` projects and
remove only their own containers, networks, volumes, and generated secrets:

```sh
pnpm test:s8:data-services
pnpm test:s8:compose
```

The later acceptance gates use their own exactly named, disposable projects:

```sh
pnpm test:s8:lifecycle
pnpm test:s8:e2e
pnpm test:images
```

`test:s8:e2e` builds the six application images, imports two adjacent
24-hour Aster Quay revisions through the operator image, runs browser journeys
through the gateway, and runs T25 in a second project. T25 builds a disposable
PostgreSQL image with pinned `libfaketime`; its clock file is host-controlled
and mounted read-only to PostgreSQL. This image is removed after the test and
never enters a production build context. Each test writes JSON results under
`.cache/` and fails if any labeled container, network or volume remains.

Resource and security limits are declared on every service. PostgreSQL keeps
only the capability set its image needs to initialize and own its data volume;
application and Redis services drop all capabilities. The backend network is
internal, and no database or queue port is published. The API can continue
using PostgreSQL and its local limiter if Redis restarts. Readiness only gates
initial developer startup; S8.8 measures later dependency recovery and drain
behavior separately.

Application shutdown grace is explicit: API/worker 20 seconds, observer/web
15 seconds. The lifecycle gate exercises these defaults and checks Docker's
effective timeout. It holds an API-acknowledged private request during SIGTERM;
the gateway buffers request bodies and cannot prove this condition by itself.

The [independent acceptance review](../architecture/s8-review.md) records
corrections and the [acceptance map](../architecture/s8-acceptance.md) links CI
evidence. `pnpm --filter @loremaster/web test:e2e` separately runs five Chromium
shell/accessibility journeys against Vite preview; packaged E2E includes mobile
skip-link and focus checks through the actual gateway.

Docker Desktop on Windows exposes file-backed Compose secrets as `0555` in
Linux containers, which the runtime parser rejects. The preparation job reads
the Compose secrets without a network and copies them into separate named
credential volumes owned by each service UID with mode `0400`. Runtime mounts
are read-only. Retain these credential volumes together with the data volumes.
