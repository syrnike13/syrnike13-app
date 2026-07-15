# Native Media Engine

Windows desktop microphone and screen publication use the native media runtime.
The renderer describes desired publication state through `desktop.media`; it
does not run a native session procedure. Electron main reconciles that desired
state, and an isolated Electron utility process loads `syrnike_media.node`.
There is no custom application runtime EXE or EXE fallback.

## Ownership

```text
VoiceIntentDirector
  -> LocalMediaIntent
  -> preload / structured-clone IPC
  -> NativeMediaReconciler
  -> NativeMediaController execution adapter
  -> NativeRuntimeSupervisor
  -> media utility process
  -> syrnike_media.node / MediaRuntime
```

- `VoiceIntentDirector` is the only module allowed to create or supersede a
  voice `operationId`. Credentials and local media desire are leases of that
  operation.
- `NativeMediaReconciler` atomically owns the latest immutable intent plus
  independent microphone and screen desired/current/retry state.
- `NativeMediaController` is an execution adapter below that seam. It may use
  internal session IDs to address native work, but it does not own desired
  publication state or mutable crash-recovery snapshots.
- `NativeRuntimeSupervisor` owns utility-host lifecycle, handshake, request
  correlation, actor liveness probes, restart backoff and the crash circuit.
- `MediaRuntime` owns the persistent microphone pipeline, capture actors,
  preview consumer and LiveKit runtime lease.

## Declarative Renderer Interface

The publication interface accepts one complete `LocalMediaIntent`:

```ts
await desktop.media.applyLocalMediaIntent({
  operationId,
  envelopeRevision,
  microphone: {
    revision: microphoneRevision,
    state: 'publish',
    credentials: nativeMicrophoneCredentials,
    muted,
    audioBitrateKbps: 64,
  },
  screen: {
    revision: screenRevision,
    state: 'off',
  },
})
```

The promise acknowledges validation and in-memory acceptance by Electron. It
does not wait for room connection or track publication. Progress arrives
through `desktop.media.onLocalMediaState()` as sequenced observed events.

Identifier scopes are deliberately different:

- `operationId` is Director/backend voice ownership;
- `envelopeRevision` fences atomic acceptance of the whole media envelope;
- microphone/screen `revision` independently fences desired state and observed
  events for that kind;
- `nativeGeneration` is an Electron/C++ attempt detail and is never renderer
  publication choreography;
- transport `requestId` correlates request/reply only.

Renderer code never creates, stores or sends a native publication `sessionId`.
It ignores observed events for another operation or older kind revision. Native
generation may be present for diagnostics, but must not decide voice intent or
UI ownership.

### Microphone states

Microphone desire is one of:

- `off` — no publication is desired;
- `retain` — preserve a real, already committed publication while replacement
  credentials are pending, and apply the latest mute value;
- `publish` — reconcile a publication for the supplied operation-scoped
  credentials.

`retain` cannot create or promote a publication. If the reconciler has no
successfully committed microphone publication, it resolves to off/no-op. An
in-flight candidate, failed start or merely remembered session ID is not
retained state.

### Screen states

Screen desire is `off | prepare | publish`. Both active states contain the
complete source specification (source, dimensions, FPS, video/audio bitrate and
whether system audio is requested) and operation-scoped credentials. Prepare
keeps its preconnected resources only while that exact revision remains
desired.

## Microphone Pipeline

Device and processing configuration belong to the persistent microphone
pipeline, not to publication intent:

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

The pipeline owns one WASAPI capture path, DSP state, warm state and microphone
level meter. Preview and LiveKit publication are consumers and may coexist; they
must not open parallel capture paths.

The native signal order is:

```text
10 ms microphone frame
-> WebRTC APM noise suppression / AEC when enabled and available
-> input volume
-> voice gate
-> WebRTC adaptive digital gain control when enabled
-> closed-gate digital-silence guard
-> soft limiter
-> LiveKit native audio frame
```

