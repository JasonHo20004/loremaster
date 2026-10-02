# S8 container environment contract

This freezes inputs for the future local Compose stack. S8.3-S8.7 will build
and wire the images and gateway. It does not start a container stack.

## File-backed runtime secrets

Each supported secret accepts either the existing direct environment variable
in local host development or its `*_FILE` counterpart. The two forms are
mutually exclusive. Production mode requires file inputs. The file contains
the exact previous value without a trailing newline. The parser reads it once
at startup and reports only the field name on failure. URL passwords remain
inside URL secret files; there is no separate password environment value.

| Process                | File inputs                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                    | `DATABASE_URL_FILE`, `LOREMASTER_API_CURSOR_ACTIVE_KEY_FILE`, optional `LOREMASTER_API_CURSOR_PREVIOUS_KEY_FILE`                                                                                      |
| API with Redis enabled | `LOREMASTER_REDIS_CACHE_URL_FILE`, `LOREMASTER_REDIS_LIMITER_URL_FILE`, `LOREMASTER_REDIS_PRODUCER_URL_FILE`, `LOREMASTER_REDIS_PRODUCER_DATABASE_URL_FILE`, `LOREMASTER_REDIS_LIMITER_HMAC_KEY_FILE` |
| Worker                 | `LOREMASTER_WORKER_REDIS_URL_FILE`, `LOREMASTER_WORKER_CACHE_REDIS_URL_FILE`, `LOREMASTER_WORKER_DATABASE_URL_FILE`                                                                                   |
| Observer               | `LOREMASTER_OBSERVER_REDIS_URL_FILE`                                                                                                                                                                  |

Files must be absolute-path regular files, at most 4,096 bytes, with no
symlink in the path, NUL, empty content, or leading/trailing whitespace. Linux
container ownership is root or the process UID and permission bits are exactly
`0400`, `0440`, or `0444`. The latter accommodates Compose's default read-only
file mount. This is a container policy: Windows does not expose POSIX
ownership/mode reliably, so local Windows development should use direct values.
The original environment contains only file paths in container mode; parsed
configuration redacts secrets from JSON and Node inspection. Never spread or
log a configuration object into another structure. No secret belongs in a
Dockerfile, build argument, label, resolved Compose environment, or process
argument.

Docker Compose currently ignores `uid`, `gid`, and `mode` for secrets sourced
from files because it bind-mounts them. S8.6 must inspect effective permissions
in the running Linux containers; it cannot rely on long-syntax fields alone.
See the [Compose service secrets reference](https://docs.docker.com/reference/compose-file/services/#secrets).

## Local edge

`ops/s8/local-edge.json` is the source for the Compose/gateway implementation:

- Browser origin: `http://localhost:8080`; publish web on host loopback port 8080. API mode is `local`, with the two accepted `loremaster_local_*` cookies.
- Private ports: API 3000, worker 3001, observer 3002. PostgreSQL and Redis
  publish no host port by default.
- Edge CIDR: `172.30.80.0/28`. Only web and API join it. Web is fixed at
  `172.30.80.2`, API at `172.30.80.3`; the API trusts only
  `172.30.80.2/32`. API also joins the private backend network.
- The gateway forwards only `/api/`. It drops incoming headers by default,
  explicitly forwards approved browser headers, preserves `Origin` bytes,
  and sets one `X-Forwarded-For` from its direct peer address. It drops inbound
  `Forwarded`, every inbound `X-Forwarded-*`, and `X-Real-IP`. The API rejects
  forwarding claims from all peers other than the exact gateway address.

Production mode retains HTTPS-only origin and `__Host-` cookie validation. It
cannot use this HTTP local profile. S8.5 must test the actual gateway against
spoofed/repeated headers and distinct client addresses before claiming the
edge behavior implemented.
