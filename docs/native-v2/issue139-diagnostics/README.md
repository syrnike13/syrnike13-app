# Issue #139: blocked qualification

These are failed diagnostic runs, not acceptance. Do not merge or close #139
using these reports. No successful 20-minute qualification exists.

The implementation fixes preset ownership and adds bounded live bitrate control,
but the restricted-link receiver still violates the existing 150 ms p95 age
limit. Capture, independent preview pixels and coded audio continue. Automatic
encoder/publication replacement and threshold changes are not solutions allowed
by #139.

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

The complete scenario matrix, stronger actual GPU contention, full 20-minute
run and final Release/Debug/ASan/artifact checks remain pending. Receiver
thresholds are unchanged; 151 ms is not rounded into a 150 ms pass.

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
