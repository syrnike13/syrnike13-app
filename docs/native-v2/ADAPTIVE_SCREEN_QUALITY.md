# Fixed screen preset and live bitrate control (#139)

This contract supersedes the automatic resolution/FPS ladder from #124.
The selected preset is exact user intent. Only an explicit `setSelectedPreset`
operation can replace the encoder/source/publication generation. Automatic
control changes only the existing hardware encoder's bitrate. Product Voice UI
cutover remains #130; qualification #132 must use this contract.

Qualification is blocked by restricted-link receiver freshness; see the
[failed full-interval diagnostics](issue139-diagnostics/README.md). No accepted
20-minute run exists. Historical #124 results are
not acceptance for #139. In particular,
[adaptive-screen-quality-acceptance.json](adaptive-screen-quality-acceptance.json)
records the old profile-switch behavior and must not be used to claim seamless
bitrate adaptation.

## Presets and admission

| Selected preset | Dimensions | Target FPS | Minimum | Initial / maximum |
| --- | --- | --- | --- | --- |
| 540p30 | 960 × 540 | 30 | 250 kbit/s | 625 kbit/s |
| 720p30 | 1280 × 720 | 30 | 500 kbit/s | 2 Mbit/s |
| 720p60 | 1280 × 720 | 60 | 750 kbit/s | 4 Mbit/s |
| 1080p30 | 1920 × 1080 | 30 | 1 Mbit/s | 6 Mbit/s |
| 1080p60 | 1920 × 1080 | 60 | 1.5 Mbit/s | 8 Mbit/s |

These finite floors permit substantial compression while bounding the operating
range. They do not guarantee legible output or sustainable FPS on every scene.
Actual frame drops under pressure do not change the target cadence.
Admission requires the exact preset's capability bit. No implicit fallback,
1440p, HDR, software encoder or extra layer is introduced.

## Deterministic policy

One existing sender worker evaluates immutable samples and owns decisions.
The pure policy allocates no resources and reads no clock. History contains at
most six attempt timestamps. The selected preset and last confirmed applied
bitrate are separate inputs; requested bitrate is never treated as confirmed.

| Fresh measurement | Pressure | Recovery |
| --- | --- | --- |
| Network bandwidth | Below 90% of applied bitrate | At least 110% of next target |
| Encoder progress | Outputs below 70% of inputs, at least four inputs | At least 90%, at least four inputs |
| Publication GPU duration / target frame interval | At least 850 permille | Below 600 permille |
| Capture / conversion / publication age | Above 150 ms | All below 75 ms |
| Backpressure | At least 250 permille | Below 50 permille |

The owner samples every 500 ms. Duplicate, reversed, or faster samples cannot
accumulate evidence. Valid measurement intervals are 250–1500 ms; a gap over
1500 ms resets hysteresis. Room stats have one outstanding request, at least
500 ms between requests, and a two-second freshness limit measured from request
time. Only the selected publisher ICE pair contributes available bandwidth.
Missing/stale network or local measurements cannot authorize recovery. A static
source does not turn old last-value GPU/age data into fresh pressure. New
captured and converted input makes a zero encoder-output delta meaningful.

Three consecutive pressure samples with the same reason request a decrease.
Emergency pressure needs two samples: age at least 300 ms, GPU at least 980
permille, or bandwidth below half the applied bitrate. The next target is 75%
of applied, additionally bounded by 80% of available bandwidth for network
pressure, rounded down to 25 kbit/s and clamped to the preset range.

Normal update cooldown is five seconds; emergencies retain a hard one-second
minimum. At most six attempts occur in any rolling minute. Increases reserve
one attempt for emergencies. Recovery requires 20 continuous healthy seconds
and increases by 25% (at least 25 kbit/s), rounded down to 25 kbit/s, capped at
the preset maximum. Any pending operation or unknown measurement resets the
healthy interval. This is independent of the preset catalogue's bitrate ladder.

Sustained pressure activates a warning. Reaching the minimum continues output
with bounded queues and the same warning. Twenty healthy seconds clear a
resource warning. Unsupported capability remains unavailable and warning stays
active for that encoder; a healthy network sample cannot restore capability.

## Encoder control and liveness

`HardwareH264Encoder::requestBitrate(revision, bps)` writes the existing owner's
control slot. At most one operation is active and one latest desired value is
coalesced. The encoder worker executes `ICodecAPI::SetValue` for
`CODECAPI_AVEncCommonMeanBitRate` with `VT_UI4`, without holding the shared
mutex across COM. Capture, UI, preview and stop admission do not call COM.

The typed result distinguishes pending, applied, unsupported, rejected and
unsafe. Exactly `S_OK` confirms application. `S_FALSE` is read-only;
`E_NOTIMPL` and `E_NOINTERFACE` are unsupported. Other ordinary failures are
rejected, retaining the last confirmed bitrate. Three rejected calls total per
encoder exhaust the retry budget; successful calls do not refill it.
Unsupported disables further requests immediately. Requests and completion
after stop, or completion for another revision, cannot mutate current intent.
Explicit preset changes drain the old generation before allocating the new one.

