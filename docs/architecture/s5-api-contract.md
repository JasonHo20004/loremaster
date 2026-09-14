# S5 API contract

Frozen on 2026-09-14 for the S5.1 gate. The authoritative, machine-checkable
artifact is `packages/contracts/src/api.ts`, with runtime schemas and security
policies exported by the same package. This document records consumer semantics;
it does not define a second payload shape.

Provider: `apps/api`. Consumers: `apps/web` and operator HTTP examples.
Repository maintainers approve contract changes. All routes are under API major
version `v1`; incompatible changes require a new major route or an explicit
migration plan. Additive changes still require contract review because objects
are strict and consumers must opt into new fields deliberately.

## Operations and statuses

| Operation | Route | Policy | Success | Documented errors |
| --- | --- | --- | --- | --- |
| `createSession` | `POST /api/v1/session` | Bootstrap | 201 | 400, 403, 413, 415, 429, 500, 503 |
| `getSession` | `GET /api/v1/session` | Session | 200 | 401, 403, 500, 503 |
| `getCurrentCase` | `GET /api/v1/cases/current` | Session | 200 | 401, 403, 500, 503 |
| `startCurrentAttempt` | `POST /api/v1/cases/current/attempt` | Gameplay mutation | 200 | 400, 401, 403, 409, 413, 415, 429, 500, 503, 504 |
| `getOwnedAttempt` | `GET /api/v1/attempts/:attemptId` | Session | 200 | 400, 401, 403, 404, 500, 503 |
| `runGameplayCommand` | `POST /api/v1/attempts/:attemptId/commands` | Gameplay mutation | 200 | 400, 401, 403, 409, 413, 415, 429, 500, 503, 504 |
| `getSuggestions` | `GET /api/v1/attempts/:attemptId/suggestions?q=` | Session + autocomplete limits | 200 | 400, 401, 403, 404, 429, 500, 503 |
| `getProfile` | `GET /api/v1/profile` | Session | 200 | 401, 403, 500, 503 |
| `getLeaderboard` | `GET /api/v1/leaderboards/:slotId?limit=&cursor=` | Session | 200 | 400, 401, 403, 500, 503 |
| `healthLive` | `GET /health/live` | Public | 200 | 500 |
| `healthReady` | `GET /health/ready` | Public | 200 | 500, 503 |

Starting an attempt always returns 200: an existing attempt and an idempotent
replay are valid task results, so the route does not claim that every success
created a new resource. The `replayed` field distinguishes a receipt replay.
Creating a new guest session returns 201.

## Request conventions

- JSON request bodies are strict objects. Unknown keys, wrong primitive types,
  repeated JSON object keys, and repeated security headers/query parameters are
  rejected before repository use. The raw parser in S5.3a will enforce malformed
  and duplicate-key behavior; Zod validates the parsed representation.
- JSON bodies are at most 16 KiB. `Content-Type` is exactly normalized to
  `application/json`; unsupported media is 415 and an oversized body is 413.
- UUIDs remain strings. Slot IDs are real UTC calendar dates in `YYYY-MM-DD`.
  Versions/counts are bounded non-negative safe integers.
- Autocomplete trims leading/trailing whitespace, requires at least one
  non-whitespace character, and rejects C0/C1 control characters. Its raw input
  remains bounded to 80 characters before normalization.
- Gameplay mutation headers are `Idempotency-Key`, `X-CSRF-Token`, and exact
  configured `Origin`. Keys contain 1–128 printable ASCII characters.
- `POST /api/v1/session` is the clarification recorded in ADR 0003: exact body
  `{}`, exact Origin, JSON content type, and ten creations per source IP per
  minute; it has no auth, CSRF, idempotency, or client identity fields.
- The server generates the response request ID. Caller-provided request IDs are
  ignored rather than copied into logs or responses.

Command bodies are deliberately task-oriented:

```json
{
  "expectedVersion": 7,
  "command": { "kind": "GUESS", "entityId": "dockmaster_vesa" }
}
```

The canonical S4 receipt inputs remain:

- start: `["v1","START"]`
- guess: `["v1","GUESS",attemptId,expectedVersion,entityId]`
- reveal: `["v1","REVEAL",attemptId,expectedVersion]`
- give up: `["v1","GIVE_UP",attemptId,expectedVersion]`

JSON property order never changes those tuples.

## Public responses and errors

Success responses use an explicit `data` object except health probes. ACTIVE
attempts can contain only briefing, public suggestions, own guesses/counters,
and evidence levels `1..e`. They cannot represent an answer, future evidence,
explanations, or sources. Terminal attempts require the answer and exactly four
ordered evidence entries with explanations and internal source references.

