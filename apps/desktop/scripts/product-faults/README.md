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

For incoming-output qualification, supply `outputProbe` as the absolute path to
the matching native build's `audio_capture_lab.exe`. The independent browser
must send a known continuous tone through its microphone publication, with its
voice gate and noise suppression disabled. The probe captures only the supplied
desktop main process's tree. Both before injection and after recovery, at least
20 of its 500 ms sample's packets must contain actual output above RMS 100.
Its capture clients and threads must drain before it exits. Hash this executable
with the other fixture binaries. This adds incoming PCM evidence to each primary
utility row; it does not prove microphone mute privacy or continuous audio gaps.
Install `installToneMicrophone` from `tone-microphone.cjs` with the observer
page's `addInitScript` before loading it. This fixture supplies a 997 Hz tone
without capturing a physical microphone or playing it locally. Stopping each
generated track retires its AudioContext. Its four-context cap rejects a broken
fixture instead of allowing unbounded generator allocation.

## Combined continuity series

`run-combined-series.cjs` runs up to 100 cycles of an incoming audio gap,
withheld renderer releases and external GPU load. It stops on the first failure.
Prepare the same desktop and browser participants with microphone, camera,
screen, screen audio and incoming output active. Keep the desktop screen stage
and incoming camera visible. Install `installRendererReleaseProbe` in the
desktop page. Its two `VideoFrame` clones retain actual GPU resources until
the harness releases them; overflow fails the cycle.

Build the opt-in native lab targets and supply absolute `audioProbe` and
`gpuProbe` paths for `audio_capture_lab.exe` and `gpu_contention_lab.exe`.
The GPU fixture uses one 16 MiB allocation and at most one outstanding dispatch.
The audio fixture captures only the desktop process tree and emits 100 ms
aggregate windows, never raw PCM. The browser tone control creates a measured
gap without replacing its publication. The cycle requires recovery within
1,500 ms and conservatively includes both adjacent windows in its silence bound.

Use a third local test account for `packages/native-media-lab/scripts/product-neutral-observer.mjs`.
Start it with `startProbe` from `probe-process.cjs`, the prefix
`PRODUCT_OBSERVER_RESULT`, and the environment variables `VOICE_GATEWAY_URL`,
`VOICE_SESSION_TOKEN`, `VOICE_CHANNEL_ID` and `LIVEKIT_OBSERVER_PUBLISHER`.
It joins through the ordinary backend Voice Authority flow and receives the
native participant's four publications through a separate Node SDK process.
Do not substitute an administrative SFU token. Wait for its `ready` event and
fresh frames before starting. Pass its user ID as `neutralUserId` to
`createHarness`. The observer's publication identities, frame progress and
maximum gaps must remain valid throughout each cycle.

Call `run({ directory, count: 100, app, ui, receiver, harness, observer,
audioProbe, gpuProbe, diagnosticDirectory })`. The report directory must be new;
`diagnosticDirectory` must be the active desktop main journal's directory.
Detection of withheld releases must take at most 3,000 ms, and presentation
must resume within 3,000 ms of release. Journal samples must show retained
leases within the existing 68-lease bound. Authority, participants, publications
and utility identity must remain unchanged. Each cycle confirms both temporary
native probes exit; finish the series with observer `stop`, then `finished()`.
Use `stop()` in failure cleanup to confirm its owned process exits as well.

These reports qualify their declared combined continuity and sampled texture
bound only. Process samples do not establish zero resource growth, and the
injected incoming gap does not test local microphone mute privacy. Preserve
exact binary and script hashes before and after the series, including the
separate observer SDK and external probes, and audit reports before publishing.

## Microphone privacy during utility recovery

For utility recovery, start the same neutral receiver with
`LIVEKIT_OBSERVER_USER_ID` instead of `LIVEKIT_OBSERVER_PUBLISHER`. This mode
follows that test user's replacement publications and removes retired records;
the existing eight-reader/task limits still apply. Strict publisher mode keeps
retired records and continues to reject replacements in continuity tests.

Supply this process as `microphoneObserver` and its account as `neutralUserId`
to the utility harness. Keep a real nonzero microphone baseline; a silent input
cannot qualify mute privacy. The receiver stores only 32 aggregate 100 ms windows
per publication and the maximum per-frame RMS since that publication began.
Before injection, at least four recent populated windows must be available, with
RMS at least 30 in one. After latest mute intent is replayed, a distinct microphone
publication must provide four recent windows and its maximum RMS over every
received frame must be at most 2. Missing PCM, stale windows, duplicate microphones
or receiver failures fail the row. This checks the complete received lifetime of
the muted replacement, including frames preceding the post-recovery snapshot.

The utility report preserves both aggregate observations and the series counts
successful privacy cycles. Hash the receiver and harness with the application
inputs; preserve failed reports. This adds microphone privacy evidence only and
does not qualify unaffected-track continuity during a Room replacement.
Start a fresh Node runner after changing fixture scripts: a long-lived runner's
module cache can otherwise execute an earlier driver despite newer file hashes.
