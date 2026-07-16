FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml VERSION ./
COPY apps/admin/package.json apps/admin/
COPY packages/api-types/package.json packages/api-types/

RUN pnpm install --frozen-lockfile

COPY apps/admin apps/admin
COPY packages/api-types packages/api-types
COPY tooling tooling

ENV NODE_ENV=production
ARG VITE_APP_TITLE=syrnike13 Admin
ARG VITE_RELEASE_CHANNEL=stable
ARG VITE_API_URL=https://syrnike13.ru/api
ARG VITE_MEDIA_URL=https://syrnike13.ru/autumn
ARG VITE_ADMIN_WEB_URL=https://admin.syrnike13.ru
ENV VITE_APP_TITLE=$VITE_APP_TITLE
ENV VITE_RELEASE_CHANNEL=$VITE_RELEASE_CHANNEL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_MEDIA_URL=$VITE_MEDIA_URL
ENV VITE_ADMIN_WEB_URL=$VITE_ADMIN_WEB_URL

RUN pnpm version:sync && \
    export VITE_APP_VERSION="$(cat VERSION)" && \
    pnpm --filter @syrnike13/admin build

FROM node:24-alpine

WORKDIR /app/apps/admin

ENV NODE_ENV=production
ENV PORT=5000

COPY apps/web/docker/server.mjs ./server.mjs
COPY apps/web/docker/spa-server.mjs ./spa-server.mjs
COPY --from=builder /build/apps/admin/dist ./dist

EXPOSE 5000

CMD ["node", "server.mjs"]
