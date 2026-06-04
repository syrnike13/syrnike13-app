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

## Production Checks

Healthy unauthenticated checks:

```sh
curl -k https://syrnike13.ru/api
curl -k https://syrnike13.ru/api/auth/account/
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

## Release Safety

- Before changing production compose, make a backup of `/opt/syrnike13/compose.yml`.
- Prefer scoped restarts such as `docker compose up -d --no-deps <service>` when only a small service set changed.
- Do not run destructive Docker, filesystem, or database commands unless the user explicitly asks.
- For production investigations, avoid printing secrets from `.env`, `.env.web`, `secrets.env`, `Syrnike.toml`, or `livekit.yml`.
- For deploy verification, compare the local commit/version, pushed state, GitHub Actions run, server image/container state, and public endpoint behavior before saying production is updated.
