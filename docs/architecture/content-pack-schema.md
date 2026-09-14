# Content pack schema

Accepted S4.4 baseline, 2026-09-13. The executable contract is
`packages/database/src/content/schema.ts`; the validator is server-only under
`@loremaster/database/content`.

## Shape and limits

All fields are required and unknown fields are rejected. IDs use lower-case
ASCII letters, digits, underscores, and hyphens, start with a letter, and are at
most 64 characters. Source IDs are internal identifiers of at most 128
characters, never fetchable URLs. Content versions are SemVer strings of at
most 32 characters. Revision numbers are positive PostgreSQL integers.

| Field | Bound |
| --- | ---: |
| author | 1–120 characters |
| title | 1–120 characters |
| briefing | 1–2,000 characters |
| entities | 2–32 |
| canonical name | 1–80 characters |
| public role | 1–160 characters |
| aliases per entity | 1–8, each 1–80 characters |
| regions | 1–8; display names are 1–80 characters |
| case regions | 1–8 |
| evidence | exactly four entries with orders 1, 2, 3, and 4 |
| evidence text | 1–1,000 characters |
| explanation | 1–1,500 characters |
| sources | 1–16 |
| case sources | 1–16 |
| source citation | 1–240 characters |

The only accepted provenance value is `ORIGINAL_AUTHORED`. Narrative fields
are plain text: markup-like delimiters, link syntax, executable URI schemes,
and external HTTP/WWW URLs are rejected. Import code never fetches a source.

`slotId`, `opensAt`, and `closesAt` describe exactly one UTC calendar day.
The opening instant must be midnight for `slotId`; closing must be the adjacent
midnight. PostgreSQL remains the final authority for overlap arbitration.
The importer stores the case key, title, author, provenance, and content version
on the immutable revision alongside its playable graph. Migration 0002 requires
that metadata on every newly published revision while preserving any historical
rows created before the constraint existed.

Entity IDs, region IDs, source IDs, aliases, and evidence orders are unique.
Alias comparison uses Unicode NFKC, trimming, and case folding; an alias or
canonical name cannot resolve to two entities. Repeated case regions are
rejected rather than normalized so an author must correct ambiguous input.

## Diagnostics and trust boundary

Validation returns every independently detectable error sorted by path and
stable code. Diagnostics contain only `{ code, path }`; they never echo an
input value or narrative and are therefore safe to log. Validation success
returns a newly constructed allowlisted object rather than the original row or
file object.

The Aster Quay fixture lives only in
`packages/database/src/content/fixtures`. Browser, contract, and domain source
must not import `@loremaster/database` or contain private fixture narrative.
The future public-web image must copy only entries in
`ops/build-contexts/web-public.allowlist`, which deliberately excludes all
documentation, the historical Riot-inspired document, and database content.
Built-bundle and deployed-artifact proof remains assigned to S6/S8.
