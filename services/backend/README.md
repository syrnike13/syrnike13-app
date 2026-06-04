# syrnike13 Backend

Rust backend services for the syrnike13 monorepo.

## Services

- `syrnike-delta`: REST API.
- `syrnike-bonfire`: WebSocket events.
- `syrnike-autumn`: file service.
- `syrnike-january`: external media proxy.
- `syrnike-gifbox`: GIF search proxy.
- `syrnike-crond`: scheduled maintenance daemon.
- `syrnike-pushd`: push notification daemon.
- `syrnike-voice-ingress`: LiveKit webhook ingester.

## Local Development

Configuration starts from `Syrnike.toml`. Local overrides can be placed in
`Syrnike.overrides.toml`; test overrides can be placed in
`Syrnike.test-overrides.toml`.

```sh
cargo check --workspace
```

The repository root owns version syncing. Run this from the monorepo root after
changing `VERSION`:

```sh
pnpm version:sync
```

## Production

Production compose files live in `deploy/production` at the monorepo root.
Secrets must stay server-local and must not be committed.
