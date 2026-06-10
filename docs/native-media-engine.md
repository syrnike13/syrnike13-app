# Native Media Engine

Windows desktop media capture goes through the native media engine instead of
browser capture APIs. The renderer controls sessions through `desktop.media`
from `@syrnike13/platform`; the native helper owns capture, processing, and
LiveKit publishing for Windows-only native sessions.

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

Microphone sessions request two independent processing toggles:

```ts
const session = await desktop.media.startSession({
  kind: 'microphone',
  deviceId,
  sampleRate: 48_000,
  channels: 1,
  noiseSuppression: true,
  echoCancellation: true,
  inputVolume,
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

Noise suppression and echo cancellation are separate runtime booleans. The
renderer can update them with `desktop.media.configureMicrophoneRuntime()`
without restarting the microphone session.

Echo cancellation is best-effort. If the render loopback reference cannot be
opened or has not produced 10 ms reference frames yet, the microphone continues
publishing and reports `echoCancellation: 'unavailable'`. Noise suppression can
still run without echo reference.

Microphone preview uses the same processor for noise suppression, input volume,
voice gate, and limiter. Preview reports echo cancellation as unavailable when
the checkbox is on because monitor audio is rendered to the same output device
that a loopback AEC reference would capture.

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

The helper also includes `noise_suppression` and `echo_cancellation` in
microphone diagnostics events so manual QA can verify enabled, disabled, and
unavailable states.

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
