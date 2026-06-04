# syrnike13 app

Monorepo for syrnike13 web, desktop, backend and voice infrastructure.

## Layout

- `apps/web` - React/TanStack web client.
- `apps/desktop` - Electron shell for the same web client.
- `packages/platform` - shared runtime/capability layer for web and desktop.
- `services/backend` - Rust backend and backend daemons.
- `services/livekit-server` - LiveKit server fork used by voice.
- `deploy/production` - production compose and deploy scripts.

`VERSION` is the single release version source. Release workflows run on `main` only when `VERSION` changes.
