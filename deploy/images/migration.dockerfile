FROM node:22.23.3-alpine@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8 AS build
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/ ./packages/
COPY scripts/s8-stage.mjs ./scripts/s8-stage.mjs
COPY deploy/images/operator.mjs ./deploy/images/operator.mjs
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @loremaster/database... --filter @loremaster/config build
RUN node scripts/s8-stage.mjs prepare migration && node scripts/s8-stage.mjs package migration && node scripts/s8-stage.mjs clean migration
COPY packages/database/migrations/*.up.sql /out/migrations/
COPY scripts/s8-rootfs.sh /build-rootfs.sh
RUN sh /build-rootfs.sh node
FROM scratch AS runtime
ARG SOURCE_DATE_EPOCH
ARG VCS_REF
ARG BUILD_CREATED
LABEL org.opencontainers.image.created=$BUILD_CREATED org.opencontainers.image.revision=$VCS_REF org.opencontainers.image.source="https://github.com/JasonHo20004/loremaster" org.opencontainers.image.title="loremaster/migration" org.opencontainers.image.version="s8"
COPY --from=build /runtime/ /
COPY --from=build /out/ /app/
WORKDIR /app
ENV NODE_ENV=production
USER 10005:10005
ENTRYPOINT ["/usr/local/bin/node", "--unhandled-rejections=strict", "--disable-proto=throw", "/app/migration.mjs"]
