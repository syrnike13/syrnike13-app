# Issue #139: qualification diagnostics

These reports include historical failures and controls, plus the accepted
published `.11` network, GPU and late/static scenarios below. Complete issue qualification remains
pending; this directory alone does not authorize closing #139.

The early implementation fixed preset ownership and added bounded live bitrate
control, but its restricted-link receiver violated the existing 150 ms p95 age
limit. Capture, independent preview pixels and coded audio continued. Automatic
encoder/publication replacement and threshold changes are not solutions allowed
by #139.

## Published SDK `.11`, 2026-09-07

[`published-sdk11-diagnostics.json.gz`](published-sdk11-diagnostics.json.gz)
retains complete measurement counters, histograms, receiver/audio references,
network samples and original file hashes. Duplicate raw process logs are
omitted; embedded errors keep their diagnostic first line.

The unmodified app commit `2e1d6e973756864ffcdc0216628b831f9e4661c1`, built
against published SDK `v1.10.0-syrnike.11`, passed the complete 1200-second
network/GPU schedule. Video: 52,758 frames, p95 106 ms, maximum 1307 ms,
maximum gap 2545 ms, 9620 sequence drops, zero invalid CRC markers and no
reconnects. Audio: all 1200 pulses matched, p95 136.062 ms. Five decreases and
twelve increases retained the same encoder, generation and two publication SIDs.
Publisher pool growth was zero; private memory growth was 9.84 MB.

Two subsequent unmodified `.11` focused GPU attempts failed at workload onset
with audio publication timeout. The older local candidate repeated that failure.
Changing GPU priority or isolating the competing device did not fix it; both
experiments were reverted. A diagnostic stack capture found the competing
converter waiting inside NVIDIA/D3D11 while MFT and capture threads waited for
D3D access. This identifies a blocked driver path, not a proven driver root cause.
The controller had not issued a bitrate update at the failure boundary.

A control using only seven fixed 4096x4096 encoders completed 180 seconds,
reached 2 Mbit/s with warning, recovered to 2.5 Mbit/s and preserved media
progress. Video p95/max were 62/103 ms, audio p95 79.002 ms. It remained
rejected because the unchanged oracle also required compute batches.
Final focused qualification uses those seven encoders alongside the original
16 MiB compute workload, removing the experimental 64 MiB random-read shader
and priority elevation. It additionally requires competing encoder output and
compute progress throughout every 10-second load window. Receiver thresholds,
minimum-warning requirement, 20–140-second load interval and publication
continuity requirements are unchanged.

The final bounded GPU run at clean app commit
`026ac59bde0960e793c86f58eab4e2aaab3082dd` passed: 7103 video frames,
p95/max age 61/151 ms, maximum gap 233 ms, zero invalid markers,
24,081 competing encoder outputs and 76,111 compute batches, with both
progressing in every load window. Four decreases and one increase retained
the encoder and publication identities. Audio p95 was 73.953 ms.
The same commit passed late/static qualification: original/late receiver p95
45/43 ms, late first decode 863 ms, audio p95 65.116 ms.

The final preview-stall run at that commit failed receiver freshness:
7534 frames, p95/max age 171/951 ms, maximum gap 840 ms, zero invalid
markers. Preview counters stopped during 20–160 seconds and resumed;
screen audio p95 was 118.459 ms and remote voice progressed throughout.
The identity, resource and bitrate checks passed. This is still a failed run.

A subsequent buffer experiment returned `S_OK` for setting and reading
16,666 bytes through `CODECAPI_AVEncCommonBufferSize`. Video p95 improved
to 137 ms, but audio failed at 193.272 ms. A separate identical-input
comparison (six three-second stages) showed that the small buffer impaired
bitrate response: later 2/4 Mbit/s requests produced about 6 Mbit/s, while
the default buffer responded to those requests. The experiment was removed;
the diagnostic is not acceptance evidence.

