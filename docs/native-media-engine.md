# Native Media Engine

Windows desktop media capture goes through the native media engine instead of
browser capture APIs. The web client still publishes through LiveKit JS, but the
media source and capture lifecycle are owned by the desktop native layer.

## API Boundary

Renderer code talks to the engine through `desktop.media` from
`@syrnike13/platform`.

```ts
const session = await desktop.media.startSession({
  kind: 'screen',
  sourceId,
  width,
  height,
  fps,
  bitrate,
  streamMode,
  audio: { requested: true },
})
```

`startSession` returns a `NativeMediaSession`. Screen sessions provide a video
stream port. Microphone sessions are audio-only.

```ts
type NativeMediaSession = {
  kind: 'screen'
  sessionId: string
  port: number
  streamMode: 'h264' | 'bgra'
  encoder: 'media_foundation' | 'software'
  audio?: {
    mode: 'none' | 'system_exclude' | 'process'
    port?: number
  }
}
```

```ts
const session = await desktop.media.startSession({
  kind: 'microphone',
  deviceId,
  sampleRate: 48_000,
  channels: 1,
  echoCancellation,
  noiseSuppression: 'deep_filter_net3',
  inputVolume,
})
```

```ts
type NativeMicrophoneSession = {
  kind: 'microphone'
  sessionId: string
  audio: {
    mode: 'microphone'
    port: number
    sampleRate: 48_000
    channels: 1
    noiseSuppression: 'disabled' | 'deep_filter_net3'
  }
}
```

`desktop.media.getState()` returns a snapshot with helper availability,
capabilities, active sessions, and the last engine error. It is the renderer's
source of truth for diagnostics and UI status.

## Lifecycle Ownership

The native helper owns session lifecycle. JavaScript can start, stop, reconnect,
and relay streams, but it must not invent public `running`, `error`, or
`stopped` state for a native session.

The helper emits `session_lifecycle` events:

```json
{
  "type": "session_lifecycle",
  "session_id": "session-1",
  "kind": "screen",
  "status": "running",
  "port": 55123
}
```

The Electron main process maps those events to `desktop.media` state events and
updates `getState()`.

## Audio Contract

System audio is part of the media session contract:

```ts
audio: { requested: true }
```

The renderer does not call separate prepare or clear audio methods. The engine
decides whether audio is unavailable, process-scoped, or system-exclude capture
and reports that through `session.audio`.

Session cleanup must release both video and audio resources.

## Microphone Contract

On Windows desktop, microphone capture is native-only. The renderer must not use
`navigator.mediaDevices.getUserMedia()` or LiveKit `setMicrophoneEnabled()` as
the capture path for local microphone publishing. It starts a native microphone
session, bridges the native PCM stream into a `MediaStreamTrack`, and publishes
that track with LiveKit JS.

Microphone PCM is mono `f32` at 48 kHz. Input gain is applied in the native
helper. The session carries `noiseSuppression: 'deep_filter_net3'` when enhanced
noise suppression is enabled. The DeepFilterNet3 inference runtime and model
packaging live in the Rust helper boundary; they are not a browser worklet.
When DeepFilterNet3 is active, the helper frames PCM packets using the model
runtime hop size, not a browser-side worklet block size.
When echo cancellation is enabled, the helper requests native Windows AEC through
WASAPI with the default render endpoint as the reference. If the selected capture
device or OS does not support native AEC, microphone startup fails instead of
silently falling back to browser echo cancellation.
The helper reports the microphone session as ready only after WASAPI capture,
optional AEC, and the native capture client are initialized successfully.
If the native microphone audio relay ends or errors after startup, Electron
reports the stream as ended/error and tears down the active native media session.

Microphone preview and gate-meter UI on Windows desktop also use the native
microphone session as their source. Browser `getUserMedia()` remains only for
web and non-Windows runtimes.

Windows desktop audio input device listing is native too:
`desktop.media.listDevices('audioinput')` returns WASAPI endpoint ids and labels.
Those endpoint ids are passed back into the Rust helper when starting a
microphone session. The web voice UI must not treat browser `enumerateDevices()`
ids as native microphone ids on Windows desktop.

RNNoise is not part of the voice stack. Enhanced microphone denoise maps to
DeepFilterNet3 at the native media engine boundary.

## LiveKit Boundary

LiveKit JS remains the publishing layer. It should receive already captured
native media data and publish it to the room. Capture quality decisions,
source selection, system audio routing, native ports, and helper lifecycle stay
outside LiveKit JS.
