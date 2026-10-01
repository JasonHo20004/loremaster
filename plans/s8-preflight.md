# S8.0 delivery preflight evidence

Date: 2026-09-29. Result: **BLOCKED**. S8.0 is not complete and S8.1 is
not admitted. This record documents inspection, not runtime acceptance.

## Source baseline

- Inspected branch: `cache-worker`.
- Inspected HEAD: `1bc9660f2221e3bd0f737cf55018893b91ff769a`.
- Local `main`: `06ee5d8a919bccd1bc345b34ad781f43ca843669`.
- The working tree was clean before this preflight.
- `docs/architecture/s7-acceptance.md` does not exist. All S7 progress items
  remain unchecked in `plans/s7-cache-worker.md`.
- `git log --all --oneline --grep='S7'` returned no matching commits. This
  checks local references only; remote merge and hosted CI were not verified.
- No reviewed S7 merge commit can be named from this checkout. The inspected
  HEAD must not be treated as the accepted S8 base.

## Process inventory

| Process          | Existing host surface                                       | Lifecycle and ownership evidence                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web              | `pnpm --filter @loremaster/web dev`, `build`, `preview`     | Vite development uses localhost:5173; preview uses 127.0.0.1:4173. Browser assets own no durable gameplay state. Gateway lifecycle remains S8 work.                                                                                                                                                                                                    |
| API              | `pnpm --filter @loremaster/api start`                       | Compiled `dist/index.js`; prestart builds dependencies. Binds 127.0.0.1, default port 3000. Configuration schema is `packages/config/src/index.ts`. Liveness is independent of PostgreSQL; readiness performs a bounded read-only transaction. Default HTTP drain is 10,000 ms, followed by pool closure; this is not a measured total shutdown bound. |
| Worker           | No executable runtime command                               | `apps/worker/src/index.ts` only exports `applicationName`. No queue consumer, environment schema, probes, or shutdown contract exists.                                                                                                                                                                                                                 |
| Queue observer   | No executable runtime command                               | `apps/queue-observer/src/index.ts` only exports `applicationName`. No listener, environment schema, probes, or shutdown contract exists.                                                                                                                                                                                                               |
| Queue library    | No implemented queue contract                               | `packages/queue/src/index.ts` only exports `packageName`. Redis ownership, ACLs, retries, and retention cannot be frozen from this scaffold.                                                                                                                                                                                                           |
| Migration        | Existing migration library and `pnpm test:database` harness | Operator ownership is documented in `docs/development/README.md`. The database package exposes no standalone migration CLI script; the test harness is not a runtime operator entrypoint.                                                                                                                                                              |
| Content importer | `pnpm content:import`                                       | Builds the database package and invokes `dist/content/cli.js`; input and role contracts are documented in `docs/development/content-import.md`.                                                                                                                                                                                                        |
| PostgreSQL       | Disposable Docker-backed database/API harnesses             | Authoritative gameplay storage; schema owner, importer, and runtime roles are distinct. Harnesses require a running daemon.                                                                                                                                                                                                                            |
| Redis            | No accepted host runtime or composed S7 gate                | Disposable cache/queue ownership is planned, not implemented or accepted.                                                                                                                                                                                                                                                                              |

The API source and development guide are existing behavior evidence only; no
process was accepted by execution in this preflight.

## Host checks

| Check                                      | Observed result                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `node --version`                           | `v22.17.0`, matches repository pin                                                          |
| `pnpm --version` in sandbox                | `11.19.0`, matches repository pin                                                           |
| `pnpm run verify` in sandbox               | Failed at Prettier startup with filesystem `EPERM`                                          |
| `pnpm run verify` outside sandbox          | Failed: global shim references missing `AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs` |
| `corepack pnpm run verify` outside sandbox | Pinned launcher starts, but nested `pnpm` commands hit the same broken global shim          |
| Docker client                              | `29.1.2`, Windows/amd64; this is not an Engine version                                      |
| Docker Compose client                      | `v2.40.3-desktop.1`                                                                         |
| Docker Buildx client                       | `v0.30.1-desktop.1`, commit `792b8327a475a5d8c9d5f4ea6ce866e7da39ae8b`                      |
| `docker version` outside sandbox           | Linux daemon unavailable: `dockerDesktopLinuxEngine` named pipe does not exist              |
| `docker buildx inspect` outside sandbox    | Reports a daemon connection error; BuildKit behavior unverified                             |

No database, Redis, browser, dependency-audit, or secret-scan pass is claimed.
The S7 composed Redis gate and S8 image-policy command do not exist in the
root package scripts. Supported Engine/Compose minimums cannot be accepted
from client version output alone.

## Supply-chain status

The existing database test harness references
`postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`.
This is an existing test dependency, not an S8-approved base. Its platform,
provenance, license inventory, and current vulnerabilities were not verified
in this attempt. Node builder/runtime, gateway, Redis, and scanner digests
remain unselected; no supply-chain acceptance is claimed.

`ops/build-contexts/web-public.allowlist` already exists, but contains directory
entries and is not proof of a generated, validated S8 context. No additional
contexts, Dockerfiles, or image contracts were introduced before admission.

## Resume requirements

1. Complete S7 through S7.9, including executable worker/observer runtimes,
   composed Redis evidence, independent review, acceptance record, hosted CI,
   and merge to `main`. Record the exact accepted commit.
2. Restore a working pinned pnpm command surface, including nested invocations,
   and a running Linux Docker daemon. Re-run repository verification and all
   accepted S7 database/Redis gates against disposable resources.
3. Verify Engine/Compose/BuildKit behavior and freeze supported minimums.
   Inventory candidate bases/scanners with digest, architecture, provenance,
   license, vulnerability, and update-policy evidence.
4. Review and close S8.0 on its slice branch before beginning S8.1. Then add
   context generation/validation, runtime and reproducibility contracts,
   static policy tests, scanner policy, audit/secret evidence, and CI.

The S8 dependency edges and exit criteria remain unchanged. Both progress
checkboxes remain open. Rollback consists only of removing this evidence and
its plan link; no runtime, image, dependency, or persistent data was changed.
