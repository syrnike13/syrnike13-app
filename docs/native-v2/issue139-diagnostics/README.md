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

## Local validation of the proposed source

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
