# Disposable T25 test dependency. Never included in a runtime build context.
FROM postgres:17.11-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb
RUN apk add --no-cache libfaketime=0.9.14-r0
# The stock entrypoint and initdb keep real time. Only the postgres process
# running as UID 70 receives the preload, so root-owned shared-memory state
# cannot leak into its children during the entrypoint's privilege drop.
# Only PID 1 (the server the entrypoint finally execs) is faked: initdb and
# the entrypoint's temporary server keep real time, because pg_ctl rejects a
# postmaster.pid whose start time is behind its own clock as stale.
RUN mv /usr/local/bin/postgres /usr/local/bin/postgres-real \
    && printf '#!/bin/sh\nif [ "$(id -u)" = 70 ] && [ "$$" = 1 ]; then export LD_PRELOAD=/usr/lib/faketime/libfaketime.so.1; fi\nexec /usr/local/bin/postgres-real "$@"\n' > /usr/local/bin/postgres \
    && chmod 0755 /usr/local/bin/postgres
