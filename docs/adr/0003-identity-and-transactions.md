# ADR 0003: Guest identity and synchronous authoritative writes

Status: Accepted | Date: 2026-09-11

Context: A client-chosen player ID allows impersonation. Retries and concurrent tabs can double-apply penalties or rewards. Hidden fields in browser bundles cannot be protected by UI logic.

Decision: Use an opaque server-issued random guest token with at least 256 bits of entropy; persist only its hash. Production cookie is host-only, Secure, HttpOnly, SameSite=Lax, Path=/ (use a __Host- name). Expire sessions after 30 days absolute; loss/expiry creates a new guest without recovery. Local HTTP development uses a separately named explicitly local cookie policy, forbidden in AWS mode. Mutations require exact configured same-origin Origin plus session-bound CSRF token, JSON content type, and guest ownership. No wildcard credentialed CORS or client identity override.

Each command uses a guest-scoped idempotency key and canonical command/payload fingerprint. Unique database constraints arbitrate duplicate keys. Start is unique per guest/slot; gameplay also supplies expected version. Transactionally lock the attempt, check time/version, and commit guesses, terminal effects, profile, participation and solved leaderboard row with the command receipt. Lock guest profile before attempt for all paths; serialize multi-attempt expiry reconciliation by slot order. Unique finalization/participation effects guard retries. Store receipts for the guest session lifetime and reject expired sessions before replay; cleanup must not permit replay on the same surviving identity after receipt deletion.

Use explicit public projections, never serialize database rows. Redis failure does not change correctness; cache warming is disposable with deterministic job IDs and idempotent writes. Any future durable asynchronous effect requires an outbox ADR. Content import is an authenticated operator CLI using limited database rights, not a public route.

Alternatives: Client-selected IDs, queued scores, hidden UI fields and optimistic writes without database arbitration are rejected. Password accounts add recovery/security scope the MVP does not need.

Consequences: Multi-tab stale actions conflict and refresh instead of applying at an unexpected level. Guest cookies can be lost, and guests can create new identities; the leaderboard is recreational, not Sybil-resistant. Database transaction/pool pressure must be measured. Generic wrong feedback avoids relationship leakage. Expiry reconciliation and ordinary writes use the same lock order and exactly-once finalization constraints.

Verification: S5 two-session isolation, CSRF, replay, different-payload key conflicts, racing mutations and expiry tests; S6/S8 bundle and response disclosure checks. Numeric limits and retention details are fixed before API implementation in the threat model.
