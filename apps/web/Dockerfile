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
ENV VITE_APP_TITLE=syrnike13
ENV VITE_API_URL=https://syrnike13.ru/api
ENV VITE_WS_URL=wss://syrnike13.ru/ws
ENV VITE_MEDIA_URL=https://syrnike13.ru/autumn
ENV VITE_PROXY_URL=https://syrnike13.ru/january
ENV VITE_GIFBOX_URL=https://api.gifbox.me
ENV VITE_VOICE_NODE=worldwide

RUN pnpm version:sync && \
    export VITE_APP_VERSION="$(cat VERSION)" && \
    pnpm --filter @syrnike13/web build

FROM node:24-alpine

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml VERSION ./
COPY apps/web/package.json apps/web/
COPY packages/api-types/package.json packages/api-types/
COPY packages/platform/package.json packages/platform/
RUN pnpm install --frozen-lockfile --prod --filter @syrnike13/web...

WORKDIR /app/apps/web

COPY apps/web/docker/server.mjs ./server.mjs
COPY --from=builder /build/apps/web/dist ./dist

EXPOSE 5000

CMD ["node", "server.mjs"]
