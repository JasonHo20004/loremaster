# S7.0 and S7.1 contract delivery

Date: 2026-09-29. Scope: delivery preflight and frozen contracts only.
The [S7.0 preflight](s7-preflight.md) records accepted S6 merge/CI, baseline
tests, dependency/secret evidence and process inventory.

## Contract acceptance map

| Requirement                                           | Evidence                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-only boundary and rollback                     | [ADR 0005](../docs/adr/0005-server-cache-boundary.md), `tests/architecture/server-cache.test.ts`, browser dependency/source and bundle checks                          |
| Cache envelope, keys and separate reader/writer ports | `packages/cache/src/suggestions.ts`, strict parse/canonical serialization tests, dense object/array descriptor checks                                                  |
| Job name/schema/ID and bounded policy                 | `packages/queue/src/index.ts`, `tests/queue/contracts.test.ts`; no connection or processor constructed                                                                 |
| Shared limiter vocabulary                             | `packages/cache/src/limiter-contract.ts`, `tests/limiter/contracts.test.ts`; fixed public ceilings, versioned pseudonym keys, bounded decisions                        |
| Client cancellation, ownership and memory budgets     | `packages/cache/src/profiles.ts` and [Redis contract](../ops/redis/README.md); runtime enforcement remains a later gate                                                |
| Separate API/worker/observer configuration            | `packages/config/src/redis.ts`, invalid-input, mode, credential-separation and redaction tests                                                                         |
| Worker/producer database privilege                    | Migration 0005 security-barrier views and `tests/database/s7-roles.test.ts`; published eligible data only, role/base-table/write/DDL denials, disposable down rollback |
| Exact script source/command inventory                 | `ops/redis/bullmq-script-inventory.json`, `scripts/s7-bullmq-inventory.mjs --check`, reviewed dynamic command map and fail-closed tests                                |
| CI reproduction                                       | Read-only `Quality` job includes `pnpm test:s7:contracts`; existing audit/secret and database jobs retained                                                            |

BullMQ 5.81.5 and ioredis 5.11.1 declare MIT and Node >=12.22.0; the project
uses Node 22.17.0/pnpm 11.19.0. Lockfile tests require one ioredis version.
Audit reports no known vulnerabilities. Production license inventory contains
101 package/version entries: 89 MIT, 3 Apache-2.0, 7 ISC, 1 BSD-3-Clause,
1 0BSD; no missing licenses. The optional `msgpackr-extract` install script
is explicitly denied, avoiding an interactive/native build prerequisite.

## Review and verification

Independent TypeScript/general, security and database reviewers examined the
S7.0/S7.1 changes. Their findings led to descriptor-based rejection of
accessors, private extra properties, sparse/decorated/subclass arrays; exact
LPUSH/RPUSH inventory for BullMQ's indirect calls; and positive/negative
published-row tests plus producer privilege tests. Tests reproduced the
serializer failures before fixes. Source hashes were independently compared
with installed BullMQ before the final inventory was regenerated.

The final local checks after review fixes passed:

| Command                                          | Result                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                 | PASS; optional native build explicitly denied, no interactive approval        |
| `pnpm test:s7:contracts`                         | PASS; reviewed BullMQ source/inventory check plus 75 tests in 7 files         |
| `pnpm test:database`                             | PASS; 91 tests in 6 files against disposable PostgreSQL                       |
| `pnpm test:api:database`                         | PASS; 7 tests in 2 files against disposable PostgreSQL                        |
| `pnpm run verify`                                | PASS; format, lint, typecheck, 346 non-database tests in 34 files, all builds |
| `pnpm test:web:disclosure`                       | PASS; 5 JS/CSS/HTML/manifest/map artifacts scanned                            |
| `pnpm audit --audit-level moderate`              | PASS; no known vulnerabilities                                                |
| `pnpm licenses list --prod --json`               | PASS; 101 entries, all declared permissive licenses as inventoried above      |
| Gitleaks 8.30.0 `dir /repo --no-banner --redact` | PASS; approximately 3.92 MB of current checkout scanned, no leaks             |
| `git diff --check`                               | PASS                                                                          |

The fresh S7.1 commit and hosted CI are not yet available. The existing
S6-merge hosted success remains the dependency baseline only.

## Delivery boundary

This is a local working-tree delivery on `codex/s7-completion`. Hosted CI and
merge for these changes remain pending; S6's hosted pass is baseline evidence,
not a hosted pass for S7. Dependent slice work requires the reviewed committed
predecessor and passing hosted delivery gate from the plan.

Redis ACLs do not restrict Lua by source hash. The contract requires guarded
role-specific ports, exact script options/arguments and actual wrong-role/
arbitrary-script denial tests before runtime admission. S7.1 documents and
tests the vocabulary, not those future runtime guarantees. Cache/limiter
capacity and cancellation are similarly frozen obligations for S7.2-S7.8.

The API keeps its PostgreSQL-only suggestion path and local limiter. Worker
and observer remain scaffolds. No runtime configuration input is wired into
application startup. S7.2-S7.9 and S8 remain unexecuted by this delivery.

Rollback removes unused contracts, dependency pins and parser exports; the
new database roles/views have a disposable-test down migration. Existing
runtime/importer privileges and gameplay data are unchanged. Production
migration correction remains forward-only.
