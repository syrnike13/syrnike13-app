# @syrnike13/activity-sdk

SDK for building **Channel Activities** — web applications that run inside a
syrnike13 voice channel. The SDK is the only interface between your application
and the platform; first-party activities use exactly the same API.

- Dependency-free, ESM, typed.
- Your application runs in an iframe on its own origin
  (`https://{application_id}.activities.syrnike13.ru`), served through the
  syrnike13 activity proxy.

## Quick start

```sh
pnpm add @syrnike13/activity-sdk
```

```ts
import { connect } from '@syrnike13/activity-sdk'

const activity = await connect()
activity.applyTheme() // --syrnike-background, --syrnike-primary, … on <html>

console.log(activity.user.displayName, activity.isHost, activity.state)

activity.on('message', ({ from, payload }) => console.log(from, payload))
activity.on('state', (state) => render(state.data))

await activity.send({ type: 'hello' })
await activity.updateState<{ clicks: number }>((current) => ({
  clicks: (current?.clicks ?? 0) + 1,
}))
```

`connect()` rejects with `ActivityError('unsupported')` when the page is not
inside an Activity Frame, and with `ActivityError('timeout')` if the frame does
not answer within `timeoutMs` (default 10 s).

## API reference

### `connect(options?): Promise<Activity>`

| Option      | Default | Meaning                                                    |
| ----------- | ------- | ---------------------------------------------------------- |
| `timeoutMs` | `10000` | Handshake timeout and timeout of every non-interactive call |

### Live fields

All fields are updated **before** the matching event listeners run.

| Field          | Type                             | Event          |
| -------------- | -------------------------------- | -------------- |
| `context`      | `ActivityContext` (latest ready) | —              |
| `user`         | `ActivityUser`                   | —              |
| `participants` | `ActivityParticipant[]`          | `participants` |
| `hostId`       | `string`                         | `participants` |
| `isHost`       | `boolean`                        | `participants` |
| `state`        | `SharedState`                    | `state`        |
| `theme`        | `ActivityTheme`                  | `theme`        |
| `locale`       | `string` (BCP 47)                | `locale`       |
| `layout`       | `'grid' \| 'focus' \| 'popout' \| 'mini'` | `layout` |
| `connection`   | `'connected' \| 'reconnecting'`  | `connection`   |
| `endReason`    | `EndReason \| null`              | `ended`        |

`context.instance` holds the instance, channel and server ids;
`context.application` holds your application id and name.

### Events

`activity.on(event, listener)` returns an unsubscribe function.

| Event          | Data                              |
| -------------- | --------------------------------- |
| `participants` | `{ participants, hostId }`        |
| `message`      | `{ from, payload }`               |
| `state`        | `SharedState` (only when it advances) |
| `theme`        | `ActivityTheme`                   |
| `locale`       | `{ locale }`                      |
| `layout`       | `{ layout }`                      |
| `connection`   | `{ status }`                      |
| `ended`        | `{ reason }` — no further calls succeed |

### Methods

| Method | Description |
| ------ | ----------- |
| `send(payload, { to? })` | Relay JSON to `to` (participant ids) or to every other participant. The sender does not receive its own message. |
| `setState(data, expectedVersion?)` | Compare-and-set of the shared state. `expectedVersion` defaults to the current `state.version`. Resolves `{ ok: false, state }` on conflict. |
| `updateState(update, { maxAttempts? })` | CAS retry loop: calls `update(current)` (`null` when never written) and retries on conflict, default 5 attempts, then rejects with `version_conflict`. `update` may run several times — keep it pure. |
| `playerData.get()` / `playerData.set(data)` | Private JSON object of the current player in this server. |
| `scores.submit(key, value, mode = 'max')` | `max`/`min` keep the best value, `set` overwrites. |
| `scores.leaderboard(key, { limit?, ascending? })` | Server leaderboard plus your own entry. |
| `authorize(scopes)` | Shows a consent dialog and resolves `{ code }` for your backend. |
| `openExternalLink(url)` | Asks the user to confirm; resolves `true` if the link was opened. |
| `leave()` | Leave the instance; the frame closes afterwards. |
| `end()` | End the activity for everyone (host or channel managers). |
| `applyTheme(target?)` | Writes `--syrnike-<token>` CSS variables and `color-scheme` on `target` (default `<html>`) and follows theme changes. Returns an unsubscribe function. |

