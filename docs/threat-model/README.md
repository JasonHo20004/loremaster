# Threat model

Scope: guest browser, API, PostgreSQL, Redis/workers, operator import, CI and future AWS. Assets: hidden solutions, attempt integrity, session tokens, secrets and cloud credit. Browser inputs, imported files, queue payloads and untrusted PRs cross trust boundaries. The API/database own identity and truth. Controls through S6 have local executable evidence in the [S6 acceptance record](../architecture/s6-acceptance.md); S7-S12 items below remain requirements, not implemented claims.

| Threat / attack | Required control | Verification owner / stage |
| --- | --- | --- |
| Answer or future evidence in JSON, source map, error, cache or telemetry | Explicit ACTIVE projection; server-only content; no body/query/SQL-parameter logging; no shared cache of private HTTP responses | S4 answer-absence assertions; S5 errors/logs; S6 source/bundle/source-map scan passed; S8 deployed-artifact scan; S12 two-guest cache isolation |
| Replay or key reuse with changed body | Guest-scoped unique key, canonical fingerprint, atomic receipt; different payload conflicts; expired identity cannot replay | S5 duplicate, changed-payload and cross-guest replay tests |
| Concurrent guess/reveal/give-up or expiry | Consistent lock order, expected version, post-lock database time, unique finalization and guest/day participation | S4 constraints; S5 races including exact close and duplicate start |
| Brute-force answers or account farming | Three guesses per level, 15 maximum; generic feedback; session and trusted-source-IP limits | S5 limits/unknown-ID tests; residual: disposable guest identities allow Sybil abuse |
| Stolen session, CSRF or client-selected identity | Random hashed token, production cookie policy, exact Origin + CSRF check, ownership on every request; never log tokens | S5 cookie/CSRF/two-guest tests; AWS rejects dev identity |
| XSS through names or imported lore | Plain text rendering, bounded strings, CSP and secure headers; server pseudonyms | S5 import validation and headers; S6 component and real-stack hostile-text journeys passed |
| Malicious import or changed opened answer | Local operator CLI, narrow DB privilege, transactional validation, immutable publication and global exclusion constraint | S4/S5 malformed packs, rollback and concurrent-window tests |
| SSRF via source/asset URL | MVP never fetches supplied URLs; sources are internal references | S5 verify no URL-fetch path; future fetcher requires allowlist, redirect/DNS/IP revalidation, metadata/private-IP blocks and byte/time bounds |
| Secrets exfiltrated from PR or config/log | No cloud identity in untrusted CI, minimal permissions, redaction, secret scanning; S11 constrained OIDC | S3 scanner/permissions; S11 untrusted-role denial |
| Redis outage or poison/replayed cache job | Synchronous PG truth; fail-fast cache path; versioned validated job, bounded retries/retention, persistence/noeviction | S7 duplicate/disconnect/poison/SIGTERM tests |
| Cloud origin bypass, runaway cost or failed destroy | Origin restriction; admission and independent qualified cleanup; separate provisioning/cleanup permissions | S11/S12 admission rejection, direct-origin denial and residual inventory |

## Initial API bounds for S5

JSON body maximum 16 KiB; autocomplete query maximum 80 characters and 20 results; idempotency key maximum 128 ASCII characters; command timeout 5 seconds including bounded database lock wait (1 second) and statement timeout (3 seconds). Abort/rollback before success receipt if transaction cannot complete. HTTP timeout uncertainty requires a retry with the same key, not a new mutation.

Per-minute limits: 30 mutations per guest, 120 per source IP; 120 autocomplete reads per guest, 300 per IP; 10 session creations per IP. Trust forwarding headers only from configured deployment proxies. These are initial tunable abuse limits, separate from benchmark traffic. Return 429 with Retry-After. Security throttling must remain available when Redis fails: use a bounded per-process limiter as fallback and document its weaker aggregate limit across replicas; database gameplay limits remain authoritative. Bound fallback storage and reject excess new identities rather than allocating unbounded entries.

Store session/receipt data until absolute session expiry; never delete receipts while the same identity can authenticate. Profile persistence after session expiry does not allow identity recovery. Operational logs use request ID, route template, status and timing, not cookies, CSRF/idempotency tokens, guesses, answers, imported text or raw request URLs. Metrics use bounded labels, never guest/attempt IDs. S10 sets measured retention and tests redaction end to end.

Residual risks: Public source repositories can reveal authored puzzle answers; friends can share solutions and new sessions can replay. This is a recreational puzzle, not a competition with prizes or strong anti-cheat claims. Guest credential loss is irreversible. Cloud overage cannot be guaranteed impossible; unproven exposure blocks AWS under the cost policy.
