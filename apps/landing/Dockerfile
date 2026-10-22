FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml VERSION ./
COPY apps/landing/package.json apps/landing/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile

COPY apps/landing apps/landing
COPY packages/ui packages/ui
COPY tooling tooling

ENV NODE_ENV=production
ARG VITE_APP_TITLE=syrnike13
ARG VITE_APP_URL=https://app.syrnike13.ru
ENV VITE_APP_TITLE=$VITE_APP_TITLE
ENV VITE_APP_URL=$VITE_APP_URL

RUN pnpm --filter @syrnike13/landing build

FROM node:24-alpine

WORKDIR /app/apps/landing

ENV NODE_ENV=production
ENV PORT=5000

COPY apps/landing/docker/server.mjs ./server.mjs
COPY --from=builder /build/apps/landing/dist ./dist

EXPOSE 5000

CMD ["node", "server.mjs"]
