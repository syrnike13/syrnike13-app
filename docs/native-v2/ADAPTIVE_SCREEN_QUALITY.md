# Fixed screen preset and live bitrate control (#139)

This contract supersedes the automatic resolution/FPS ladder from #124.
The selected preset is exact user intent. Only an explicit `setSelectedPreset`
operation can replace the encoder/source/publication generation. Automatic
control changes only the existing hardware encoder's bitrate. Product Voice UI
cutover remains #130; qualification #132 must use this contract.

## Presets and admission

| Selected preset | Dimensions | Target FPS | Minimum | Start | Maximum |
| --- | --- | --- | --- | --- | --- |
| 540p30 | 960 × 540 | 30 | 250 kbit/s | 375 kbit/s | 625 kbit/s |
| 720p30 | 1280 × 720 | 30 | 500 kbit/s | 1.2 Mbit/s | 2 Mbit/s |
| 720p60 | 1280 × 720 | 60 | 750 kbit/s | 2.4 Mbit/s | 4 Mbit/s |
| 1080p30 | 1920 × 1080 | 30 | 1 Mbit/s | 3.6 Mbit/s | 6 Mbit/s |
| 1080p60 | 1920 × 1080 | 60 | 2 Mbit/s | 4.8 Mbit/s | 8 Mbit/s |

These finite floors permit substantial compression while bounding the operating
range. They do not guarantee legible output or sustainable FPS on every scene.
The 1080p60 floor is 2 Mbit/s because repeated live 2/4 Mbit/s stages tracked
the declared tolerance on the tested MFT, while the preliminary 1.5 Mbit/s
floor did not.
Local pressure never changes the target cadence; only a network budget below
the floor lowers the admitted frame rate (see below).
Admission requires the exact preset's capability bit. No implicit fallback,
1440p, HDR, software encoder or extra layer is introduced.

## Deterministic policy

One existing sender worker evaluates immutable samples and owns decisions.
The pure policy allocates no resources and reads no clock. The selected preset
and last confirmed applied bitrate are separate inputs; requested bitrate is
never treated as confirmed.

The encoder target is the smaller of two ceilings, rounded down to 25 kbit/s
and clamped to the preset range:

- **Network:** the encoder follows WebRTC's sender budget for this track
  (`takeBitrateRequest`, already net of audio and capped at the declared
  maximum), the way an ordinary WebRTC encoder follows its target rate. It uses
  95% of the budget: a CBR stream overshoots around keyframes and upward steps,
  and the margin keeps that inside the pacer. WebRTC never estimates the link
  beyond the declared maxima (video plus audio): on an unconstrained loopback
  link the estimate stopped at 8.12 Mbit/s and the video budget at 7.94 Mbit/s.
  A budget of at least 97% of the video maximum is therefore capped rather than
  constrained, and the full preset is used. Before WebRTC's first
  budget, 85% of the uncapped link estimate stands in. A stale or missing network
  measurement never raises the bitrate.
- **Local resources:** a cap that only fresh local evidence moves.

| Fresh local measurement | Pressure | Recovery |
| --- | --- | --- |
| Encoder progress | Outputs below 70% of inputs, at least four inputs | At least 90%, at least four inputs |
| Publication GPU duration / target frame interval | At least 850 permille | Below 600 permille |
| Capture / conversion / publication age | Above 150 ms | All below 75 ms |
| Backpressure (conversion, encoder, stale and superseded drops) | At least 250 permille | Below 50 permille |

Captures dropped for a full pacer queue are not local backpressure: the sender
budget already reacts to that congestion, and a local cap would outlive it by
minutes (seen on the local stand after a collapse).

Three consecutive local pressure samples with the same reason lower the local
cap to 75% of the applied bitrate; emergency pressure (age at least 300 ms or
GPU at least 980 permille) needs two. A further cut needs fresh evidence.
Twenty continuous locally healthy seconds raise the cap by 25% (at least
25 kbit/s); reaching the preset maximum removes it.

### Below the preset floor

A preset floor bounds the encoder command, but WebRTC's budget can fall below
it. Holding the floor then kept sending more than the pacer was allowed: its
queue grew to seconds, the estimate never recovered (a loopback run stayed at
30 kbit/s for a minute) and capture admission fell to 0–25 fps. Below the floor
the stream therefore still fits the budget, and smooth motion goes last:

1. Per-frame quality falls first, at the full preset frame rate, down to half
   the floor (1 Mbit/s for 1080p60).
2. Below that the admitted frame rate falls in proportion to the budget,
   holding that per-frame quality, but never below 30 fps. A 30 fps preset
   never loses frames.
3. Only at 30 fps does per-frame quality fall further, down to a command of an
   eighth of the floor.

