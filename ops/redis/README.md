# S7.1 Redis and job contract

This freezes inputs and policies for S7.2-S7.8. No Redis client, ACL user,
queue producer, worker, observer, cache adapter or shared limiter is started
by S7.1. PostgreSQL and the existing local limiter remain the host runtime.

## Versioned data and queue policy

| Item | Frozen contract |
| --- | --- |
| Dependencies | BullMQ 5.81.5; one ioredis version, 5.11.1; MIT; Node >=12.22.0 |
| Test prerequisite | Redis 7.4.5; exact image digest in `plans/s7-preflight.md` |
| Queue name / prefix | `loremaster-warm-v1` / `loremaster:v1:queue` |
| Job / payload | `warm-current-revision-v1`; exact `{version:1,revisionId:<lowercase UUID>}`, max 128 UTF-8 bytes |
| Result | Exact `{version:1,status:"warmed"}`, max 64 UTF-8 bytes |
| Job ID | `warm-v1-<lowercase UUID>`; colon-free, deterministic, no guest/request inputs |
| Cache key | `loremaster:v1:revision:<lowercase UUID>:suggestions`; exact key builder only |
| Cache value | Version 1 canonical JSON, max 512 KiB; max 1,000 eligible entities, 32 aliases per entity |
| Cache fields | Public entity ID, canonical name, role, aliases, PostgreSQL-derived lowercase search fields and stable sort rank; no raw rows or private content fields |
| TTL | Exactly 172,800 seconds (48 hours); mandatory atomic replacement by worker |
| Processing | Default concurrency 2, maximum 4; 5-second execution deadline, 10-second drain |
| Retry | At most 3 transient attempts; exponential 1,000 ms base, jitter 0.5; poison is permanent; max job age 48 hours |
| Retention | Completed and failed: max 128 records each, max age 48 hours; no stack traces; max stored job 16 KiB |
| Admission | At most 128 outstanding jobs; event stream max 1,024 events; at most one stalled recovery |
| Reconciliation | Startup, Redis-ready/recovery and every 60 seconds; single-flight; 1-second producer deadline; select revision using PostgreSQL time |

Deduplication lasts while the BullMQ record exists. Re-enqueue after record
removal is allowed. S7.4 must explicitly handle retained terminal IDs so they
cannot suppress a required repair, and enforce outstanding capacity atomically
across producers. A cache read must validate both the schema and equality with
the authorized revision ID; an envelope from another revision is corruption.

Search fields and `sortRank` are private infrastructure fields. S7.3 must
preserve the accepted SQL matching and ordering, authorize the guest/attempt
in PostgreSQL, commit, and only then consult Redis. Every adapter receives a
transaction assertion through its port. Public projection never returns a
cache envelope directly. A read miss/error falls back to PostgreSQL and
emits only a bounded reason code. Only the worker may write cache data.

## Connections, deadlines and cancellation

All profiles are lazy, disable offline queues and automatic resend, use a
500 ms connect timeout, and reconnect with 100-2,000 ms capped delay plus
20% jitter. Request-path timeouts destroy the affected connection and reject
pending commands; they must not leave a late operation queued for reconnect.
Reconnection creates a fresh bounded client. Profile constants are contracts,
not an assertion that an ioredis option alone cancels work.

| Profile | Retries per request | Command deadline | Close budget | Maximum connections |
| --- | --- | --- | --- | --- |
| API cache reader | 0 | 100 ms | 1 second | 1 |
| API shared limiter | 0 | 100 ms | 1 second | 1 |
| Producer | 0 | 1 second | 1 second | 1 |
| Worker | null for BullMQ blocking connection | 5 seconds for work | 10 seconds | 3: queue, duplicated blocking connection, cache writer |
| Observer | 0 | 1 second | 1 second | 1 |

The worker's `maxRetriesPerRequest:null` is BullMQ's blocking-connection
requirement. It does not waive job deadlines: S7.5 must abort PostgreSQL work,
destroy deadline-bound Redis work and close the blocking consumer within the
drain budget. Owners close each client once; reader/limiter do not share a
client with producer or worker. API readiness remains PostgreSQL-only;
worker readiness requires PostgreSQL and Redis, observer readiness requires
Redis, and all liveness probes remain process-only. Worker/observer future
health servers bind loopback on ports 3001/3002.

## ACL identities, keys and operations

Use six distinct ACL identities: `loremaster_api_cache`,
`loremaster_api_limiter`, `loremaster_producer`, `loremaster_worker`,
`loremaster_worker_cache`, and `loremaster_observer`. Credential values are
operator-provided. Start from `-@all`, no Pub/Sub channel grants, and permit
only the following role operations plus connection commands `AUTH`, `HELLO`,
`PING`, `QUIT`, `CLIENT SETNAME`, and `CLIENT SETINFO`. No application identity
gets `KEYS`, `SCAN`, `FLUSHALL`, `FLUSHDB`, `CONFIG`, `ACL`, `MONITOR`, script
debugging, or arbitrary script-loading/execution through a public port.

| Identity | Key pattern | Commands / allowed operation |
| --- | --- | --- |
| API cache | `loremaster:v1:revision:*:suggestions` | `GET`; port accepts only an exact UUID-derived key |
| Worker cache | Same suggestion pattern | `SET` with mandatory fixed `EX`; no delete port |
| API limiter | `loremaster:v1:limit:*` | `TIME`, `GET`, `SET`, `INCR`, `EXISTS`, `PEXPIRE`, `PTTL`, `ZADD`, `ZCARD`, `ZREMRANGEBYSCORE`, `EVAL`, `EVALSHA`; one reviewed `limiter-v1` operation only |
| Producer | `loremaster:v1:queue:loremaster-warm-v1:*` | Direct `INFO`, `HGET`, `HGETALL`, `HMSET`, `LLEN`, `ZCARD`, `EVAL`, `EVALSHA`; plus exact command union of producer scripts in the inventory |
| Worker queue | Same queue pattern | Direct `INFO`, `HGET`, `HGETALL`, `HMSET`, `BZPOPMIN`, `EVAL`, `EVALSHA`; plus exact command union of worker scripts in the inventory |
| Observer | Same queue pattern | `LLEN`, `ZCARD`, `ZRANGE` with a maximum one-element range and `WITHSCORES`; no hashes, job bodies, streams, write commands or scripts |

