# AGENTS.md instructions for /Users/tiredisa/syrnike13/syrnike13-app

## Working Rules

- Never use `fork_context=true` when spawning subagents.
- Always wait for subagents to actually finish before relying on their result or finalizing the task.
- Do not search inside `node_modules`; always exclude it from searches.
- Do not create pointless wrappers around functions.
- Do not add backwards compatibility unless explicitly requested. If it may be needed, ask first.
- Ask the user questions at points that affect architecture, style, security, or readability.
- The user does not see code by default. When explaining changes, cite concrete files and code snippets.
- For bugs, look for the architectural cause, not only the immediate failure.
- If an architectural change seems necessary, explain the problem and ask for consent before changing architecture.
- Prefer simple, maintainable, production-friendly solutions. Keep APIs small and behavior explicit.

## GitHub Workflow

- This repository is `syrnike13/syrnike13-app`.
- Before non-trivial implementation, check the current branch, remotes, linked issue/PR, and relevant existing issues.
- `develop` is the nightly integration branch. Pushes to `develop` are expected to trigger the nightly build/deploy workflow.
- `main` is the production branch. Changes should normally flow from `develop` into `main` when they are ready for production.
- If the task is tied to an existing issue, use or propose a branch name that includes the issue number, for example `fix/123-short-bug-name` or `feature/123-short-feature-name`.
- Do not create GitHub issues, branches, PRs, or comments for trivial one-off edits unless asked.
- For release/deploy work, be explicit about what is local, committed, pushed, and currently deployed.
- If asked to commit, push, and open a PR in one flow, use the `yeet` skill.
- If a PR is genuinely ready for review, open it ready for review unless there is a reason to use draft.

## Project Context

- Project name: `syrnike13`.
- This is the active monorepo for the web app, desktop app, backend services, LiveKit fork, shared packages, and production deployment.
- Root package manager: `pnpm`.
- Root release version source: `VERSION`.
- Release workflows run on `main` when `VERSION` changes.
- Main layout:
  - `apps/web` - React/TanStack web client.
  - `apps/desktop` - Electron desktop app.
  - `packages/api-types` - generated/shared API types.
  - `packages/platform` - shared runtime and capability layer for web and desktop.
  - `services/backend` - Rust backend and backend daemons.
  - `services/livekit-server` - LiveKit server fork used for voice.
  - `deploy/production` - production Docker Compose files and deploy scripts.
  - `tooling` - repository scripts and automation.

## Useful Commands

```sh
pnpm install
pnpm web:dev
pnpm web:build
pnpm web:test
pnpm desktop:dev
pnpm desktop:build
pnpm backend:check
pnpm livekit:check
```

Use the narrower package/service command when a task touches only one area.

## UI colors and theming

Правило для **всего клиентского UI** монорепо: `apps/web`, `apps/desktop` (основной интерфейс — тот же web-клиент в Electron), shared UI в `packages/*`. Бэкенд и инфра без UI на это правило не распространяются.

Цвета интерфейса **не хардкодить** в компонентах, стилях и inline-атрибутах.

**Запрещено в UI-коде:**

- литералы `#hex`, `oklch(...)`, `rgb(...)` / `hsl(...)` для оформления;
- Tailwind palette вроде `bg-emerald-600`, `text-amber-400`, `border-red-500`;
- arbitrary colors вроде `bg-[#23a559]`, `ring-[#ed4245]`, `style={{ color: '#fff' }}`.

**Используй семантические токены** (shadcn/Tailwind в web; в desktop — те же CSS vars, т.к. рендерится `apps/web`):

- `bg-primary`, `text-primary-foreground`, `bg-destructive`, `ring-ring`;
- `bg-chart-1` … `bg-chart-5`, `text-chart-3` и т.п.;
- поверхности: `background`, `foreground`, `card`, `muted`, `accent`, `border`, `sidebar`.

**Источники правды (web / desktop UI):**

