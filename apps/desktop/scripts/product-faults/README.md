# Full-product utility fault harness

These scripts operate the real desktop Voice Director, media utility, backend
and SFU. Run only against an isolated local test backend and SFU. They kill the
media utility belonging to the supplied Electron application and change that
test user's microphone, camera and screen-sharing intent.

Use the production web build for long runs (`pnpm --filter @syrnike13/web build
--mode localbackend`). A Vite development frontend accumulates React performance
tracks and is unsuitable for resource qualification; see `know-bugs.md`.
Serve `apps/web/dist/client` with the existing SPA server and point the desktop
build's `SYRNIKE_WEB_DEV_URL` at that local server. The desktop build also needs
`SYRNIKE_DESKTOP_BACKEND_MODE=local` and the local native metrics endpoint.

Prepare two authenticated test users in one voice channel. Launch the desktop
with Playwright's Electron launcher using an isolated user-data directory and
open its voice stage. Launch an independent browser participant with a fake
camera and muted microphone; keep its local and incoming video elements visible.
The native participant needs a real camera and a selectable screen with screen
audio. Preserve the same fixture and build throughout the run. Do not rebuild,
reload the frontend, or replace the observer during the series.

The following CommonJS example uses existing Playwright objects `app`, `ui`
(the desktop page), `receiver` (the browser page), and a LiveKit server SDK
`admin` client for the local SFU. Supply the exact test fixture identifiers in
memory; never place its credentials in reports or committed files.

```js
const { installVideoDrawProbe } = require('./video-draw-probe.cjs')
const { createHarness } = require('./utility-harness.cjs')
const { run } = require('./run-utility-series.cjs')

await ui.evaluate(installVideoDrawProbe)
const harness = createHarness({
  app, ui, receiver, admin,
  roomName, channelId, nativeUserId, observerUserId,
})
const summary = await run({
  ui, harness,
  directory: absoluteNewReportDirectory,
  screenSourceButton: exactScreenSelectionButtonLabel,
  count: 100,
})
```

Start with a fresh runtime (`restartCount === 0`). Between pairs of automatic
recoveries, the runner kills the exhausted host, verifies that it stays terminal,
and clicks explicit Retry. Lifetime restart count is not the per-Retry budget.
The selected screen requires explicit reselection when its opaque handle expires.

The draw probe wraps successful canvas draws and weakly associates native frame
metadata with each frame. It does not retain or close frames, alter pixels, clear
performance entries, or change application media state. Its counters reset on
host replacement and reject capacity overflow. Install it before joining the
channel. It measures incoming presentation without importing Vite source modules.

Before injecting a fault, the harness waits up to 15 seconds for the complete
fixture, including fresh incoming draws. `Running` alone does not establish
presentation readiness after screen selection. This preparation happens before
the fault deadline begins. Multiple canvases drawing the same frame count once.

Each primary cycle requires exactly one replacement, latest pending mute intent,
fresh Voice Authority matching the SFU, no observed duplicate participant, an
unchanged observer, and resumed incoming and outgoing camera frames. OS samples
record main/media/renderer/GPU handles, threads and memory. Failures stop the
series and preserve all preceding reports. Output directories must not exist.

`summary.passed` applies only to the declared utility replay/authority/camera
scope. It does not qualify resource growth, incoming PCM output or mute privacy,
the complete fault matrix, another build configuration, or hardware/soak gates.
Before accepting evidence, record exact commits and hash the application,
frontend, backend, SDK and these scripts both before and after execution. Audit
the output against fixture credentials and identifiers before publishing it.
