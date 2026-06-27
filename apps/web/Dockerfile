FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml VERSION ./
COPY apps/web/package.json apps/web/
COPY packages/api-types/package.json packages/api-types/
COPY packages/platform/package.json packages/platform/

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/api-types packages/api-types
COPY packages/platform packages/platform
COPY tooling tooling

ENV NODE_ENV=production
ARG VITE_APP_TITLE=syrnike13
ARG VITE_API_URL=https://syrnike13.ru/api
ARG VITE_WS_URL=wss://syrnike13.ru/ws
ARG VITE_MEDIA_URL=https://syrnike13.ru/autumn
ARG VITE_PROXY_URL=https://syrnike13.ru/january
ARG VITE_GIFBOX_URL=https://api.gifbox.me
ARG VITE_VOICE_NODE=worldwide
ENV VITE_APP_TITLE=$VITE_APP_TITLE
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_MEDIA_URL=$VITE_MEDIA_URL
ENV VITE_PROXY_URL=$VITE_PROXY_URL
ENV VITE_GIFBOX_URL=$VITE_GIFBOX_URL
ENV VITE_VOICE_NODE=$VITE_VOICE_NODE

RUN pnpm version:sync && \
    export VITE_APP_VERSION="$(cat VERSION)" && \
    pnpm --filter @syrnike13/web build

FROM node:24-alpine

WORKDIR /app/apps/web

ENV NODE_ENV=production
ENV PORT=5000

COPY apps/web/docker/server.mjs ./server.mjs
COPY apps/web/docker/spa-server.mjs ./spa-server.mjs
COPY --from=builder /build/apps/web/dist ./dist

EXPOSE 5000

CMD ["node", "server.mjs"]