### Errors

Every failure is an `ActivityError` with a `code` (`ErrorCode`):
`invalid_request`, `not_participant`, `not_allowed`, `payload_too_large`,
`rate_limited`, `version_conflict`, `cancelled` (user dismissed a dialog),
`disconnected` (gateway down; retry after `connection` becomes `connected`),
`timeout`, `unsupported`, `instance_not_found` (also used for calls after
`ended`), and others listed in `protocol.ts`.

`authorize` and `openExternalLink` wait for the user and have no timeout.

## Multiplayer patterns

### Host-authoritative logic

The backend designates one participant as the **Activity Host**
(`activity.isHost`). When the host leaves, the earliest remaining participant
takes over and you receive a `participants` event with the new `hostId`.

1. Players send **intents** to the host: `send({ type: 'move', … }, { to: [activity.hostId] })`.
2. The host validates them, applies the rules and broadcasts results with
   `send(...)`.
3. The host writes anything a late joiner needs to **shared state**.

Messages are ordered per sender but not stored: anyone who was not connected
misses them. Treat shared state as the source of truth.

### Shared state and CAS

Shared state is one JSON document per instance with a `version`. Writes are
compare-and-set:

```ts
const result = await activity.setState(next, baseVersion)
if (!result.ok) showConflict(result.state) // someone else wrote first
```

For merges that can simply be re-applied, use `updateState`, which retries on
conflict with the latest state.

### Your own backend

Applications that need secrets or cheat resistance run a backend registered in
the application's `url_mappings`. Reach it through the activity proxy at
`/.proxy/<prefix>/…` on your own origin (HTTP and WebSocket). Other origins are
blocked by the Content-Security-Policy.

Identify the user on your backend:

1. `const { code } = await activity.authorize(['identify', 'storage'])`
2. Send `code` to your backend through `/.proxy/<prefix>/`.
3. Your backend exchanges it with its client secret at
   `POST /api/activities/oauth/token` and gets an access token scoped to the
   granted scopes. Never send the client secret to the browser.

## Limits

| Limit                 | Value  |
| --------------------- | ------ |
| Message payload       | 16 KiB |
| Shared state          | 64 KiB |
| Player data           | 16 KiB |
| Messages per second   | 30     |

Sizes are measured as UTF-8 JSON. The SDK rejects oversized payloads with
`payload_too_large` before sending; the backend enforces all limits and rate
limiting (`rate_limited`). Limits are exported as `LIMITS`.

## Frame lifecycle

The client may destroy and recreate your iframe at any time: switching between
grid, focus and pop-out, reloading, or recovering from errors. Do not keep
important state only in memory — restore from `activity.state` on start.

The client may also reconnect an existing frame. The SDK then re-reads the
context and emits events for everything that changed; requests in flight are
rejected with `disconnected`.

After `ended` every call rejects; show a final screen.

## Trust model

- **Messages and shared state** come from participants and can be forged by
  any of them. A host-authoritative design only protects against honest
  mistakes.
- **Player data and scores** written through the SDK use the player's session
  and are marked `trusted: false`. A player can forge their own data, never
  anyone else's.
- Writes made by your backend with an access token are marked `trusted: true`.
  Leaderboards expose the flag so you can display or filter untrusted entries.

## Protocol

The wire protocol (`hello`/`connect` handshake over `postMessage`, then request,
response and event envelopes over a transferred `MessagePort`) is exported from
`@syrnike13/activity-sdk/protocol`.

## License

MIT
