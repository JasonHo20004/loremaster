# ADR 0005: Server-only cache and limiter boundary

Status: Accepted for S7.1 | Date: 2026-09-29

## Context

ADR 0001 placed infrastructure in database and queue packages. Suggestion
cache reads and shared rate limiting need Redis without depending on queue
producers or worker orchestration. Browser-safe HTTP contracts must not
become a path to server-only indexes, credentials, or Redis dependencies.

## Decision

This ADR supersedes ADR 0001 only for the repository package boundary. Add
`packages/cache` for strict immutable suggestion envelopes, versioned keys,
role-specific ports, limiter contracts, and bounded Redis client profiles.
Apps may depend on this server-only package. Cache must not depend on apps,
database, queue, or browser contracts. Database authorization and transactions
remain in `packages/database`; adapters receive transaction assertions through
injected ports instead of creating a circular dependency.

`packages/queue` owns the single `warm-current-revision-v1` job schema,
deterministic identity, retry/retention/concurrency policy and future producer
and worker glue. It may depend on cache contracts. Config parses each
process's environment without opening connections. Browser contracts remain
HTTP-only and may not import or re-export cache or queue. No public web build
input is added for either package.

Use BullMQ `5.81.5` and its exact Redis client dependency ioredis `5.11.1`.
Both declare MIT and Node >=12.22.0; the project stays on Node 22.17.0 and
pnpm 11.19.0. The lockfile must resolve one ioredis version. Upgrades require
audit, license review, contract tests, and the later composed Redis gate.

S7.1 adds contracts, parsers, least-privilege database roles and tests only.
It does not construct Redis clients, run producers or workers, change
suggestion authorization, or apply a shared limiter to HTTP requests.

## Invariants and rollback

PostgreSQL owns gameplay truth. Redis I/O must occur outside authoritative
transactions. Cache values contain only eligible suggestion fields and
database-derived search/order data for a published immutable revision; no
answer, evidence, explanation, source, guest, session, or attempt data belongs
in the envelope. Only a future worker writer port may replace cache values.
The API reader has no write/delete port and never enqueues per request.

The shared limiter is a separate port, namespace, identity key, and ACL user.
The existing local limiter always runs first and remains the Redis-outage
fallback. No gameplay outcome waits for warming. Rollback disables optional
composition and retains PostgreSQL suggestions/local limiting; disposable
keys expire by TTL without wildcard deletion. No durable job is admitted.

## Verification

`pnpm test:s7:contracts` checks strict contracts, client profiles, configuration
and package boundaries. `pnpm test:database` checks the new read-only database
roles. Audit, license inventory, secret scan, root verification, and browser
disclosure gates accompany S7.1. Runtime ACL enforcement, cancellation,
two-guest cache isolation and Redis failure claims remain S7.2-S7.8 gates.
