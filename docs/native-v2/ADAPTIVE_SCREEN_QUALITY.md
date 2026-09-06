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
| 1080p60 | 1920 × 1080 | 60 | 2 Mbit/s | 8 Mbit/s |

These finite floors permit substantial compression while bounding the operating
range. They do not guarantee legible output or sustainable FPS on every scene.
The 1080p60 floor is 2 Mbit/s because repeated live 2/4 Mbit/s stages tracked
the declared tolerance on the tested MFT, while the preliminary 1.5 Mbit/s
floor did not. The lab still restricts the link to 1.25 Mbit/s below this floor.
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
20 ms between requests, and a two-second bandwidth freshness limit measured from request
time. Sampling continues on the existing SDK owner lane even when no video
frames are submitted. Only the selected publisher ICE pair contributes available bandwidth.
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

Keyframe requests use `CODECAPI_AVEncVideoForceKeyFrame` with `VT_UI4 = 1`.
The NVIDIA MFT returned success for the previous `VT_BOOL` value but ignored
the request. A real five-frame regression checks I/P/requested-I/P/requested-I;
restoring the old type makes the test fail.

Before changing bitrate, the same worker explicitly clears ForceKeyFrame with
`VT_UI4 = 0`, then applies MeanBitRate only if that clear returned exactly
`S_OK`. Both calls share the single control operation and its two-second
deadline. New keyframe intent is issued afterwards, before the next input.
The intent remains pending until an input is actually admitted. After that
`ProcessInput` succeeds, the worker also explicitly clears the consumed flag;
leaving it armed between input calls made mixed keyframe/bitrate requests
timing-dependent on the tested driver. The hardware probe requests a keyframe
at every bitrate-stage boundary to cover that interaction.
On the tested NVIDIA driver, omitting this clear after a valid keyframe request
made a requested 2 Mbit/s stage produce about 5.4 Mbit/s despite `S_OK`.
Restoring the clear brought repeated 2/4 Mbit/s stages back inside the declared
tolerance. No media type change, flush or resource replacement is involved.

Microsoft documents the encoder property and result semantics:
[H.264 encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder),
[ICodecAPI::SetValue](https://learn.microsoft.com/en-us/windows/win32/api/icodecapi/nf-icodecapi-icodecapi-setvalue).
[ForceKeyFrame parameter type](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avencvideoforcekeyframe)
documents the unsigned 32-bit value required by the keyframe control.

## Transport and continuity

The publication declares the selected preset's initial/maximum bitrate once.
Every live target remains at or below that declaration. The SFU validates the
unchanged maximum declaration; intermediate encoder targets do not create new
publications or expand allowed dimensions, FPS, layers or authorization.
The preencoded SDK sender continues to use its existing rate-control feedback
and RTP pacer. A real restricted-link observer is required to demonstrate that
changing MFT output does not leave a growing transport backlog.

Raw capture admission pauses while fresh outgoing video statistics show a
mean packet send delay of at least 30 ms. The delay is the difference in
`totalPacketSendDelay` divided by newly sent packets, for one unambiguous video
stream in the same Room. Counter resets, missing/multiple streams and
observations older than 250 ms permit admission again. Unchanged counters keep
the last observation's original timestamp; they cannot renew a pause. This
backpressure drops raw input before conversion/encoding; it leaves target FPS,
dimensions and encoded references unchanged. Preview receives the capture
before this check and continues using its own bounded pool. The short and full
receiver labs must still qualify this behavior.

Encoded output older than 150 ms is discarded before SDK admission. Losing an
encoded reference retains the existing dependent-frame suppression and
keyframe recovery. The requested/issued/acknowledged keyframe watermarks and
one-second cadence remain; three unsuccessful progress attempts are a distinct
recovery fault. Static input does not spend retries without new encoder input.
Preview is an independent consumer and never contributes pressure to policy.
Screen audio retains its own bounded owner and publication.

The SFU negotiates the RTP playout-delay extension on its sending transport.
Screen-video downtracks default to zero additional playout delay, while an
explicit enabled room/subscriber setting takes precedence. Camera, microphone
and screen-audio defaults are unchanged. This does not suppress receiver age,
gap, decode-error or drop measurements; every transition remains measured.
Focused SFU tests cover source selection, explicit configuration and the actual
subscriber SDP offer. This source change has not been deployed.

## Warning contract

The lab bridge exposes typed `qualityWarning`, target/applied bitrate and
bounded update counts. The renderer receives a boolean state and shows:

> Демонстрация может идти с задержками. Попробуйте снизить качество вручную

This is a deduplicated status, not repeated toasts. Stop explicitly clears it.
Technical outcome, reason, requested/applied bitrate and platform result remain
diagnostics, without frames, window titles or credentials. Product integration
of the same state belongs to #130.

## Hardware and evidence protocol

Exact SDK pin: `v1.10.0-syrnike.11`, commit
`59c074b2397d71ed45db7749af275cf291c2a36c`; the authoritative pin is
`packages/windows-media-engine/native/cmake/LiveKitSDK.cmake`.

| Hardware | Driver / OS | Status |
| --- | --- | --- |
| NVIDIA GeForce RTX 5070 Ti | 32.0.16.1074 / Windows 10.0.26200 | Repeated 2/4 Mbit/s live update verified; 1.5 Mbit/s bitstream tolerance and full-run receiver freshness failed |
| Intel / AMD / other NVIDIA | Not tested | Unqualified; do not infer support |

The bitrate lab accepts `MEDIA_LAB_BITRATE_SCENARIO`: `network` (default),
`gpu-pressure`, `preview-stall`, or `late-static`. Focused scenarios run exactly
180 seconds. The default network/GPU 20-minute schedule is unchanged.
GPU pressure keeps a 12 Mbit/s link and runs seven bounded competing 4096×4096
hardware encoders plus GPU memory traffic during seconds 20–140. Preview stall
stops the pixel consumer during seconds 20–160 and independently measures OS
playback of the existing remote-audio reference; capture, encoder and both audio
paths must keep progressing. Late/static freezes the fixture pixels during
seconds 30–70 and connects a second observer at second 40; it must decode the
same publication within 1500 ms, with complete age measurements retained for
both observers. The fixture continues repainting identical pixels while static;
zero-new-input policy behavior is covered separately by deterministic traces.

The standalone real-MFT probe uses a deterministic moving tiled 1080p60 scene
and one encoder: 8 → 4 → 2 → 4 → 2 → 4 Mbit/s, 20 seconds per stage. Each full
stage includes its transition. The initial 8 Mbit/s scene may underfill; every
subsequent 2/4 Mbit/s stage must be within ±30% of requested, and each repeated
down/up must change measured output by at least 40%. These tolerances are fixed
before the acceptance run. Property success and synthetic setters are not
substitutes for this proof.

The retained [20-minute diagnostic](issue139-diagnostics/README.md) failed
receiver freshness (p95 359 ms, maximum 2676 ms). Stable identities, continuing
preview/audio and passing local tests do not make that run accepted.

The end-to-end lab uses a disposable local SFU, a publisher-only UDP link with
a finite 64-packet / 40 ms queue, and a separate Node RTC decoder. Audio and
RTCP/STUN/DTLS have independent reservation. Direct publisher ICE candidates
are suppressed so video cannot bypass the shaper. Actual offered/delivered
bytes, drops and candidate rewriting must be nonzero as appropriate.

The 20-minute schedule repeats a 300-second cycle: 12 Mbit/s for 30 seconds,
3 Mbit/s for 30 seconds, 1.25 Mbit/s for 30 seconds (below the 2 Mbit/s
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
