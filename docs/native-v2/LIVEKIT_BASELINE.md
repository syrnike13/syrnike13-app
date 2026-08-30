# Native v2 LiveKit baseline

## Pinned components

| Component | Pin | Integrity |
| --- | --- | --- |
| LiveKit C++ SDK | Project-owned standalone mirror [`syrnike13/client-sdk-cpp`](https://github.com/syrnike13/client-sdk-cpp), branch `native-v2`, commit `336d14e17d9432acce89e4c0d57078bbfbb23026` | Public release `native-v2-baseline-v1.10.0`; Windows x64 archive SHA-256 `6808b44e8ef8fdb31194ac084049f416eae144a34c51a6233f43a5106a54b6d2` |
| LiveKit Server | `v1.13.6` | Docker image `livekit/livekit-server@sha256:e37d68f172556d02aa77968b9fc55ef481468c0315fa38e4fa6c56ce72e3a815` |
| Neutral observer | `@livekit/rtc-node@0.13.34` | npm integrity is recorded in `pnpm-lock.yaml` |
| Token fixture | `livekit-server-sdk@2.18.0` | npm integrity is recorded in `pnpm-lock.yaml` |

The mirror baseline commit is identical to upstream `livekit/client-sdk-cpp` v1.10.0 commit `336d14e17d9432acce89e4c0d57078bbfbb23026`. Its baseline Windows archive is byte-identical to the upstream v1.10.0 asset. CMake downloads it from the project-owned public release without credentials and rejects it before extraction if its SHA-256 differs. No source checkout, functional mirror patch, or v1 media code is part of this baseline build.

## Build and runtime path

Run the complete local baseline from the repository root:

```powershell
pnpm native-media:lab
```

The command builds only the Windows x64 lab publisher, creates a temporary LiveKit configuration with random API credentials, starts the pinned server container, mints ten-minute publisher and observer tokens, runs both participants, writes `packages/native-media-lab/artifacts/latest-report.json`, and removes the container and temporary credentials on success or failure.

The C++ target uses C++20, the dynamic MSVC runtime, `/W4 /WX /permissive-`, Control Flow Guard, and the upstream prebuilt Release SDK. Video uses the public `VideoSource::captureFrame` path with BGRA software frames. Audio uses the public `AudioSource::captureFrame` path with 48 kHz mono PCM. Publishing and unpublishing use `LocalParticipant::publishTrack` and `LocalParticipant::unpublishTrack`.

The observer is a separate Node process and package. It imports only `@livekit/rtc-node`, decodes the sequence and capture time from received video luminance tiles, detects control pulses in received PCM, and exits non-zero when its thresholds are not met. It has no dependency on `windows-media-engine`, `media_core`, the Electron addon, or sender counters.

## Baseline acceptance

The default run requires at least 600 consecutive decoded video frames and 10 received audio control pulses within 55 seconds. The same command also covers republishing both tracks in one Room, a one-frame bounded slow-observer backlog, late observer join, disconnect before publication, publisher and observer termination, deterministic cancellation/generation fencing, and 50 complete publisher-process lifecycle cycles. The report records received and decoded frame counts, sequence gaps, out-of-order frames, video latency, observer drops/backlog, received audio samples, pulse count, discontinuities, subscription lifecycle counts, and residual lifecycle resources.

Set `MEDIA_LAB_OBSERVER_DELAY_MS` to make the observer deliberately slow. LiveKit's receive stream may drop decoded frames under pressure; acceptance is based on the decoded marker sequence and bounded capture-to-observer latency, so sender-side publication state cannot make the test pass.

The mirror baseline run on 2026-08-31 received and decoded 600 consecutive frames with zero gaps or reordering, 40 audio control pulses with zero discontinuities, and 37.23 ms average video latency. The slow observer deliberately dropped 76 old frames while keeping at most one pending frame and an 18 ms maximum measured latency. All 50 isolated lifecycle processes completed with zero residual publisher processes, threads, handles, or callbacks. The captured artifact is committed as `docs/native-v2/examples/media-lab-report.json`.

## Known limits

- The pinned C++ `Room::connect` API is synchronous, but it accepts a finite per-attempt `RoomOptions::connect_timeout`. `Room::disconnect` is also synchronous and has no public timeout parameter, so the lab adds a 75-second process deadline and forcibly removes the isolated test container during cleanup.
- On Windows, C++ SDK v1.10.0 can remain in global static teardown after `Room` destruction and a completed `livekit::shutdown()`. The isolated publisher calls `_Exit` only after both operations have returned and all owned media objects have been destroyed; the Node observer uses the SDK's public `dispose()` function.
- Repeated reconnects inside one SDK process retained roughly one additional Windows handle per cycle in this baseline. Native v2 therefore validates full lifecycle churn at the documented utility-process fault boundary: each publisher process connects, publishes, unpublishes, disconnects, shuts down the SDK, and exits before the next cycle. The OS then reclaims all process-owned handles and threads; the in-process `RoomOwner` separately proves 50 generation-fenced control cycles with no pending callbacks.
- The Node observer receives decoded I420 frames but does not expose C++ frame metadata. The publisher therefore places the sequence and epoch capture timestamp directly into a 96-bit high-contrast luminance marker that survives ordinary VP8/VP9 encoding.
- This baseline intentionally uses CPU-backed BGRA and PCM buffers. It does not initialize WGC, DXGI, WASAPI, Media Foundation, D3D11, a camera, a microphone, or a hardware encoder.
