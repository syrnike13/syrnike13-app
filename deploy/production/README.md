# syrnike13 Production

This directory contains production compose files and deploy scripts for the
`syrnike13-app` monorepo.

GitHub Actions uploads this directory to `/opt/syrnike13` without overwriting
server-local runtime state:

- `data/`
- `.env`
- `.env.web`
- `secrets.env`
- `Syrnike.toml`
- `livekit.yml`
- `compose.override.yml`

Production releases are driven by the manual `workflow_dispatch` run of
`.github/workflows/release-images-and-deploy.yml` from `main`. The release
version is typed into the run form; nothing is triggered by pushing commits or
by editing the root `VERSION` file.

The active deploy workflow is:

- `.github/workflows/release-images-and-deploy.yml`

The compose file expects these GHCR images:

- `ghcr.io/syrnike13/app-landing`
- `ghcr.io/syrnike13/app-web`
- `ghcr.io/syrnike13/api`
- `ghcr.io/syrnike13/events`
- `ghcr.io/syrnike13/file-server`
- `ghcr.io/syrnike13/proxy`
- `ghcr.io/syrnike13/gifbox`
- `ghcr.io/syrnike13/app-activity-proxy`
- `ghcr.io/syrnike13/crond`
- `ghcr.io/syrnike13/pushd`
- `ghcr.io/syrnike13/voice-ingress`
- `ghcr.io/syrnike13/livekit-server`

Channel Activities (`activity-proxy`, on-demand TLS for
`*.activities.syrnike13.ru`, configuration and local development) are described
in [`docs/deployment.md`](docs/deployment.md#channel-activities).
