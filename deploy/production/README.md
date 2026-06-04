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

Production releases are driven by the root `VERSION` file. A push to `main`
publishes and deploys release images only when `VERSION` changes.

The active deploy workflow is:

- `.github/workflows/release-images-and-deploy.yml`

The compose file expects these GHCR images:

- `ghcr.io/syrnike13/for-web`
- `ghcr.io/syrnike13/api`
- `ghcr.io/syrnike13/events`
- `ghcr.io/syrnike13/file-server`
- `ghcr.io/syrnike13/proxy`
- `ghcr.io/syrnike13/gifbox`
- `ghcr.io/syrnike13/crond`
- `ghcr.io/syrnike13/pushd`
- `ghcr.io/syrnike13/voice-ingress`
- `ghcr.io/syrnike13/livekit-server`