Noise suppression and echo cancellation are independent. DSP-only changes
apply to subsequent frames. A device change restarts the single capture path
and rolls back to the previous working device if the replacement cannot be
opened.

Echo cancellation is best-effort. If the WASAPI render-loopback reference is
unavailable or has not produced 10 ms frames, publication continues and reports
`echoCancellation: 'unavailable'`; noise suppression can still run.

Microphone preview is an identity-free render consumer of the same pipeline. It
does not own configuration, expose a publication session ID or open a second
capture path. Meter events contain only `inputDb`, `thresholdDb` and `open`.

## Backend and LiveKit Identity

Native publishers are separate LiveKit participants whose stable identity for
one voice operation is:

```text
<user_id>:desktop-native:<operation_id>:<kind>
```

Credential refresh renews the same operation and identity. A new operation is
created only by the Director. Backend credentials are issued after an exact,
idempotent prepared terminal lease is acquired; downstream setup failure does
not silently restore older authority. `voice_current` changes only when voice
ingress finalizes the exact signed browser operation. Screen/camera track flags
observed while the browser join is pending live on that reservation and transfer
to the finalized session; exact-record CAS prevents stale track events from
overwriting newer state.

Fast A→B→A return does not retag A as A2. The client sends
`retain_finalized(A, expected B)`: the backend consumes prepared B, preserves
the signed A transport/session unchanged, and records a receipt for the exact
pair. If B has already finalized or another authority won, the typed conflict
causes a fresh Director join to A.

## Failure, Retry and Recovery

Detailed Electron/utility/native diagnostics are disabled by default in every
build and enabled only with `SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS=1`. They redact
tokens, URLs, identities, device/source/window data and paths, and remove local
run directories older than seven days.

A query timeout rejects that request and may use the relevant actor-specific
liveness probe; it is not by itself evidence that the utility host died. A
mutating publication timeout has an uncertain commit outcome, so the supervisor
recycles that media host rather than risk a ghost publication. Process/transport
failure, native fatal error or a failed actor probe also recycle the host.
Microphone and screen probes are independent, so a healthy query lane cannot
mask a wedged publication actor.

Publication capacity is bounded. While an older candidate/retirement still
occupies its allowed slot but remains within the outer deadline, a newer command
fails fast as retryable `actor_busy`; the reconciler may retry the same current
revision with backoff. Once the slot exceeds its deadline, the actor returns
`actor_unresponsive` and the supervisor recycles the host. Neither path creates
a voice operation or an unbounded native worker.

After a confirmed host restart, `NativeMediaReconciler` reapplies only the
latest accepted immutable intent and current per-kind revisions. Its retry
policy cannot create a voice operation or restore an older revision. Pipeline
configuration and preview desire are separate replay domains.

## Native Concurrency Gate

Microphone and screen LiveKit publication attempts now run in bounded workers
outside their actor control loops. Generation fencing prevents late stale
results from promotion, while mute, stop, terminal callbacks and probes remain
processable. A controller owns only its committed publication, one candidate
and bounded retirement capacity.

The LiveKit SDK calls themselves are still synchronous and cannot be
cooperatively interrupted. Cancellation marks an attempt stale but cannot force
the blocked SDK stack to unwind. If it exceeds the outer deadline, containment
is `actor_unresponsive` followed by forced utility-host termination and
supervisor restart. This bounds application damage, but graceful in-process SDK
cancellation and teardown remain an explicit limitation to qualify in fault and
soak testing.

## Browser Boundary

On Windows desktop, local microphone publishing uses the native runtime.
Browser `getUserMedia()` remains for web and non-Windows runtimes. Browser-side
noise suppression and AGC stay disabled in the shared capture constraints to
avoid double processing.

## Out of Scope

Krisp, RNNoise, DeepFilterNet3, new ML denoise, HDR, hardware encoding and
new capture capabilities are not part of this migration. The microphone target
is the WebRTC/APM standard processing class.
