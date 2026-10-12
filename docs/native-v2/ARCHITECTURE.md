# Windows native media architecture

Windows desktop uses the native engine in `packages/windows-media-engine` as
its only RTC executor; there is no browser capture or browser RTC fallback. The
web client keeps `BrowserRtcEngineAdapter`.

```text
Renderer voice UI
  -> DesktopVoiceService -> VoiceDirector (membership, authority, recovery)
    -> NativeRtcEngineAdapterV2   one immutable desired-state snapshot + lease
      -> MediaRuntimeSupervisor   utility process lifetime, requests, host epochs
        -> media utility process -> windows_media.node -> Engine
```

`NativeRtcEngineAdapterV2` projects Voice Director intent into one complete
desired state (Room, microphone, output, camera, screen, remote video demand)
and retries a transiently failed apply. `MediaRuntimeSupervisor` restarts a
lost utility after 250 ms and 1 s; a host that stayed ready for 60 s gets that
budget back. A terminal Room or runtime loss is reported to Voice Director,
which reconnects with a fresh lease; a camera, microphone, output or screen
failure stays inside its media path.

## Engine

`Engine` (`core/engine.cpp`) is one-shot. One control thread commits lifecycle
transitions and desired-state snapshots; Room work runs on `RoomOwner` with an
independent deadline watchdog over `LiveKitRoomTransport`.

`LiveKitRoomTransport` has three lanes:

- operation lane: connect, disconnect and every publication task, in order;
- cancellation lane: cancels a running connect;
- teardown lane: the graceful SDK disconnect of a Room the Engine has already
  left. On a dead network that call blocks for over 30 s; leaving and the next
  join never wait for it.

A missed Room operation deadline (`room_operation_unresponsive`) or a Room
authority mismatch is fatal: the supervisor replaces the utility process
rather than reuse unknown SDK state.

`WindowsMediaRuntime` composes independent owners, each with its own thread and
a single latest-intent slot:

| Owner | Responsibility | Doc |
| --- | --- | --- |
| `MicrophoneOwner` | warm capture, DSP, publication | [MICROPHONE.md](MICROPHONE.md) |
| `RemoteAudioPlayout` | subscriptions, jitter, mix, render, echo reference | [REMOTE_AUDIO.md](REMOTE_AUDIO.md) |
| `ScreenOwner` | DXGI/WGC capture, GPU convert, hardware H.264, publication | [SCREEN_GPU_PRODUCTION.md](SCREEN_GPU_PRODUCTION.md) |
| `ScreenAudioOwner` | process / system loopback publication | [SCREEN_AUDIO.md](SCREEN_AUDIO.md) |
| `CameraOwner` | camera capture, preview, publication | [CAMERA.md](CAMERA.md) |
| `RemoteVideoOwner` + `FrameExportOwner` | remote decode, shared textures to Electron | [REMOTE_VIDEO_RECEIVE.md](REMOTE_VIDEO_RECEIVE.md) |

Protocol: [PROTOCOL.md](PROTOCOL.md). Ownership and lifetimes:
[RESOURCE_OWNERSHIP.md](RESOURCE_OWNERSHIP.md).

## Real-time audio rules

- Every real-time hop is an in-order bounded FIFO drained on each wake, never a
  latest-wins slot: a briefly descheduled consumer catches up instead of losing
  frames.
- Real-time threads use MMCSS when available; its absence never fails audio.
- Remote audio is clocked by the output device; the microphone by its capture
  device. The LiveKit microphone source is unbuffered so the SDK adds no clock.
- Echo cancellation runs across calls and device switches; renderer epochs are
  unique per process.

## Measurements

`bench/call-bench.mjs` drives the real addon through a product-like call with
synthetic `bench_bot` participants against a local dev LiveKit server: join,
voice (idle and with every core busy), switching output and input devices,
viewing a 1080p30 screen, sharing the monitor (with the picker open), sharing an
animated window over WGC, moving to another channel and leaving. Options:
`--signal-delay-ms N` adds signaling latency, `--dead-network-before-leave 1`
kills signaling before leaving.

```sh
go build -o livekit-server.exe ./services/livekit-server/cmd/server
pnpm --filter @syrnike13/windows-media-engine build
node packages/windows-media-engine/bench/call-bench.mjs --server livekit-server.exe --out report.json
```

The report also lists any fatal Engine failure, which in the product would
restart the media process.