An active operation has a two-second deadline. A late result or actual device
removal is unsafe and follows the existing terminal containment path. It is
not represented as ordinary overload. No flush, reinitialization, encoder
candidate switch, track replacement or Room reconnect is a live-update fallback.

The NVIDIA MFT returns `E_NOTIMPL` from `IsModifiable` despite accepting live
`SetValue`; property introspection alone is not a capability oracle.
A successful property call alone also does not prove bitstream reaction.
Startup configures CBR and low latency before committing the media types.

Microsoft documents the encoder property and result semantics:
[H.264 encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder),
[ICodecAPI::SetValue](https://learn.microsoft.com/en-us/windows/win32/api/icodecapi/nf-icodecapi-icodecapi-setvalue).

## Transport and continuity

The publication declares the selected preset's initial/maximum bitrate once.
Every live target remains at or below that declaration. The SFU validates the
unchanged maximum declaration; intermediate encoder targets do not create new
publications or expand allowed dimensions, FPS, layers or authorization.
The preencoded SDK sender continues to use its existing rate-control feedback
and RTP pacer. A real restricted-link observer is required to demonstrate that
changing MFT output does not leave a growing transport backlog.

Encoded output older than 150 ms is discarded before SDK admission. Losing an
encoded reference retains the existing dependent-frame suppression and
keyframe recovery. The requested/issued/acknowledged keyframe watermarks and
one-second cadence remain; three unsuccessful progress attempts are a distinct
recovery fault. Static input does not spend retries without new encoder input.
Preview is an independent consumer and never contributes pressure to policy.
Screen audio retains its own bounded owner and publication.

## Warning contract

The lab bridge exposes typed `qualityWarning`, target/applied bitrate and
bounded update counts. The renderer receives a boolean state and shows:

> Демонстрация может идти с задержками. Попробуйте снизить качество вручную

This is a deduplicated status, not repeated toasts. Stop explicitly clears it.
Technical outcome, reason, requested/applied bitrate and platform result remain
diagnostics, without frames, window titles or credentials. Product integration
of the same state belongs to #130.

## Hardware and evidence protocol

Exact SDK pin: `v1.10.0-syrnike.9`, commit
`049ec1b977365dfe18e0a80342a39be33f020bb1`; the authoritative pin is
`packages/windows-media-engine/native/cmake/LiveKitSDK.cmake`.

| Hardware | Driver / OS | Status |
| --- | --- | --- |
| NVIDIA GeForce RTX 5070 Ti | 32.0.16.1074 / Windows 10.0.26200 | Live update and end-to-end acceptance being measured |
| Intel / AMD / other NVIDIA | Not tested | Unqualified; do not infer support |

The standalone real-MFT probe uses a deterministic moving tiled 1080p60 scene
and one encoder: 8 → 4 → 2 → 4 → 2 → 4 Mbit/s, 20 seconds per stage. Each full
stage includes its transition. The initial 8 Mbit/s scene may underfill; every
subsequent 2/4 Mbit/s stage must be within ±30% of requested, and each repeated
down/up must change measured output by at least 40%. These tolerances are fixed
before the acceptance run. Property success and synthetic setters are not
substitutes for this proof.

The end-to-end lab uses a disposable local SFU, a publisher-only UDP link with
a finite 64-packet / 40 ms queue, and a separate Node RTC decoder. Audio and
RTCP/STUN/DTLS have independent reservation. Direct publisher ICE candidates
are suppressed so video cannot bypass the shaper. Actual offered/delivered
bytes, drops and candidate rewriting must be nonzero as appropriate.

The 20-minute schedule repeats a 300-second cycle: 12 Mbit/s for 30 seconds,
3 Mbit/s for 30 seconds, 1.25 Mbit/s for 30 seconds (below the 1.5 Mbit/s
floor), then 12 Mbit/s for 210 seconds. GPU contention runs at 150–160 seconds
of each cycle. Full-run decoded dimensions, track SID, generation, frame age,
gap, sequence drops and RTC receive counters are recorded, including updates.
No transitions are excluded as warmup. Receiver age limits remain p95 ≤150 ms,
maximum ≤1500 ms and growth ≤20 ms. Publication queue/memory and process
resource growth retain the existing acceptance limits. Independent preview
pixel readback and coded audio pulses prove progress separately from running
flags.

Run `live_bitrate_probe.exe 8000000 20` from the built Release lab.
Build the TypeScript harness with `pnpm --filter @syrnike13/native-media-lab build`.
Run `node packages/native-media-lab/dist/run-bitrate-lab.js` with
`MEDIA_LAB_SERVER_EXE`, `MEDIA_LAB_AUDIO_BIN`, `MEDIA_LAB_AUDIO_REPORT` and
`MEDIA_LAB_AUDIO_DURATION_MS=1200000`. Reports must include exact app commit,
hardware, SDK pin and checks; short diagnostics are not the 20-minute acceptance.