For 1080p60, a 0.8 Mbit/s budget gives 46 fps and a 0.5 Mbit/s budget 30 fps,
both at half the floor's bits per frame.

A frame rate takes effect only with its confirmed command; a rejected command
keeps both the old command and the old frame rate. Without live encoder control
the command is fixed, and admission alone follows the budget (never below the
minimum frame rate, restored in full when the budget allows). A paused share
sends nothing, so its budget (possibly zero) changes neither bitrate, frame
rate nor warning.

The hardware encoder budgets bits per configured frame: on the NVIDIA MFT,
30 admitted frames per second at a 60 fps configuration produced half the
commanded bitrate and 15 frames a quarter. The command is therefore the stream
budget × preset fps / admitted fps, and capture admission uses the admitted
interval while each frame keeps the preset's nominal duration. Captures that
arrive slower than the preset rate (a static screen, a 30 fps game in a 60 fps
preset) carry proportionally less bitrate for the same reason; that is outside
this policy.

Decreases apply at most every 500 ms and increases at most every second.
Changes below 5% of the applied bitrate are skipped unless they reach a preset
bound, so ordinary budget jitter makes no platform call. The NVIDIA MFT applied
57 of 57 updates at one and four per second within one frame (about 15 ms),
without extra keyframes, and its output tracked each target within the next
250 ms window (`hardware_bitrate_cadence_lab`).

The owner samples every 500 ms. Duplicate, reversed, or faster samples cannot
accumulate evidence. Valid measurement intervals are 250–1500 ms; a gap over
1500 ms resets hysteresis. Room stats have one outstanding request, at least
20 ms between requests, and a two-second bandwidth freshness limit measured from request
time. Sampling continues on the existing SDK owner lane even when no video
frames are submitted. Only the selected publisher ICE pair contributes available bandwidth.
A static source does not turn old last-value GPU/age data into fresh pressure.
New captured and converted input makes a zero encoder-output delta meaningful.

### Startup

The preencoded SDK starts WebRTC's estimate (`x-google-start-bitrate`) at 90%
of the declared maximum. An encoder opening at the full maximum exceeded that
budget at once: its first keyframe and CBR start ran 25–55% over target, packets
queued in the pacer, capture admission dropped frames, and the old policy cut
the bitrate within two seconds of every start. The encoder now opens at 60% of
the preset maximum, commanded before its first input so the opening keyframe
already fits, and then follows WebRTC's budget within seconds. An explicit
preset change starts its new generation the same way.

### Warning

A local cap or a network budget below the preset floor (reduced frame rate)
activates the warning.
Following a network budget above the floor is ordinary operation and does not.
Reaching the minimum continues output with bounded queues. Unsupported
capability remains unavailable and the warning stays active for that encoder; a
healthy network sample cannot restore capability.

## Encoder control and liveness

`HardwareH264Encoder::requestBitrate(revision, bps)` writes the existing owner's
control slot. At most one operation is active and one latest desired value is
coalesced. The encoder worker executes `ICodecAPI::SetValue` for
`CODECAPI_AVEncCommonMeanBitRate` with `VT_UI4`, without holding the shared
mutex across COM. Capture, UI, preview and stop admission do not call COM.

The typed result distinguishes pending, applied, unsupported, rejected and
unsafe. Exactly `S_OK` confirms application. `S_FALSE` is read-only;
`E_NOTIMPL` and `E_NOINTERFACE` are unsupported. Other ordinary failures are
rejected, retaining the last confirmed bitrate. Three consecutive rejected
calls exhaust the retry budget; a successful call restarts it, because the
encoder follows WebRTC's budget with frequent updates and scattered rejections
must not end live control for the rest of the share.
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

Once per second, `screen_bitrate_metrics` reports the applied and commanded
encoder bitrate, the network target, the local cap (0 when none), WebRTC's
sender budget, the pacer's packet send delay, the last update outcome and the
admitted capture frame rate.
`screen_video_metrics` keeps the decision reason and update count.

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

`hardware_bitrate_cadence_lab` is a manual hardware lab, not a ctest, and is
excluded from the default build (`cmake --build build --config Release --target
hardware_bitrate_cadence_lab`). It
encodes 1080p60 screen-like content on the real MFT, changes the bitrate once
and four times per second and ramps 2 → 8 Mbit/s, then reports actual output per
second against the target, apply latency, keyframes and stalls. `step` holds each
target for six seconds; the second argument sets the high-detail share of the
frame (`1/N`, default 1/10) and the third the input frame rate (default: the
preset's), with each frame keeping the preset's nominal duration. Content that cannot reach a low target at the
maximum QP leaves CBR in overshoot debt for several seconds afterwards, so run
it with content that fits the lowest tested target. It was run only on NVIDIA;
AMD and Intel MFTs still need it.
