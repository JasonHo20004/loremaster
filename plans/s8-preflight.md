# S8.0 delivery preflight

Recorded 2026-10-02 from a clean worktree based on accepted S7 `main`
`e41cab1c7170c6b9320fe3ee7cef28ea5e1f86a9` (merged PR #13). The
[S7 acceptance record](../docs/architecture/s7-acceptance.md) and
[S7 progress checklist](s7-cache-worker.md#progress) are complete. This
preflight replaces the blocked 2026-09-29 inspection of the older
`cache-worker` branch. The accepted S7 commit, not that branch, is the S8
source baseline.

## Process and ownership inventory

| Process          | Executable host surface                                         | Binding, health, and lifecycle                                                                              | Owner of data                                          |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Web              | `pnpm --filter @loremaster/web build` and `preview`             | Vite preview 127.0.0.1:4173; browser assets have no durable state; S8.5 owns gateway lifecycle              | Browser state only                                     |
| API              | `pnpm --filter @loremaster/api start`                           | 127.0.0.1:3000 default; `/health/live` process-only, `/health/ready` PostgreSQL-only; ten-second HTTP drain | PostgreSQL authoritative; Redis optional               |
| Worker           | `pnpm --filter @loremaster/worker start`                        | 127.0.0.1:3001; private live/ready; ten-second work drain and cancellation                                  | PostgreSQL read, disposable Redis warm cache/job state |
| Observer         | `pnpm --filter @loremaster/queue-observer start`                | 127.0.0.1:3002; private live/ready and fixed `/metrics`; one-second close budget                            | Redis aggregate reads only                             |
| Content importer | `pnpm content:import`                                           | Explicit finite operator command; no listener                                                               | PostgreSQL published content, importer role            |
| Migration        | `migrateToLatest(db)` export, exercised by `pnpm test:database` | Explicit finite operator action; standalone image entrypoint belongs to S8.4                                | PostgreSQL schema owner                                |
| PostgreSQL       | Pinned disposable S7 harness                                    | Required for gameplay/readiness; no API startup migration                                                   | Authoritative gameplay and content                     |
| Redis            | Pinned disposable S7 harness                                    | Optional cache, queue and limiter; outage degrades without changing gameplay truth                          | Disposable cache/queue/limit state                     |

The exact S7 environment variable and Redis ACL inventory is in
[`ops/redis/README.md`](../ops/redis/README.md); the HTTP/cookie inputs are in
[`packages/config/src/index.ts`](../packages/config/src/index.ts). The
[S7 runtime contract](../docs/architecture/s7-acceptance.md#runtime-contract-for-s8)
freezes probes, queue limits, timeouts, shutdown and source disclosure. S8.2
adds file inputs without changing those runtime decisions. S8.4 must create a
standalone migration operator command before packaging it as an image.

## Host and S7 gates

Node 22.17.0 and pnpm 11.19.0 are the repository pins. The default Windows
shell selected Node 22.12.0 and a broken global pnpm shim. The preflight used
the installed Node 22.17.0 and a Corepack shim in a named temporary directory;
the pinned command surface and nested pnpm scripts then passed. Frozen install
passed. Docker Engine 28.5.1 (Linux/amd64), Compose 2.40.0, Buildx 0.29.1,
and BuildKit 0.25.1 were inspected. A scratch BuildKit cache-only smoke build
passed. These exact versions are the tested local minimum for S8 until a
separate lower-version test qualifies a broader range.

| Gate                                      | Result                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run verify` before S8 edits         | PASS; format, lint, typecheck, 369 tests, all workspace builds                                                                                                |
| `pnpm test:s7:contracts`                  | PASS; 88 tests                                                                                                                                                |
| `pnpm test:database`                      | PASS; 93 PostgreSQL tests                                                                                                                                     |
| `pnpm test:api:database`                  | PASS; 7 tests after making the profile test publish its own fixture                                                                                           |
| `pnpm test:redis`                         | PASS; 8 real Redis scenarios                                                                                                                                  |
| `pnpm test:s7:integration`                | PASS; 9 composed scenarios, no skips                                                                                                                          |
| Web component and real-stack E2E          | PASS; 11 component, 4 real-stack and 5 shell/accessibility tests. First E2E attempt timed out after reveal under concurrent scanning; the clean rerun passed. |
| `pnpm test:web:disclosure`                | PASS; five artifacts, no private markers                                                                                                                      |
| `pnpm audit --audit-level moderate`       | PASS; no known dependency vulnerabilities                                                                                                                     |
| Production license inventory              | 101 package/version entries: 89 MIT, 3 Apache-2.0, 7 ISC, 1 BSD-3-Clause, 1 0BSD                                                                              |
| Pinned Gitleaks 8.30.0 on accepted `main` | PASS; 53 commits, about 1.62 MB, no leaks                                                                                                                     |

The API/PostgreSQL test had relied on another test file to import a region;
its isolated fixture setup was corrected in this branch before rerunning the
gate. That is test determinism work, not a changed gameplay contract.

## Candidate supply chain and admission

Registry manifests were inspected on 2026-10-02 for `linux/amd64` and frozen
by digest in [`deploy/images/contracts.json`](../deploy/images/contracts.json).
The official Node 22.17.0 Bookworm and slim images match the accepted runtime
pin; their source annotation points to `nodejs/docker-node` revision
`d78e8df65f94f391ba1adf67f7ef1e2596ac92f1`. The Node project uses MIT;
Debian components require per-image license inventory. The newer official
Node 22.23.3 slim candidate has digest
`sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`
and source revision `81f419144a1251854c6d9afb09eaa39928e724e8`.
The NGINX unprivileged 1.29.5 Alpine candidate has digest
`sha256:42a7d7f2ee23e9f5a1dcdf3647ba5c585bbd18f79e79cd817e70e8cd61c55779`;
its Dockerfile repository is Apache-2.0. All component licenses need an SBOM
and policy review when images are assembled.

Scanner candidate: Trivy 0.74.0,
`sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969`.
Its database is mutable, so results are time-stamped and rescanned at each
image slice. The 2026-10-02 scan found 2,175 HIGH/CRITICAL Debian plus 40
HIGH/CRITICAL Node.js findings in the Node 22.17.0 full Bookworm builder;
Node 22.17.0 slim had 68 HIGH Debian plus 37 HIGH Node.js findings;
Node 22.23.3 slim had 53 HIGH/4 CRITICAL Debian plus 10 HIGH Node.js
findings; NGINX 1.29.5 Alpine had 46 HIGH findings. The
license scan enumerated 589 OS package and 197 Node.js package license records
in the newer Node candidate. These counts are inventory evidence, not approval.
The existing PostgreSQL 17.6 and Redis 7.4.5 digests are test dependencies;
S8.6 owns their runtime image scans and operations.

**Decision:** S8.0 delivery preflight is complete: the reviewed S7 base,
processes, gates and developer toolchain are named. S8.1 may freeze contracts.
No candidate base or assembled image is admitted for runtime use while
HIGH/CRITICAL findings lack an approved exception or a patched replacement.
The exception ledger is empty, and S8.3-S8.5 must clear this gate before image
construction can be accepted. Digest pins do not waive vulnerability findings.

Rollback of this preflight removes only the documentation and test-fixture
correction; it has not changed application data, published images, or cloud
resources.