| Что | Где |
|-----|-----|
| Палитры тем (light/dark) | `apps/web/src/features/appearance/theme-catalog-data.ts` |
| Runtime-применение | `applyThemeToDocument()` → CSS vars на `:root` |
| Fallback до JS | `getDefaultThemeCss()` в `__root.tsx` |
| Статичные non-color tokens | `apps/web/src/styles.css` (`--radius`, шрифты, тени) — **без** цветовых `--primary`, `--background` и т.п. |
| Brand-locked (всегда из темы **СЫРНИКИ**) | `BRAND_LOCKED_THEME_TOKEN_KEYS` в `theme-tokens.ts` |

**Семантика (ориентир):** успех / голос / online → `chart-3`; предупреждение / idle → `chart-2`; фокус → `chart-5`; опасность → `destructive`; бренд-акцент → `primary`. Presence: `apps/web/src/lib/presence.ts`.

**Допустимые исключения:**

- цвета ролей/серверов из API и палитра выбора цвета роли (`role-colour-picker.tsx`);
- декоративные градиенты (`avatar-tile-palette.ts`);
- `<meta theme-color>` и аналогичные meta/fallback hex;
- нативная оболочка desktop без themed DOM: прозрачность оверлея (`#00000000`), `backgroundColor` окна до загрузки web — не семантические цвета интерфейса.

Подробнее: `.cursor/rules/ui-theming.mdc`.

### Windows backend checks

- On Windows, do not spend time installing or repairing the backend Rust/OpenSSL/Docker toolchain just to satisfy `pnpm backend:check`. This workspace may not have OpenSSL/vcpkg/Docker configured.
- If `pnpm backend:check` or Rust backend checks fail because `openssl-sys`, OpenSSL, vcpkg, Docker, or other local toolchain pieces are missing, report it as an environment blocker instead of downloading/installing those dependencies.
- Only install or reconfigure Windows backend dependencies when the user explicitly asks for local backend setup. For backend changes, prefer focused checks that already run in the current environment, then state that full backend verification needs a configured Linux/backend environment or CI.

## Production Context

- Production domain: `syrnike13.ru`.
- Backend API is available under `https://syrnike13.ru/api`.
- Current production server IP: `195.209.213.95`.
- Production SSH user: `ubuntu`.
- SSH key used locally for current production access: `/Users/tiredisa/syrnike13/.deploy/syrnike13-191541-tiredisa.pem`.
- Server deployment lives at `/opt/syrnike13`.
- Production stack is Docker Compose based, using the `syrnike13` compose project.
- The monorepo production source of truth is `deploy/production/compose.yml`.
- Server-local runtime files must not be overwritten by repo syncs:
  - `data/`
  - `.env`
  - `.env.web`
  - `secrets.env`
  - `Syrnike.toml`
  - `livekit.yml`
  - `compose.override.yml`
- Do not write server passwords, GitHub tokens, S3 credentials, LiveKit secrets, or other secrets into repo files.
- Production object storage can be external S3 or local MinIO depending on server-local config. Inspect `/opt/syrnike13/Syrnike.toml` and server-local env files on the server before making storage claims.

## Nightly / Develop Context

- Nightly is the fully independent beta environment for the `develop` branch.
- Nightly web domain: `beta.syrnike13.ru`.
- Nightly backend API is available under `https://beta.syrnike13.ru/api`.
- Nightly server deployment lives at `/opt/syrnike13-nightly`.
- Nightly stack is Docker Compose based, using the `syrnike13-nightly` compose project.
- The monorepo nightly source of truth is `deploy/nightly/compose.yml`.
- Nightly uses independent runtime state and service containers from production. Do not point nightly services at production data, secrets, object storage buckets, databases, Redis, RabbitMQ, or LiveKit config unless the user explicitly asks for a temporary diagnostic.
- Nightly images are tagged as `:nightly` and commit-specific `:nightly-<sha>` images by the nightly workflow.
- The production Caddy container is the shared public edge for both `syrnike13.ru` and `beta.syrnike13.ru`; route production by stable production container names and nightly by `syrnike13-nightly-*` aliases to avoid Docker DNS collisions.
- Nightly desktop builds must be independent from production desktop builds: separate app id, product name, protocol, data paths where applicable, and beta API/web URLs.
- Nightly desktop releases are distributed only through the GitHub prerelease/tag `nightly`. Do not enable desktop auto-update for the nightly channel.
- The `nightly` GitHub release is mutable: each successful nightly run may replace the `nightly` tag and release assets with the latest `develop` build.

