FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml VERSION ./
COPY apps/web/package.json apps/web/
COPY apps/activity-lab/package.json apps/activity-lab/
COPY packages/activity-sdk/package.json packages/activity-sdk/
COPY packages/api-types/package.json packages/api-types/
COPY packages/platform/package.json packages/platform/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY apps/activity-lab apps/activity-lab
COPY packages/activity-sdk packages/activity-sdk
COPY packages/api-types packages/api-types
COPY packages/platform packages/platform
COPY packages/ui packages/ui
COPY tooling tooling
# The emoji picker offers only emoji the backend accepts (src/lib/emoji-catalog.ts).
COPY services/backend/crates/core/database/src/models/emojis/unicode_emoji.txt services/backend/crates/core/database/src/models/emojis/

ENV NODE_ENV=production
ARG VITE_APP_TITLE=syrnike13
ARG VITE_RELEASE_CHANNEL=stable
ARG VITE_API_URL=https://syrnike13.ru/api
ARG VITE_PUBLIC_APP_URL=https://app.syrnike13.ru
ARG VITE_PUBLIC_SITE_URL=https://syrnike13.ru
ARG VITE_WS_URL=wss://syrnike13.ru/ws
ARG VITE_MEDIA_URL=https://syrnike13.ru/autumn
ARG VITE_PROXY_URL=https://syrnike13.ru/january
ARG VITE_GIFBOX_URL=https://api.gifbox.me
ARG VITE_VOICE_NODE=worldwide
ENV VITE_APP_TITLE=$VITE_APP_TITLE
ENV VITE_RELEASE_CHANNEL=$VITE_RELEASE_CHANNEL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_PUBLIC_APP_URL=$VITE_PUBLIC_APP_URL
ENV VITE_PUBLIC_SITE_URL=$VITE_PUBLIC_SITE_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_MEDIA_URL=$VITE_MEDIA_URL
ENV VITE_PROXY_URL=$VITE_PROXY_URL
ENV VITE_GIFBOX_URL=$VITE_GIFBOX_URL
ENV VITE_VOICE_NODE=$VITE_VOICE_NODE

RUN pnpm version:sync && \
    export VITE_APP_VERSION="$(cat VERSION)" && \
    pnpm --filter @syrnike13/web build && \
    pnpm --filter @syrnike13/activity-lab build

FROM node:24-alpine

WORKDIR /app/apps/web

ENV NODE_ENV=production
ENV PORT=5000

COPY apps/web/docker/server.mjs ./server.mjs
COPY apps/web/docker/spa-server.mjs ./spa-server.mjs
COPY --from=builder /build/apps/web/dist ./dist
# First-party Activity Lab, proxied by activity-proxy from
# http://web:5000/_activities/lab (ADR-0011).
COPY --from=builder /build/apps/activity-lab/dist ./dist/client/_activities/lab

EXPOSE 5000

CMD ["node", "server.mjs"]