`bullmq-script-inventory.json` lists the complete expanded source SHA-256,
number of keys, role and command union for each admitted BullMQ operation.
`node scripts/s7-bullmq-inventory.mjs --check` verifies the installed source
hashes and inventory without changing it. Regeneration refuses changed source
hashes; a dependency update requires explicit source/hash and dynamic-command
review before replacing the ledger. The inventory includes indirect LPUSH/RPUSH
operations and fails closed on unknown command expressions. Runtime guards
must constrain command-selecting arguments to the reviewed push commands.
Enqueueing accepts only the frozen job name,
payload and options; parent/child flows, repeat jobs, arbitrary priorities,
arbitrary script names and arbitrary key prefixes are excluded. Producer
removal is limited to an exact retained terminal warm job, never active work.

Redis ACLs constrain commands and keys; they cannot restrict `EVAL` by source
hash or distinguish producer/consumer state transitions within one queue.
Therefore S7.2/S7.4 must enforce the inventory through a role-specific client
guard before ioredis executes or reloads a script. Unlisted names, mismatched
source hashes and out-of-pattern keys are denied before any Redis command.
The limiter script is authored and hash-reviewed in S7.6 before that identity
is provisioned. This document does not claim Redis ACL alone enforces script
admission. Wrong-role and arbitrary-script denials remain mandatory real-Redis
tests before any runtime is admitted.

## Quantitative budgets and shared limiter

| Namespace | Admission limit | Memory budget |
| --- | --- | --- |
| Suggestions | 16 exact revision keys, 512 KiB maximum value | 16 MiB including overhead |
| Queue | 384 jobs total, 128 outstanding; max 1,024 Redis keys and 1,024 events | 32 MiB including metadata |
| Limiter | 20,000 live keys including capacity registry | 16 MiB |
| Instance | `noeviction`, 128 MiB maxmemory | At least 64 MiB admission headroom |

Redis maxmemory is instance-wide. S7.2/S7.4/S7.6 must enforce each namespace's
count/byte admission and test concurrent saturation. A TTL alone is not a
cardinality bound. S7.8 measures actual overhead against these budgets and
rejects composition if the 64 MiB headroom is not maintained.

The shared limiter uses Redis-time fixed 60-second windows. Each counter and
capacity key expires within 61 seconds. Key vocabulary is
`loremaster:v1:limit:<HMAC-version>:<bucket>:<counter>:<scope>:<SHA256-HMAC-hex>`.
Canonical source IP or guest ID input is bounded to 128 UTF-8 bytes and
domain-separated by scope before HMAC. Material is a separate 32-64 byte
key, never a cursor key. Changing version/key rotates the namespace; old exact
keys expire without wildcard deletion. The capacity registry is included in
the 20,000-key bound.

Ceilings remain session/IP 10; autocomplete/IP 300 and guest 120; mutation/IP
120 and guest 30. Local denial returns immediately with its current
`Retry-After`; shared checks cannot override it. After local admission, shared
IP/guest admission is one atomic operation. Healthy shared denial uses its
bounded 1-60 second reset; Redis failure uses the local decision and a
`degraded` signal. During outage, N replicas may permit the sum of their N
local ceilings. S7.6 owns implementation, rotation and concurrency proof.

## Configuration and database roles

`parseApiRedisConfiguration` defaults disabled. Enabled API configuration
requires `LOREMASTER_REDIS_ENABLED=true`, separate
`LOREMASTER_REDIS_CACHE_URL`, `LOREMASTER_REDIS_LIMITER_URL`,
`LOREMASTER_REDIS_PRODUCER_URL`, `LOREMASTER_REDIS_LIMITER_HMAC_KEY` (canonical
base64url), and `LOREMASTER_REDIS_LIMITER_HMAC_VERSION`. URL usernames must
be distinct. No adapter is constructed in S7.1.

Worker parser requires `LOREMASTER_WORKER_REDIS_URL`,
`LOREMASTER_WORKER_CACHE_REDIS_URL`, `LOREMASTER_WORKER_DATABASE_URL`; optional
`LOREMASTER_WORKER_CONCURRENCY` is 1-4, default 2. Queue/cache usernames must
be distinct. Observer requires `LOREMASTER_OBSERVER_REDIS_URL` and has no
database credentials. `LOREMASTER_REDIS_MODE` is local/production and must
agree with API mode when present. All Redis URLs require explicit username
and password; production additionally requires `rediss`. Invalid values,
unknown process variables, control characters and oversized inputs fail with
field names only. Production downgrade through Redis mode is rejected.

Migration 0005 adds `loremaster_cache_worker` and
`loremaster_cache_producer` as non-login, non-elevated roles with no inherited
membership. Separate provisioned logins receive exactly one role. Worker
SELECTs three security-barrier views: `cache_published_revisions`,
`cache_published_entities`, and `cache_published_aliases`. Producer SELECTs
only revision metadata. Views omit draft/ineligible rows and private fields;
base tables, gameplay writes, importer/runtime elevation and DDL are denied.
S7.3/S7.4 query these views under fixed roles; they cannot reuse the current
runtime transaction helper unchanged. Operator down migration is disposable
test-only; production corrections are forward migrations.
