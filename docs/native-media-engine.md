# Native Media Engine

Windows desktop media capture goes through the native media engine instead of
browser capture APIs. The renderer controls sessions through `desktop.media`
from `@syrnike13/platform`; the native helper owns capture, processing, and
LiveKit publishing for Windows-only native sessions. The helper is an isolated
Electron utility process loading `syrnike_media.node`; there is no application
runtime EXE.

## API Boundary

Screen sessions request a source, dimensions, bitrate, and optional system
audio:

```ts
const session = await desktop.media.startSession({
  kind: 'screen',
  sourceId,
  width,
  height,
  fps,
  bitrate,
  audio: { requested: true },
  livekit,
})
```

Microphone device and processing settings belong to the persistent microphone
pipeline, not to a preview or publish session:

```ts
await desktop.media.configureMicrophonePipeline({
  deviceId: deviceId ?? null, // null follows the Windows default device
  noiseSuppression: true,
  echoCancellation: true,
  inputVolume,
  voiceGateEnabled,
  voiceGateThresholdDb,
  voiceGateAutoThreshold,
})
```

A LiveKit publish session then supplies only publication intent:

```ts
const session = await desktop.media.startSession({
  kind: 'microphone',
  requestId,
  audioBitrate,
  muted,
  livekit,
})
```

`desktop.media.getState()` returns helper availability, capabilities, active
sessions, and the last engine error. It is the renderer's source of truth for
diagnostics and UI status.

## Microphone Processing

The Windows C++ helper uses LiveKit SDK's WebRTC Audio Processing Module for
standard microphone cleanup:

- `noiseSuppression`: WebRTC software noise suppression.
- `echoCancellation`: WebRTC AEC3 when a WASAPI default-render loopback
  reference is available.
- `autoGainControl`: not exposed and not enabled.

The native signal order is:

```text
10 ms microphone frame
-> WebRTC APM noise suppression / AEC when enabled and available
-> input volume
-> voice gate
-> soft limiter
-> LiveKit native audio frame
```

Noise suppression and echo cancellation are separate pipeline booleans. The
renderer updates the complete desired configuration with
`desktop.media.configureMicrophonePipeline()` without reconnecting the LiveKit
publish session. DSP-only changes apply to subsequent frames; a device change
restarts the single capture path and rolls back to the previous working device
if the replacement cannot be opened.

Echo cancellation is best-effort. If the render loopback reference cannot be
opened or has not produced 10 ms reference frames yet, the microphone continues
publishing and reports `echoCancellation: 'unavailable'`. Noise suppression can
still run without echo reference.

Microphone preview is a render consumer of that same pipeline. It does not own
configuration, expose a renderer session ID, or open a second microphone
capture path. Preview and LiveKit publish may consume the processed PCM stream
at the same time.

## Status Values

Microphone session audio status exposes both processing features:

```ts
audio: {
  mode: 'microphone'
  sampleRate: 48_000
  channels: 1
  noiseSuppression: 'disabled' | 'software' | 'unavailable'
  echoCancellation: 'disabled' | 'software' | 'unavailable'
}
```

Pipeline meter events contain only `inputDb`, `thresholdDb`, and `open`; they
are not tagged with preview or publish session identity.

## Browser Boundary

On Windows desktop, local microphone publishing uses the native C++ helper.
Browser `getUserMedia()` remains only for web and non-Windows runtimes.

Browser-side noise suppression and AGC are kept disabled in voice capture
constraints to avoid double processing:

```ts
{
  noiseSuppression: false,
  autoGainControl: false
}
```

## Out Of Scope

Krisp, RNNoise, DeepFilterNet3, and AGC are not part of this native microphone
processing path. The intended quality target is the WebRTC/APM "standard"
class of processing, not Krisp-style ML cancellation.
