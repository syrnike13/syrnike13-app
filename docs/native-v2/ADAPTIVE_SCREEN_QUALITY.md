# Fixed screen preset and live bitrate control (#139)

This contract supersedes the automatic resolution/FPS ladder from #124.
The selected preset is exact user intent. Only an explicit `setSelectedPreset`
operation can replace the encoder/source/publication generation. Automatic
control changes only the existing hardware encoder's bitrate. Product Voice UI
cutover remains #130; qualification #132 must use this contract.

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
floor did not.
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

The Engine exposes typed `qualityWarning`, target/applied bitrate and
bounded update counts. The renderer receives a boolean state and shows:

> Демонстрация может идти с задержками. Попробуйте снизить качество вручную

This is a deduplicated status, not repeated toasts. Stop explicitly clears it.
Technical outcome, reason, requested/applied bitrate and platform result remain
diagnostics, without frames, window titles or credentials. Product integration
of the same state belongs to #130.

## Audio recovery after scheduling stalls

The PCM queue still owns at most eight 10 ms packets, and the SDK source keeps
its fixed 10 ms clock and existing 100 ms capture-callback deadline. A queue
with more than one packet now catches up to its newest packet when its oldest
capture timestamp is over 30 ms old. The retained packet is marked discontinuous
and skipped packets remain counted in diagnostics. Ordinary batches up to
30 ms retain their original order. The 100 ms hard stale-packet limit remains.

The previous worker-gap check ran only after a successful SDK call and required
a pause over 100 ms. Shorter stalls could leave both producer and consumer
running at 10 ms per packet with a persistent queue delay. Timing diagnostics
observed PCM ages up to 75 ms before the SDK even after GPU load ended.
Capture-age-based catch-up handles time spent inside the SDK as well as worker
scheduling gaps. The regression test covers a 50 ms pause followed by equal-rate
production and consumption, plus normal batching and bounded storage.

Three preliminary post-change GPU runs passed, including two with four extra
CPU workers. Audio p95 was 74, 80 and 117 ms; no audio timeout occurred. One run
used diagnostic SDK timing instrumentation, which was subsequently removed.
The others used published `.12` DLLs. These comparisons identify retained PCM
latency; they do not independently establish the cause of the earlier isolated
100 ms timeout. Final committed-source audio p95 is 141.885 ms over 20 minutes,
89.835 ms under focused GPU pressure, 121.038 ms with stalled preview and remote
voice playback, and 98.045 ms in late/static. All complete without audio-owner
failure. Maximum individual audio ages are 261.986, 168.567, 144.465 and
146.882 ms respectively; p95 compliance is not a bound on every packet.

## Verification

`adaptive-screen-policy` replays the deterministic policy traces;
`adaptive-screen-pipeline` drives live bitrate updates through the real
hardware encoder. `bench/call-bench.mjs` measures a real monitor share end to
end (viewer FPS, gaps, backpressure drops).
