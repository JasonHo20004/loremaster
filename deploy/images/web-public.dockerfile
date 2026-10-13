FROM node:22.23.3-alpine@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8 AS build
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/ ./apps/
COPY packages/ ./packages/
RUN corepack enable && pnpm install --frozen-lockfile
ENV VITE_API_BASE_URL=/api/v1
RUN pnpm --filter @loremaster/contracts build && pnpm --filter @loremaster/web build
FROM nginxinc/nginx-unprivileged:mainline-alpine@sha256:c18d735d33a1c3ccb5ef201d504e5b4aa4d003e81f034b329011267f4c4d0f58 AS gateway
USER 0
RUN apk add --no-cache pcre2=10.49-r0
COPY scripts/s8-rootfs.sh /build-rootfs.sh
RUN sh /build-rootfs.sh web
FROM scratch AS runtime
ARG VCS_REF
ARG BUILD_CREATED
ARG SOURCE_DATE_EPOCH
LABEL org.opencontainers.image.created=$BUILD_CREATED org.opencontainers.image.revision=$VCS_REF org.opencontainers.image.source="https://github.com/JasonHo20004/loremaster" org.opencontainers.image.title="loremaster/web" org.opencontainers.image.version="s8"
COPY --from=gateway /runtime/ /
COPY --from=build /build/apps/web/dist/ /srv/web/
COPY deploy/images/nginx.conf /etc/nginx/nginx.conf
WORKDIR /srv/web
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGQUIT
ENTRYPOINT ["/usr/sbin/nginx", "-e", "/dev/stderr", "-g", "daemon off;"]