Command `outcomeCode` describes the historical receipt while `attempt` is the
current authorized projection. For a newly executed command, CORRECT requires
SOLVED, GIVEN_UP requires GIVEN_UP, REVEALED requires ACTIVE, and WRONG requires
ACTIVE or EXHAUSTED. A replay may return a later terminal projection after other
commands or expiry, as required by T23. STARTED similarly names the start receipt;
the current projection may already be terminal when an existing attempt is read.

Errors contain only a stable code, server request ID, and optional bounded field
diagnostics:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "requestId": "00000000-0000-4000-8000-000000000099",
    "fields": [{ "path": "$.expectedVersion", "code": "OUT_OF_BOUNDS" }]
  }
}
```

No arbitrary message, thrown error, SQL detail, token, guess, raw URL, or
narrative value belongs to this envelope. Field paths come from the fixed public
contract allowlist; unknown attacker-supplied key names are reported against
their nearest known parent and are never copied into the path.

| Repository/policy result | HTTP | Public code |
| --- | ---: | --- |
| Invalid command/body | 400 | `INVALID_REQUEST` |
| Unknown/ineligible entity | 400 | `INVALID_GUESS` |
| Missing/expired session | 401 | `AUTHENTICATION_REQUIRED` |
| Origin, CSRF, or CORS denial | 403 | `REQUEST_FORBIDDEN` |
| Unknown/foreign attempt or unavailable suggestion context | 404 | `RESOURCE_NOT_FOUND` |
| No current case on start | 409 | `NO_CURRENT_CASE` |
| Changed-payload key reuse | 409 | `IDEMPOTENCY_CONFLICT` |
| Stale expected version | 409 | `STALE_VERSION` |
| Reveal beyond level four | 409 | `EVIDENCE_LIMIT` |
| Mutation of terminal attempt | 409 | `TERMINAL_ATTEMPT` |
| Rate limit | 429 | `RATE_LIMITED` plus integer `Retry-After` header |
| Internal failure | 500 | `INTERNAL_ERROR` |
| Dependency/pool unavailable | 503 | `SERVICE_UNAVAILABLE` |
| Settled command deadline | 504 | `REQUEST_TIMEOUT` |

Authentication, unknown ID, foreign ownership, and unavailable suggestion
contexts never return another guest's projection. Retry policy is operation
aware: an uncertain 500/503/504 gameplay mutation is retried only with the same
idempotency key; session bootstrap and reads may retry after backoff without a
key; 429 obeys `Retry-After`. The API must not return 504 until the transaction
has committed or rolled back and no later commit remains possible.

## Cookie and CORS policy

Production auth/CSRF cookie names are `__Host-loremaster_session` and
`__Host-loremaster_csrf`. Both are Secure, SameSite=Lax, Path=/, and have no
Domain; only the auth cookie is HttpOnly. Local HTTP uses the distinct names
`loremaster_local_session` and `loremaster_local_csrf`, with Secure disabled,
and that policy is invalid in production. Clearing repeats the exact attributes.

Credentialed CORS permits only the exact configured origin, methods GET/POST/
OPTIONS, and headers Content-Type/Idempotency-Key/X-CSRF-Token. Responses vary
on Origin. A credentialed wildcard is forbidden.

## Leaderboard cursor

The opaque wire envelope is
`v1.<key-version>.<base64url-payload>.<base64url-hmac>`. The authenticated JSON
payload contains version 1, slot ID, ordering schema `e-w-elapsed-id-v1`,
evidence level, total wrong guesses, elapsed milliseconds, and attempt UUID.
HMAC-SHA-256 covers the envelope version, key version, and payload. Verification
uses constant-time tag comparison. Keys contain at least 32 random bytes; active
and previous IDs/material are distinct. Issuance always uses the active key.
Verification accepts only that active key plus one explicitly configured previous
key for a 24-hour rotation grace, after which the previous key must be removed.
Unknown key/version, retired key, bad MAC, wrong slot, wrong ordering schema,
malformed payload, and out-of-bounds tuple all return 400.

## Contract change and deferred evidence

Change the schema/operation artifact first, review provider and consumer impact,
then change implementation and fixtures. Do not maintain handwritten payload
copies in web or API packages. S5.3–S5.6 must validate real serialized responses
against these schemas; S6 consumes types from this package. Browser refresh,
bundle/source-map scans, and deployed artifact proof remain assigned to S6/S8.

## S5.1 local verification

On 2026-09-14, the focused contract suite passed 15 tests. The complete local
non-database suite passed 150 tests, the clean PostgreSQL suite retained all 47
passes, and formatting, ESLint, every workspace typecheck/build, and
`git diff --check` passed. Independent TypeScript and security reviews returned
GO after outcome/projection correlation, rate-limit statuses, operation-aware
retry policy, diagnostic paths, autocomplete controls, and cursor rotation were
hardened. The S5.1 plan checkbox remains pending until S5.0 establishes the
reviewed branch base/toolchain and clean-checkout CI passes.
