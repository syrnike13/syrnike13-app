# AGENTS.md instructions for /Users/tiredisa/syrnike13

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

- When the current folder is a GitHub repository, check branch, remotes, linked issues/PRs, and relevant existing issues before non-trivial implementation.
- Do not create GitHub issues, branches, PRs, or comments for trivial one-off edits unless asked.
- For release/deploy work, be explicit about what is local, committed, pushed, and currently deployed.
- If asked to commit, push, and open a PR in one flow, use the `yeet` skill.
- If a PR is genuinely ready for review, open it ready for review unless there is a reason to use draft.

## Project Context

- Project name: `syrnike13`.
- Production domain: `syrnike13.ru`.
- Production server IP: `195.209.213.95`.
- Production SSH user: `ubuntu`.
- SSH key used locally for current production access: `/Users/tiredisa/syrnike13/.deploy/syrnike13-191541-tiredisa.pem`.
- Previous production server IP: `194.87.37.85`.
- Previous server SSH key: `/Users/tiredisa/syrnike13/.deploy/syrnike13_deploy_ed25519`.
- Do not write server passwords, GitHub tokens, or other secrets into repo files.
- Server deployment lives at `/opt/syrnike13`.
- Production stack is Docker Compose based, using the `syrnike13` compose project.
- Production object storage is external S3:
  - endpoint: `https://s3.msk.immers.cloud`
  - bucket: `revolt-uploads`
  - `path_style_buckets = true`
  - access key and secret key must stay only in server-local config/secrets, never in repo files.
- Main server compose repository: `/Users/tiredisa/syrnike13/self-hosted`, GitHub remote `syrnike13/self-hosted`.
- Web repository: `/Users/tiredisa/syrnike13/for-web`, GitHub remote `syrnike13/for-web`.
- Desktop repository: `/Users/tiredisa/syrnike13/for-desktop`, GitHub remote `syrnike13/for-desktop`.
- The project is being detached from the original Stoat/Revolt upstreams and should continue under `syrnike13` branding.

## Current Production Status

- Web is served at `https://syrnike13.ru`.
- Backend API is available under `https://syrnike13.ru/api`.
- Current production server is `195.209.213.95`; DNS for `syrnike13.ru` was moved there on 2026-06-03.
- New server setup completed on 2026-06-03:
  - Docker and Docker Compose installed.
  - UFW enabled.
  - Open ports: `22/tcp`, `80/tcp`, `443/tcp`, `7881/tcp`, `3478/udp`, `30000-30100/udp`, `50000-50100/udp`.
  - Let's Encrypt certificate issued by Caddy.
  - MongoDB data migrated from `194.87.37.85`.
  - old MinIO objects mirrored into external S3 bucket `revolt-uploads`.
  - old `secrets.env` and `livekit.yml` copied to preserve file encryption and LiveKit credentials.
- Verified migrated data counts after move:
  - users: `5`
  - accounts: `5`
  - servers: `1`
  - channels: `6`
  - messages: `20`
  - attachments: `11`
- New backend voice state endpoint is deployed:
  - `GET /api/channels/{channel_id}/voice_state`
  - OpenAPI operation id: `voice_state_fetch`.
- A healthy unauthenticated API check is:
  - `curl -k https://syrnike13.ru/api`
  - `curl -k https://syrnike13.ru/api/auth/account/` should return unauthorized without auth.
- The previous blank web page was caused by the web app being built for `/app/`; it was fixed by serving web assets from root.
- Some UI text may still contain old Stoat branding and should be cleaned up in future branding passes.

## Server Load Findings

- For a small pilot load, the current server has been sufficient.
- Typical low-load readings observed:
  - load average around `0.05-0.35`
  - available RAM around `2.6GiB`
  - disk around `9.7G used` of `40G`
- User traffic was not the cause of observed CPU spikes.
- The main observed spikes came from infrastructure healthchecks and deploy/startup activity:
  - MongoDB healthcheck previously ran `mongosh` every `10s`.
  - RabbitMQ healthcheck previously ran `rabbitmq-diagnostics -q ping` every `10s`.
  - Docker/containerd activity during deployment caused temporary pull/recreate/network-interface noise.
- The healthcheck overhead was reduced in `self-hosted` commit `8a4c636 Reduce infrastructure healthcheck overhead`.
- Current intended healthcheck settings:
  - MongoDB: `interval: 60s`, `timeout: 5s`, `start_period: 30s`.
  - RabbitMQ: `interval: 60s`, `timeout: 5s`, `start_period: 30s`.
- After that change, healthchecks should run about once per minute per service instead of every 10 seconds.

## Windows Desktop Build And Release

- Desktop app repository: `/Users/tiredisa/syrnike13/for-desktop`.
- Current Windows desktop release created during setup: `v1.3.1`.
- GitHub Release URL:
  - `https://github.com/syrnike13/for-desktop/releases/tag/v1.3.1`
- User-facing Windows installer asset:
  - `syrnike13-desktop-setup.exe`
- Squirrel/update assets that must be present in GitHub Releases:
  - `RELEASES`
  - `syrnike13-<version>-full.nupkg`
  - `syrnike13-desktop-setup.exe`
- The Windows build workflow is `.github/workflows/build.yml` in `for-desktop`.
- The workflow should use:
  - `windows-2022`
  - Node `22`
  - `pnpm run make -- --platform=win32 --arch=x64`
- Node `24` caused Windows native build failures around `register-scheme` / `llvm-lib.exe`.
- The desktop app uses `update-electron-app`.
- Auto-update depends on GitHub Releases and `update.electronjs.org`.
- Verified update endpoint example:
  - `https://update.electronjs.org/syrnike13/for-desktop/win32-x64/1.3.0`
  - It should return the newer release and URL to `syrnike13-desktop-setup.exe`.

## Useful Server Commands

```sh
ssh -i /Users/tiredisa/syrnike13/.deploy/syrnike13-191541-tiredisa.pem -o StrictHostKeyChecking=no ubuntu@195.209.213.95
```

```sh
ssh -i /Users/tiredisa/syrnike13/.deploy/syrnike13_deploy_ed25519 -o StrictHostKeyChecking=no root@194.87.37.85
```

```sh
cd /opt/syrnike13
docker compose ps
docker stats --no-stream
docker compose logs --tail 200
```

```sh
docker inspect syrnike13-database-1 syrnike13-rabbit-1 \
  --format '{{.Name}} interval={{.Config.Healthcheck.Interval}} timeout={{.Config.Healthcheck.Timeout}} status={{.State.Health.Status}}'
```

## Release Safety

- Before changing production compose, make a backup of `/opt/syrnike13/compose.yml`.
- Prefer scoped restarts such as:
  - `docker compose up -d --no-deps database rabbit`
- Do not run destructive Docker or database commands unless the user explicitly asks.
- For production investigations, avoid printing secrets from `.env`, `.env.web`, or `secrets.env`.