A raw-admission hysteresis experiment required 40 ms of fresh send-delay
measurements at or below 10 ms before clearing 30 ms queue pressure.
Unknown/stale observations still released admission after 250 ms. It worsened
receiver p95 to 208 ms (maximum 1213 ms, gap 1479 ms); audio passed at
117.200 ms. This experiment was also reverted.

## Keyframe pacing candidate

The SDK's zero-playout-delay factory can enable WebRTC's existing keyframe
queue flushing. A new keyframe supersedes pending video/RTX packets for its
stream, while an already-paced keyframe, audio and unrelated queues are kept.
Two otherwise unchanged preview-stall runs passed with video p95 132/133 ms,
maximum gaps 532/467 ms, zero invalid CRC markers and audio p95 118.712/137.713 ms.
Each retained the encoder, selected preset and publication identities through
two bitrate decreases and three increases. Complete reports are in
[`keyframe-pacing-candidates.json.gz`](keyframe-pacing-candidates.json.gz).
The late/static candidate also passed: original/late receiver p95 52/46 ms,
zero invalid CRC markers and audio p95 149.752 ms.
These used a local candidate FFI DLL and are not published-pin qualification.
The SDK change is tracked in [SDK PR #8](https://github.com/syrnike13/client-sdk-cpp/pull/8).

Everything below is historical, with SDK/app pins and pending statuses as they
were recorded at the time.

## Provenance and results

Measured on 2026-09-06: NVIDIA GeForce RTX 5070 Ti, driver 32.0.16.1074,
Windows 10.0.26200. App source was an uncommitted working tree based on
`cf84fafdb0be9b043bebda3201b39c9ac9237e2b`; these historical diagnostics do not
claim qualification of the final PR commit. Receiver: `@livekit/rtc-node`
0.13.34. The moving fixture is 1920x1080 at target 60 FPS.

| Report | SDK | Duration | Receiver p95 / max age | Maximum gap | Result |
| --- | --- | --- | --- | --- | --- |
| `issue139-cycle2.json` | published `.9` | 300 s | 1544 / 4043 ms | 6328 ms | Failed |
| `issue139-sdk-backpressure2.json` | local unpublished candidate | 180 s | 431 / 1328 ms | 1290 ms | Failed |
| `issue139-vbv.json` | same local candidate, buffer experiment | 180 s | 503 / 1216 ms | 1139 ms | Failed |

Published SDK `.9` is `v1.10.0-syrnike.9`, commit
`049ec1b977365dfe18e0a80342a39be33f020bb1`. The app pin remains unchanged.
The SDK experiment enabled libwebrtc rate-controller frame dropping for the
preencoded path (`has_trusted_rate_controller=false`); its eight existing
encoded/continuity tests passed. It improved the diagnostic result but did not
pass. It has no published pin and is not a dependency of this PR.

The exact SDK experiment is retained in `unpublished-sdk-experiment.patch`,
relative to the SDK commit above (apply with `git apply --unidiff-zero`).
Candidate DLL SHA-256 values:

- `livekit.dll`: `4a5b9ddc20e66a7bd3c1c5c3ec28e78b9b2f7b52c37720865da0ec505bc71017`
- `livekit_ffi.dll`: `d71132b56a78ab416381bdfb22e2e98fb7feb13b9dc9f4dbea8a87fdbc9aa673`

The buffer experiment attempted `CODECAPI_AVEncCommonBufferSize` at the startup
bitrate divided by FPS and eight. Support/application of this optional setting
was not established, and its measured result did not improve freshness. The
experiment was removed from app source. Microsoft defines this H.264 setting
in [bytes](https://learn.microsoft.com/en-us/windows/win32/codecapi/avenccommonbuffersize-property).

The 300-second baseline also reports a teardown 2x2 SDK frame and has an older
RTC counter reader; its below-minimum counter check cannot establish decoded
progress. Later diagnostics corrected both observer issues and still failed
freshness. The stored reports retain the failures and full intervals.

`hardware-live.txt` is a separate real-MFT probe: one encoder, six complete
20-second stages, 8/4/2/4/2/4 Mbit/s. Every 2/4 Mbit/s stage passed the declared
30% tolerance and repeated response checks. This proves live encoder control
on this hardware, not restricted-link transport acceptance. Intel/AMD and
other hardware remain unqualified.

## Work required before merge

### Subsequent diagnostics, 2026-09-06

The later working tree is based on app commit
`539109d806e2acb0f07d71da86eaded227d51a36`. It corrects ForceKeyFrame to
`VT_UI4`, retains requests until actual input admission, and explicitly clears
the property after accepted input and before a bitrate update. A five-frame
real-MFT I/P/I/P/I test also changes bitrate while the next keyframe request is
pending. The mixed keyframe/bitrate probe passed its full 20-second stages at
8/4/2/4/2/4 Mbit/s. These results do not qualify the lower 1.5 Mbit/s floor.

| Later diagnostic | Duration | Receiver p95 / max age | Maximum gap | Audio p95 | Result |
| --- | --- | --- | --- | --- | --- |
| `issue139-idle-gpu-control.json` | 180 s | 378 / 1162 ms | 1109 ms | 132 ms | Failed |
| `issue139-floor2-diagnostic.json` | 180 s | 474 / 1152 ms | 1751 ms | 132 ms | Failed |

The 2 Mbit/s floor experiment retained the same 1.25 Mbit/s restricted link and
150 ms receiver threshold. It did not fix freshness and was reverted. It kept
one encoder/source generation, decoded 7,692 frames, and independently matched
180 audio pulses; preview continued with 3,772 observed pixel changes. The
reports and receiver files remain in local `packages/native-media-lab/artifacts/`.

These later runs use the local SDK implementation proposed in
[SDK PR #6](https://github.com/syrnike13/client-sdk-cpp/pull/6), including sender
bitrate allocation feedback. The bundle was built from `6b979ce`; the subsequent
PR commit `1f5161fc54c684ff979f209d5fc066e72dd4481d` corrects protocol NEXT_ID
comments. This remains unpublished diagnostic provenance, not the app pin.
Its DLL hashes are `1358626e16ea25b18bfe66052083cdfc2fb47137746462c0b4cefd3f5fce6953`
(`livekit.dll`) and
`e2bc4383cd8996bd1b0403ba8cda20df0dc7e50896db6cbaf774af87b2f403b9`
(`livekit_ffi.dll`). Each harness report also records the actual executable hashes.

LowDelayVBR and PeakConstrainedVBR were tested separately and reverted: both
returned successful live control results but produced identical output across
repeated 1.5/3 Mbit/s requests in ten-second diagnostic windows (about 1.02 and
1.84 Mbit/s respectively). They are not qualified live-update alternatives.
The production candidate continues to use CBR. The 1.5 Mbit/s CBR scene also
failed its independent bitstream tolerance; a setter acknowledgement alone
does not establish the usable lower range on this hardware.

The completed 20-minute run is retained in
[`full-current-20min.summary.json`](full-current-20min.summary.json) and
[`full-current-20min.json.gz`](full-current-20min.json.gz). The compressed JSON
contains all 2,365 publisher samples, link samples, all receiver minute/RTC
counters, the complete age histogram and coded audio pulse measurements.
Duplicate process logs are omitted; source-report hashes and the decompressed
measurement hash preserve provenance. No captured media is included.

This run received 55,702 video frames with p95 age **359 ms**, maximum age
**2,676 ms**, and maximum gap **2,624 ms**: freshness failed. It retained one
encoder/source generation and stable publication identities through 27 updates
(9 down / 18 up), four network cycles and four compute-workload intervals.
Audio independently matched 1,201 pulses with p95 **139.3 ms**, passing.
Tracked queue/pool memory growth was zero, handles changed by -4 and threads
by -9. Process private memory grew by about 9.3 MB and plateaued; the report
retains that measurement rather than treating the tracked-pool counter as
total process memory. This is a failed diagnostic, not qualification.

A subsequent 8/4/2/4/2/4 Mbit/s probe with only the initial keyframe request
also passed every complete 20-second stage (4.004 / 2.372 / 3.894 / 2.114 /
3.882 Mbit/s after startup). An extra keyframe on every bitrate update is
therefore not required by this tested sequence. The optional probe argument
`--initial-keyframe-only` exercises that case. The hardware rejected the
separate `AVEncCommonAllowFrameDrops=1` startup experiment; it was reverted.

The intermediate CBR source passed all 31 native Release tests and all 38 lab
Vitest tests with the local SDK bundle. Those passes do not change the failed
receiver result or substitute for final checks against the published SDK pin.

The later `issue139-cleared-playout-zero-diagnostic.json` repeated the same
180-second network schedule with the test SFU's additional playout delay set
to zero. It still failed: p95 352 ms, maximum age 1582 ms, maximum gap 851 ms;
the receiver also logged H.264 decode errors during packet loss. Audio passed
at p95 98.7 ms. This experimental room setting is not a product configuration
change and is not used by the default harness.

### Packet admission and receiver experiments

Published `.10` SDK packet-queue experiments used the same default 180-second
network/GPU schedule and unchanged receiver thresholds:

| Report prefix | Sampling / raw admission | Receiver p95 / max | Maximum gap |
| --- | --- | --- | --- |
| `issue139-packet-gate-diagnostic` | 100 ms, pause at 30 ms packet delay | 258 / 1091 ms | 1291 ms |
| `issue139-fast-packet-gate-diagnostic` | 20 ms, unchanged counters clear observation | 387 / 1034 ms | 972 ms |
| `issue139-held-packet-gate-diagnostic` | 20 ms, unchanged counters retain original measurement time | 234 / 1085 ms | 1004 ms |

All failed freshness. The last run additionally exposed interleaved publisher
audio/video log lines; its independent receiver JSON survived, but the combined
report failed parsing and is not usable as complete evidence. Lab writers now
emit whole records through `std::osyncstream`. The raw gate expires at 250 ms;
no duplicate counter response renews that deadline. Pure counter-delta and
admission boundary tests pass. Encoder and publication identities remained
unchanged in the inspected measurements. A later GOP-size experiment must be
qualified separately; these numbers precede it.

`issue139-gop-packet-gate-diagnostic.json` set a five-second target GOP at
startup. Periodic keyframes fell from 127 to 34 in 180 seconds, but freshness
did not improve: p95 233 ms, max age 1562 ms, max gap 1057 ms; audio p95
125.2 ms. GOP tuning was reverted. The next experiment retains the hardware
default GOP and tests earlier raw backpressure admission.

Resolve transport/reference recovery under sustained bandwidth below the
selected preset floor without changing target FPS/resolution, restarting the
encoder, or growing queues. The buffer experiment still emitted approximately
2.5 Mbit/s while control acknowledged 1.5 Mbit/s during repeated keyframe
recovery; a successful property result alone is insufficient transport proof.

Then run the complete scenario matrix and the full 20-minute network/GPU lab,
including all transitions, on the exact app commit and a published SDK pin.
The present GPU workload ran but did not force policy pressure on this GPU;
it is not proof of the GPU-overload/minimum-warning scenario. Unsupported and
rejected outcomes have deterministic mailbox coverage, not a completed live
fault-injection matrix. Debug/ASan and final artifact checks must be recorded
separately; a failed short diagnostic must never be promoted to acceptance.

### Latest controlled comparison and remaining acceptance

The 5 ms raw-admission experiment failed at p95 249 ms and was reverted to
30 ms. Sender feedback now polls on the existing SDK lane even while raw
admission is paused. The 1080p60 floor is 2 Mbit/s following the real bitstream
probe; the network fixture remains 1.25 Mbit/s during its below-floor phase.

The SDK candidate in
[SDK PR #7](https://github.com/syrnike13/client-sdk-cpp/pull/7) restores the
passthrough encoder's trusted-rate-controller contract: rate pressure must
drop raw input before encoding, because dropping already encoded references
causes repeated keyframe recovery. The continuity guard and bitrate feedback
remain enabled. Windows build, all 367 SDK unit tests and targeted clang tools
passed; the candidate was not yet published for these diagnostics.

| 180-second report | SDK / SFU | Video p95 / maximum / gap | Audio p95 | Result |
| --- | --- | --- | --- | --- |
| `issue139-raw-only-playout-zero-diagnostic` | local candidate / explicit room zero delay | 121 / 1002 / 806 ms | 120.8 ms | Short pass only |
| `issue139-screen-playout-default-diagnostic` | local candidate / screen-only zero-delay default | 151 / 903 / 1565 ms | 112.1 ms | Failed |
| `issue139-sdk10-controlled-comparison` | published `.10` / same screen-only default | 219 / 1061 / 900 ms | 163.9 ms | Failed |

The last two runs use identical application executables and differ only in
`livekit_ffi.dll`; keyframe requests were 3 versus 7. Reports record executable
hashes, including the SFU. These are diagnostics from a dirty application
checkout, not final qualification. The SFU default is implemented in source and
covered by source/configuration and actual SDP-offer tests; it is not deployed.
All measurements from these three reports, including complete receiver
histograms and transition samples, are retained in
[`raw-admission-comparison.json.gz`](raw-admission-comparison.json.gz).
Duplicate process logs are omitted and source hashes are retained.

The full 20-minute run and final exact-pin Release/Debug/ASan/artifact checks
remain pending. Receiver thresholds are unchanged; 151 ms is not rounded into
a 150 ms pass.

### Focused hardware and preview scenarios

`issue139-encoder4096-contention-diagnostic` passed its complete 180-second
interval: video p95 **60 ms**, maximum **117 ms**, maximum gap **297 ms**, 6,669
decoded frames and no invalid markers; 180 audio pulses at p95 **108.9 ms**.
The link remained at 12 Mbit/s with zero packet loss. Seven additional hardware
encoders processed fixed 4096×4096 surfaces during seconds 20–140, alongside a
bounded memory-heavy GPU dispatch. The publisher's encoder/source generation
and publication remained unchanged as the policy reached 2 Mbit/s, kept output
and the warning under encoder pressure, then recovered to 2.5 Mbit/s and
cleared the warning. This is actual hardware work, not injected policy samples.
The extra surfaces are laboratory workload dimensions, not product presets.

The load has seven fixed encoder/converter owners, two input textures, and the
existing three-slot pools per converter/encoder. The separate GPU device owns
an 80 MiB texture set and at most one outstanding dispatch. Publisher tracked
queue/pool growth was zero; full-process private memory (including the competing
MFTs) plateaued around 1.64 GB and grew by about 13.8 MB over startup. The report
retains full process resources rather than calling publisher-owned counters
total memory. Lighter compute-only, memory-only and seven 4K encoder workloads
did not reach the minimum and were rejected by the scenario oracle.

The first preview-stall diagnostic paused the actual pixel consumer during
seconds 20–160 while the existing reference receiver played remote audio.
Preview counters stayed constant and resumed, and the OS played-sample counter
continued, but the screen-audio owner failed around second 169. The run also
failed video p95 at 191 ms. It is not accepted; the exact audio failure code is
now emitted once by the lab for the follow-up investigation.

`issue139-late-static-diagnostic` passed with two independent receivers. Pixels
were held static during seconds 30–70; the second viewer joined at second 40
and decoded the same publication after **849 ms**. Both observers measured
p95 **51 ms**, maximum **293 ms**; the original observer's maximum gap was
334 ms. The source generation stayed at one and keyframe requests increased
from three to four. Audio passed at p95 **80.9 ms**. Pixel observation confirms
the static interval and subsequent moving output.

These complete candidate/failed scenario measurements are retained in
[`scenario-diagnostics.json.gz`](scenario-diagnostics.json.gz), with original
source hashes and no captured media or duplicate process logs. They still use
the local SDK candidate and dirty app sources. Final published-pin runs must
repeat the required scenarios.

### Full candidate run and preview follow-ups

The subsequent 20-minute candidate run (`issue139-full20-candidate11`) used
the trusted preencoded SDK candidate, the screen-only SFU default and 30 ms raw
packet-queue admission. It decoded 53,216 frames: p95 age **95 ms**, maximum
age **1517 ms**, maximum gap **3042 ms**, and zero invalid pixel markers.
The run failed the unchanged 1500 ms maximum age limit. Its 17 applied updates
(5 down / 12 up), four below-minimum network cycles and four GPU intervals
retained one encoder/source generation and the same publications. Capture,
preview pixels and audio progressed throughout; all 1200 independently matched
audio pulses passed at p95 **125.3 ms**. Tracked pool growth was zero; handles
changed by -2, threads by -9, and process private memory grew about 10.2 MB.
Mean minute p95 decreased by 112.7 ms between the first and last three minutes.
These results show improvement, but do not qualify the candidate.

Two complete 180-second preview follow-ups did not reproduce the earlier audio
owner failure, but both failed receiver freshness. A five-second GOP produced
p95/max age **208/1714 ms**, with audio p95 **123.4 ms**. A 5 ms raw queue gate
produced **174/1654 ms**, with audio p95 **147.8 ms**, and did not exercise the
required repeated bitrate recovery. Both experiments were reverted. Neither
is evidence that the earlier intermittent audio failure has been fixed.

The intermediate 15 ms raw queue gate also failed and was reverted to 30 ms.
It measured only one bitrate recovery and p95 **341 ms** before a decoded
capture-clock anomaly ended video observation. Its publisher and audio ran the
complete 180 seconds; video observation was incomplete, so the report is not
acceptance. The observer now records the first clock anomaly and continues
collecting video while preserving the unconditional failed result; it also
records timestamp/sequence metadata for the oldest measured frame.

All four reports, receiver histograms, transition samples and source
hashes are retained in
[`full-candidate11-and-preview-diagnostics.json.gz`](full-candidate11-and-preview-diagnostics.json.gz).
They use unpublished SDK candidate source `6a97655469e6c6df1e31d43fc72ff38c32252629`
and are diagnostic evidence only. Duplicate process logs are omitted.

### Checked marker preview candidate

The marker now covers sequence, capture clock, generation and dimensions with
CRC-16/CCITT-FALSE. The old format only checked magic and could interpret a
corrupted payload as a valid timestamp. The native writer and TypeScript reader
share an independently computed golden vector; all 160 single-bit payload/CRC
corruptions are rejected. This detects corruption without repairing timestamps
or changing receiver freshness/invalid-marker thresholds.

With the original 30 ms raw gate and unchanged network/preview schedule,
`issue139-preview-crc-diagnostic` passed the complete 180-second interval:
7,359 frames, p95 **139 ms**, maximum **1362 ms**, maximum gap **882 ms**,
two bitrate reductions and three recoveries. All 180 audio pulses passed at
p95 **110.7 ms**; remote OS playback advanced while the actual preview consumer
was held for 140 seconds, then pixel observation resumed. Encoder/source and
publication identities stayed fixed. No damaged markers were detected, so
this run does not establish that corruption caused earlier latency failures.
The complete report is retained in
[`crc-preview-candidate.json.gz`](crc-preview-candidate.json.gz). It still uses
the local SDK candidate; final published-pin qualification remains pending.

## Earlier local validation of the proposed source

- Release lab build, generated protocol check and staged artifact verification: passed.
- Lab Vitest: 37 tests passed; TypeScript typecheck/build passed.
- Full native Release: 30/31 passed. `gpu-screen-converter` reported
  `screen_hardware_h264_stop_timeout` at 1280x720; its immediate isolated rerun
  passed. This intermittent cleanup failure is unresolved, not a clean full run.
- Focused Debug: adaptive policy and real hardware pipeline, 2/2 passed.
- Focused MSVC ASan Debug: adaptive policy, hardware pipeline and core lifecycle,
  3/3 passed, using the existing published `.9` SDK installation.

These checks cover the proposed source before commit. They do not qualify the
failed transport scenarios or establish the remaining live scenario matrix.
