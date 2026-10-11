# S8.3-S8.5 image construction evidence

Recorded 2026-10-11 on `codex/s8-images`, based on S8.0-S8.2 contract commit
`fef3963908986cc3426ddf6cd3524bdc64906a57`. This record covers the
three image slices requested together. It is local development evidence;
hosted clean-checkout validation and review still gate merge.

## Assembled images

| Image                     | Local image ID                                                            | Responsibility                                    |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `loremaster/api:s8`       | `sha256:285bd56352eec28e3617d8497e946c462dbe0bb1a15ef26dc612b5bc9e03f7d1` | API only, UID 10002, private port 3000            |
| `loremaster/worker:s8`    | `sha256:f51d54699eee83902171112ee2e716afcae629876160d6c24e66932e1aa3c9ed` | Cache worker only, UID 10003, private port 3001   |
| `loremaster/observer:s8`  | `sha256:569f078661c29fb5f38fb123dd26cb90845103881c345c7a5660c60168246b6d` | Queue observer only, UID 10004, private port 3002 |
| `loremaster/migration:s8` | `sha256:3dd97a8df74d68040688dd7b37824a725b2c56f2efbf62b68e31cd36b71b54c5` | One-shot forward migration, UID 10005             |
| `loremaster/importer:s8`  | `sha256:86e2d626b364da0f99234252b7331e829bb245a636f59af39c82fb5249ca9958` | One-shot content import, UID 10006                |
| `loremaster/web:s8`       | `sha256:d92c1d4db45c2acca693c49543ff5c993a060ebfaa093540a7ce3f15f90c60bd` | Public static gateway, UID 10001, port 8080       |

These are local image IDs from a stable uncommitted source snapshot. The OCI
revision label is the parent commit, so these IDs are not release identifiers.
The final reviewed commit must be built and scanned again in hosted CI.

## Gates run

| Gate                                                        | Local result                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run verify` after the S8 runtime edits                | PASS: format, lint, typecheck, 404 tests in 47 files, 11 workspace builds                                                                                                                                                |
| `pnpm test:s8:image-policy`                                 | PASS: static image policy and 22 focused tests                                                                                                                                                                           |
| Six profile builds from generated allowlisted contexts      | PASS: digest-pinned builders, frozen pnpm install, numeric non-root `scratch` final stages                                                                                                                               |
| Repeat of all six builds with unchanged source              | PASS: every image ID and context SHA-256 was identical on both runs                                                                                                                                                      |
| `node scripts/s8-images-test.mjs all` after the final build | PASS: disposable PostgreSQL/Redis; migration apply/no-op; importer valid, invalid, duplicate and mount denials; API/worker/observer readiness and shutdown; browser, cookie, origin, proxy-header and cache journeys     |
| `node scripts/s8-artifacts.mjs`                             | PASS: per-image file inventory, CycloneDX SBOM and Trivy vulnerability/license scan; zero HIGH/CRITICAL findings in all six final images; five public artifacts including the source map scanned without private markers |
| Node executable version and rejection behavior              | PASS: the final Node images report the pinned v22.23.3 runtime; strict unhandled rejection exits nonzero                                                                                                                 |
| `pnpm audit --audit-level moderate`                         | PASS: no known dependency vulnerabilities after pinning `proxy-addr` 2.0.8 and `source-map-js` 1.2.2                                                                                                                     |
| `pnpm test:database`                                        | PASS: 93 PostgreSQL tests                                                                                                                                                                                                |
| `pnpm test:api:database`                                    | PASS: 7 composed API/PostgreSQL tests                                                                                                                                                                                    |
| `pnpm test:s7:redis`                                        | PASS: 8 real Redis scenarios                                                                                                                                                                                             |
| `pnpm test:s7:integration`                                  | PASS: 9 composed failure and security scenarios                                                                                                                                                                          |
| `git diff --check`                                          | PASS                                                                                                                                                                                                                     |

The image tests apply read-only roots, dropped capabilities, no new privileges,
bounded memory/PIDs/CPU/file descriptors, and a bounded `/tmp` mount. Runtime
processes receive only file paths for secrets. The operator actions remain
separate from long-running service images. Public web assets are built only
from the `web-public` allowlist; NGINX forwards only `/api/`, preserves the
browser Origin bytes, and replaces inbound forwarding claims with its direct
client address.

The vulnerability scan uses Trivy 0.74.0 and its 2026-10-11 database. The
previous candidate runtime bases were not admitted wholesale; required runtime
files are copied into minimal final stages and the assembled images are
scanned. No vulnerability exception was added. The dependency patches address
the `proxy-addr` IP-spoofing advisory and `source-map-js` indexed-map denial of
service advisory discovered during this delivery.

## Handoff

S8.6 owns durable PostgreSQL/Redis data services, actual mounted secret
permissions, and runtime role provisioning. S8.7 owns Compose topology. S8.8
and later slices own recovery, clean-volume journeys, final artifact acceptance,
and the S9 handoff. The S8.3-S8.5 test harness uses disposable dependencies
only; it does not configure persistent local services or publish an image.