## Production Checks

Healthy unauthenticated checks:

```sh
curl -k https://syrnike13.ru/api
curl -k https://syrnike13.ru/api/auth/account/
```

Healthy nightly unauthenticated checks:

```sh
curl -k https://beta.syrnike13.ru/api
curl -k https://beta.syrnike13.ru/api/auth/account/
```

Server access:

```sh
ssh -i /Users/tiredisa/syrnike13/.deploy/syrnike13-191541-tiredisa.pem -o StrictHostKeyChecking=no ubuntu@195.209.213.95
```

Useful server commands:

```sh
cd /opt/syrnike13
docker compose ps
docker stats --no-stream
docker compose logs --tail 200
```

Useful nightly server commands:

```sh
cd /opt/syrnike13-nightly
docker compose ps
docker stats --no-stream
docker compose logs --tail 200
```

## Release Safety

- Before changing production compose, make a backup of `/opt/syrnike13/compose.yml`.
- Prefer scoped restarts such as `docker compose up -d --no-deps <service>` when only a small service set changed.
- Do not run destructive Docker, filesystem, or database commands unless the user explicitly asks.
- For production investigations, avoid printing secrets from `.env`, `.env.web`, `secrets.env`, `Syrnike.toml`, or `livekit.yml`.
- For deploy verification, compare the local commit/version, pushed state, GitHub Actions run, server image/container state, and public endpoint behavior before saying production is updated.
- For nightly deploy verification, compare the pushed `develop` commit, nightly GitHub Actions run, `nightly` release assets, server image/container state, and `https://beta.syrnike13.ru/api` behavior before saying nightly is updated.
- When changing shared production/nightly edge routing, verify both `https://syrnike13.ru/api` and `https://beta.syrnike13.ru/api`; a fix for one host must not silently route the other host to the wrong backend.

## Cursor Cloud specific instructions

### Быстрый старт (web)

По умолчанию `pnpm web:dev` подключается к **продакшен API** (`syrnike13.ru`). Для UI-разработки не нужны Docker, Rust или локальный бэкенд:

```sh
pnpm install
pnpm web:dev   # http://localhost:3000
```

Проверки: `pnpm web:test` (242 теста), `pnpm web:build`, typecheck в `packages/platform` и `packages/api-types`.

### Локальный бэкенд (полный E2E)

Требует Docker + инфра из `services/backend/compose.yml` (MongoDB, KeyDB, RabbitMQ, MinIO) и Rust **1.92** (edition 2024). В Cloud VM Docker по умолчанию **не установлен**; для `cargo check`/`cargo build` нужны `libssl-dev` и `pkg-config` (системные пакеты, не в update-скрипте).

```sh
source /usr/local/cargo/env   # если rustup установлен в /usr/local/cargo
pnpm backend:check            # cargo check workspace
cd services/backend && docker compose up -d && mise run start   # при наличии Docker и mise
```

Переменные для локального API — см. `apps/web/.env.example` (`VITE_API_URL`, `VITE_WS_URL`, и т.д.).

### Dev-сервер в tmux

Долгоживущие процессы (Vite, Electron) запускайте в tmux:

```sh
tmux -f /exec-daemon/tmux.portal.conf new-session -d -s web-dev-server -c /workspace -- "${SHELL:-zsh}" -l
tmux -f /exec-daemon/tmux.portal.conf send-keys -t web-dev-server:0.0 'pnpm web:dev' C-m
```

### Прочее

- **mise** — опционален; версии инструментов для бэкенда в `services/backend/.mise/config.toml` (Node 25, Rust 1.92, pnpm 10).
- **Desktop**: `pnpm desktop:dev` тянет Electron; в headless VM без GUI удобнее ограничиться web.
- **LiveKit**: `pnpm livekit:check` — `go test ./...` в `services/livekit-server` (нужен Go ≥1.24 из `go.mod`).
- Отдельного root `lint`-скрипта нет; для web — `pnpm web:test` и сборка.
