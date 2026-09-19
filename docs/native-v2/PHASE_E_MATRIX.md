# Phase E qualification matrix

This is the status of Phase E on 2026-09-19. It covers issue #130 (product
cutover) and issue #131 (bounded recovery). Issue #132 is deliberately outside
this matrix.

`PASS` means the cited run met the assertions for its own scope. A historical
PASS is still marked as historical when its application commit is different from
the current branch head. `FAIL` means an executed assertion failed. `BLOCKED`
means setup or an external service prevented fault injection. `NOT RUN` means
there is no qualifying execution for that row. A PASS in this document does not
turn the whole phase green while another required row is failed or missing.

## #131 recovery matrix

The native owner runner contains 42 required fault records and runs each record
for 100 measured iterations. The historical `445cff8a` Release and Debug archives each
contain all 42 records at 100/100 owner checks with no missing rows. Release has
three encoder resource failures; Debug has two. The ASan archive records the same
strict resource issue plus any sanitizer-specific output resource observations;
all positive deltas remain raw failures.

| Fault scope | Result | Evidence and limitation |
| --- | --- | --- |
| WGC source closes | PASS* | Release and Debug native rows: 100/100, zero positive resource delta. *Historical native build; product shutdown during the held call is separate. |
| WGC frame callback after stop | PASS* | Release and Debug native rows: 100/100 generation/late-frame checks. *Historical native build. |
| DXGI access lost or device removed | PASS* | Both native results: 100/100 per result, balanced leases and owner checks. *Historical native build. |
| Encoder accepts input but makes no output | **FAIL** | The exact-head Release and Debug rows reached 100/100 owner checks but retained +1 handle; the strict assessor correctly keeps them failed. Production-equivalent configured-MFT controls are zero-growth, while platform-stage and historical controls show machine/driver-dependent NVIDIA Media Foundation retention; no source workaround is justified without application-owned evidence. |
| Publish/unpublish callback never completes | PASS* | Native duplicate/publish/submit/unpublish rows reached 100/100. Product shutdown coverage for microphone/camera publication is listed below. |
| Remote decoded callback after track removal | PASS* | Native remote-video row and renderer generation checks reached 100/100. *Historical native/product builds. |
| Renderer never releases a texture | PASS* | Renderer fault archive has 100/100 reload, crash, and withheld-release rows; retained textures stayed within the fixed bound. *Historical product build. |
| Screen-audio target process exits | PASS* | Native screen-audio owner rows reached 100/100 with bounded retirement. *Historical native build. |
| Active microphone device is unplugged | PASS* | Native microphone active-loss row reached 100/100 with owner/resource checks. *Historical native build. |
| Microphone candidate fails | PASS* | Native candidate-failure and cancellation rows reached 100/100. *Historical native build. |
| Output endpoint invalidates or stops making progress | PASS* | Native output invalidation/no-progress/candidate/retry rows reached 100/100; an earlier resource diagnostic was unstable and remains documented as non-qualifying. *Historical native build. |
| Camera unplug or source reader makes no callback | PASS* | Native device-loss/reader-no-callback/candidate rows reached 100/100. Physical unplug and product shutdown are separate evidence. |
| LiveKit connect cancellation and late success | PASS* | Native connect/disconnect/cancel rows reached 100/100; full-product connect/cancel incident series reached 100/100. *Historical product builds. |
| Media utility process crashes | PASS* | Production frontend utility series reached 100/100 primary crashes and 49/49 exhaustion/manual-Retry checks. *The archived series is not the current eba2f6bb final-build qualification. |
| Renderer reloads or crashes | PASS* | Renderer archive reached 100/100 for reload and crash with unchanged Room/publication identities. *Historical product build. |
| New desired state arrives during retry | PASS* | Native microphone/output latest-intent and retry-fence rows reached 100/100; utility replay evidence preserves only the latest snapshot. *Final exact-build replay remains due. |
| App shutdown during a pending or hung operation | PASS* | All 25 concrete pending-operation points below have 100/100 completed evidence across the cited archives. The new recheck covers 14 rows (1,400 shutdowns), with matching inputs and no fixture kills in the passing series. Earlier failures remain separate. *Build identities are preserved; the later microphone no-progress correction is validated by its native suites and is not included in the product binary. |
| Combined GPU contention, audio gap, and renderer stall | PASS* | Combined product archive reached 100/100 continuity cycles with bounded texture retention and neutral-observer media progress. It did not include shutdown while all faults were held. *Historical product build. |

The broad issue rows are grouped over the concrete native and product IDs below.
This mapping prevents a passing owner probe from being mistaken for a full product
or neutral-observer qualification.

| Issue #131 row | Concrete IDs / product scenario | Evidence class |
| --- | --- | --- |
| WGC source closes | `wgc-source-closed`, `wgc-close-racing-frame`, `wgc-prepare-failure`, `wgc-concurrent-stop` | Native owner; product shutdown is separate |
| WGC frame callback after stop | `wgc-frame-after-stop` | Native owner |
| DXGI access lost or device removed | `dxgi-access-lost`, `dxgi-device-removed` | Native owner |
| Encoder accepts input but makes no output | `encoder-input-without-output` | Native owner plus real hardware; resource result is FAIL |
| Publish/unpublish callback never completes | `sdk-submit-duplicate`, `sdk-publish-never-completes`, `sdk-submit-never-completes`, `sdk-unpublish-never-completes` | Native owner; selected product shutdown rows |
| Remote decoded callback after track removal | `remote-video-late-decoded` | Native owner and renderer/product archives |
| Renderer never releases a texture | renderer withheld-release product scenario | Neutral observer/product archive; no native CTest ID |
| Screen-audio target process exits | `screen-audio-target-exit`, `screen-audio-superseded-start`, `screen-audio-retirement-during-new-intent`, `screen-audio-concurrent-stop` | Native owner |
| Active microphone device is unplugged | `microphone-active-device-loss`, `microphone-no-progress` | Native owner; physical device evidence is separate |
| Microphone candidate fails | `microphone-candidate-failure`, `microphone-owner-latest-intent`, `microphone-owner-pending-shutdown` | Native owner |
| Output endpoint invalidates or stops making progress | `output-device-invalidated`, `output-no-progress`, `output-candidate-failure`, `output-retry-budget`, `output-candidate-cancelled`, `output-owner-latest-intent`, `output-owner-pending-shutdown`, `output-default-session-muted` | Native owner; output resource diagnostic remains unstable |
| Camera unplug or source reader makes no callback | `camera-device-removed`, `camera-reader-no-callback`, `camera-candidate-cancelled` | Native owner; product fixture is separate |
| LiveKit connect cancellation and late success | `room-connect-never-completes`, `room-disconnect-never-completes`, `room-cancel-never-completes` | Native owner plus connect incident product archive |
| Media utility process crashes | utility-crash product scenario | Full product replay; historical PASS |
| Renderer reloads or crashes | renderer-reload-or-crash product scenario | Full product replay; historical PASS |
| New desired state arrives during retry | `capture-*concurrent*`, `microphone-owner-latest-intent`, `output-owner-latest-intent`, plus utility replay | Native owner and product replay; exact final build due |
| App shutdown during a pending or hung operation | `pendingOperationMatrix` in the JSON companion | Product shutdown subset; historical mixed status |
| Combined GPU contention, audio gap, and renderer stall | combined-continuity product scenario | Neutral observer/product archive; historical PASS |

The fixed bitrate contract is an additional #139 regression gate:
`encoder-bitrate-unsupported` and `encoder-bitrate-rejected` must keep the same
encoder, publication and Room while warning once and preserving the last confirmed
bitrate.

## Shutdown scope (the pending/hung subset)

Closing the application is tested because a non-cancellable native or SDK call
can otherwise keep the utility or parent process alive. The harness now polls
retained process handles while `app.close()` is pending, records close and kernel
exit timestamps independently, and keeps the 4,900 ms gate unchanged. The issue
does not require 100 shutdown repetitions for every one of the 18 fault
descriptions; the 100/100 requirement is for deterministic fault/recovery rows.

| Pending operation point | Result | Measured evidence |
| --- | --- | --- |
| `sdk-connect`, `sdk-cancel`, `sdk-disconnect` | PASS* | 100/100 each; historical exact-input product archives. |
| `microphone-initialize`, `microphone-capture` | PASS* | 100/100 each; historical exact-input product archive. |
| `sdk-microphone-publish`, `sdk-microphone-unpublish` | PASS* | 100/100 each; historical exact-input product archives. |
| `camera-read-sample`, `sdk-camera-publish`, `sdk-camera-unpublish` | PASS* | 100/100 each; historical exact-input product archive. |
| `output-initialize` | PASS* | Recheck: 100/100, maximum 4,464.53 ms; unchanged 4,900 ms gate, no fixture kills. Earlier 77/100 failure remains historical evidence. |
| `output-render` | PASS* | Recheck: 100/100, maximum 4,123.21 ms; unchanged gate, no fixture kills. Earlier 36/100 failure remains historical evidence. |
| `sdk-screen-publish` | PASS* | Recheck: 100/100, maximum 1,521.25 ms; unchanged gate, no fixture kills. Earlier 28-cycle failure remains historical evidence. |
| `sdk-screen-unpublish` | PASS* | Recheck: 100/100, maximum 1,564.07 ms; unchanged gate, no fixture kills. |
| `sdk-screen-audio-publish`, `sdk-screen-audio-unpublish` | PASS* | Recheck: 100/100 each, maximum 1,679.77 / 1,730.12 ms; unchanged gate, no fixture kills. |
| `screen-audio-initialize`, `screen-audio-capture` | PASS* | Recheck: 100/100 each; unchanged 4,900 ms gate, no fixture kills. |
| `wgc-window-frame-pool` | PASS* | Current-head `e3d6d7f2` Release/test-gates product entered the held WGC call and shut down the owned main and utility processes in 100/100 cycles with a fresh authenticated source-window fixture per cycle; see [`shutdown-wgc-e3d6d7f2-100.json`](shutdown-wgc-e3d6d7f2-100.json). The bounded 3/3 control is archived separately. *A single-fixture exploratory run stopped at 64/100 with `native_fault_entry_deadline`; it remains a raw diagnostic failure, not a waiver. |
| `encoder-input`, `encoder-output`, `wgc-monitor-frame-pool` | PASS* | Recheck: 100/100 each, maximum 1,542.60 / 1,478.21 / 1,490.81 ms; unchanged 4,900 ms gate, no fixture kills. The archive preserves the failed encoder-input shutdown and subsequent pre-injection setup failures separately. |
| `wgc-monitor-start`, `dxgi-acquire-frame` | PASS* | Recheck: 100/100 each, maximum 1,492.52 / 1,649.04 ms; unchanged gate, no fixture kills and all before/after hashes matched. |
| `wgc-window-start` | PASS* | Recheck: 100/100, maximum 2,306.39 ms, unchanged gate, no fixture kills and all hashes matched. Earlier series stopped before injection after 2 and 13 shutdowns; independent inspection found a valid but hidden fixture and `CreateForWindow` error `0x80070057`. The passing fixture explicitly shows its owned source window and validates visibility before launching the app. |

## #130 product cutover

| Acceptance area | Result | Evidence and limitation |
| --- | --- | --- |
| Windows desktop selects Engine v2 and has no browser RTC fallback | PASS* | Desktop voice provider selects the desktop client when the bridge exists; focused web/desktop tests pass. *Final packaged build identity still needs one clean qualification run. |
| Join, move, leave, backend Voice Authority and membership ownership | PASS* | Product cutover validation covers join, A→B→A, fast moves, logout/login and authority projections. *Development evidence, not a final #132 soak. |
| Independent microphone, camera, screen video, screen audio, and output paths | PASS* | All-media product scenario and native owner rows preserve independent states/publication identities. *Historical product builds. |
| Mute, server mute, deafen, PTT, device/profile controls | PASS* | Product validation and focused platform/web tests cover the state transitions and warning lifecycle. Physical keyboard/acoustic quality remain outside this phase. |
| Renderer reload/crash without Room reconnect | PASS* | 100/100 renderer fault rows and cutover reload scenario preserve Room, operation epoch, and publication IDs. |
| Utility restart replays latest state without duplicates | PASS* | 100/100 production utility-crash series plus bounded retry/manual-Retry checks; final exact branch build remains due. |
| Opaque source IDs and bounded, cancellable thumbnails | PASS* | Native picker/thumbnail tests and UI tests pass; HWND/HMONITOR do not cross the renderer boundary. |
| Logout/account switch retires old utility and resources | PASS* | Product validation confirms old utility and native participant removal before the replacement account. *Single scenario evidence. |
| Bounded correlated diagnostics and redacted bundle | PASS* | Connect-timeout incident series reached 100/100 and the upload pilot returned HTTP 200; full cross-layer matrix is still separate. |
| Legacy v1 runtime/compatibility path removed | PASS* | Current desktop wiring and packaging use v2; architecture and cutover docs describe the removed path. Static/build verification is complete for the focused branch. |
| Full relevant desktop/platform/web/native qualification | **FAIL / PARTIAL** | Local focused suites are green (desktop 290, platform 64, web 1077, harness 3). Final exact-head native archives are complete for Release and Debug (42/42 rows each) and preserve encoder resource FAILs; ASan preserves the encoder/output/DXGI resource failures and one missing DXGI row. Hosted run `34700126979` passed the normal Windows job, while its ASan job failed the camera health-proof test (`29/30` CTest rows passed). |

## Current gate

Phase E is **not qualified for merge yet**. Pending-operation shutdown coverage
is now complete across the archives below. The gate remains closed because the
full native suites fail process-resource checks; no maintainer exception has
been approved. A platform background contribution is established, but not every
retained handle is attributed. The microphone behavioral deadline defect found
in the latest ASan suite is corrected and its focused three-configuration
evidence is recorded below. WGC window
frame-pool injection and shutdown already have the 100/100 evidence cited below;
fixture entry is no longer a blocker for that row. The latest archived native
evidence is:
[`native-faults-445cff8a-release.json`](native-faults-445cff8a-release.json) has
42/42 complete rows with three encoder `+1`-handle failures;
[`native-faults-445cff8a-debug.json`](native-faults-445cff8a-debug.json) has
42/42 complete rows with two encoder `+1`-handle failures; and
[`native-faults-445cff8a-asan.json`](native-faults-445cff8a-asan.json) preserves
all sanitizer results, including encoder `+1`, output `+1/+8`, DXGI `+2/+1`, and
one missing follow-on DXGI row after the strict first failure. The consolidated
machine-readable decision boundary is [`encoder-resource-matrix-445cff8a.json`](encoder-resource-matrix-445cff8a.json).
The short configured-MFT control was zero-growth in Release, Debug and ASan;
later duration-matched and active-idle controls below show platform growth.
All positive deltas remain raw failures, never waivers. Local
Debug and ASan camera rows pass 3/3. The current-head product now enters and closes the WGC held call in 100/100
cycles when the authenticated source-window fixture is refreshed per cycle; the
single-fixture exploratory failure remains archived as a raw diagnostic result.
All remaining held-call rows now have complete passing recheck series, with
original failed attempts preserved in the compressed archive. The eight-hour and
multi-machine work remains issue #132 and is not part of these blockers.

## Recheck on 2026-09-19

Release was rebuilt from `95db2f08`. The focused camera, microphone platform,
output platform and output cancellation suites passed all four CTest entries
and all 12 emitted fault rows at 100/100, with no positive resource deltas.
The [focused report](focused-release-recheck-2026-09-19.json) includes the
embedded build identities and binary hashes. Desktop tests passed 290/290 across
39 files; desktop typecheck, preload verification and 11 evidence/shutdown
harness tests also passed. This subset does not replace the full multi-config
matrix or the missing product shutdown evidence.

Before the rebuild, the existing `e3d6d7f2` encoder binary again failed resource
checks: clean start/stop retained 198 handles, and standalone same-thread MFT
activation retained 200 over 100 iterations. The
[diagnostic recheck](encoder-resource-recheck-2026-09-19.json) preserves these
failures. The controlled overlay-disabled comparison follows below; the installed
overlay DLL alone does not establish the cause.

The user subsequently disabled NVIDIA Overlay. The uninstrumented rebuilt
encoder passed 100 activation-only and 100 clean start/stop cycles with zero
resource growth. The no-output fault still retained one net handle after 100
successful owner checks. The [overlay-disabled report](encoder-overlay-disabled-2026-09-19.json)
preserves this unresolved failure. The overlay DLL was still loaded, so these
results do not establish a DLL-level root cause.

With the user's authorization, Docker's stale Windows socket directories were
backed up and recreated. The existing isolated backend containers and data were
preserved. The product shutdown recheck then passed `output-initialize`,
`output-render`, and `sdk-screen-publish` at 100/100 each. The
[compressed report](product-shutdown-recheck-2026-09-19.json.gz) includes every
cycle, binary hashes, and matching before/after frontend, desktop, and backend
inputs. The product's embedded native commit is `e3d6d7f2`; its production source
matched `71242209`. The later microphone progress-deadline correction below is
not included in those binaries. The final archive contains all 14 rechecked
held-call rows at 100/100 each. The native resource gate remains failed; these
shutdown passes do not qualify merge on their own.

Further [resource controls](resource-diagnostics-2026-09-19.json) reproduced
background growth with a single configured MFT kept active for 200 seconds,
without frames, encoder worker, repeated activation, or recovery. Its IO
completion port count increased from seven to eight. Explicit flush/end-streaming
did not remove the duration-matched control's growth. COM and MF startup/shutdown
without activating a transform had zero handle growth over 100 duration-matched
cycles. This isolates a background platform contribution, not the ownership of
every handle observed in a fault run.

Two separate three-batch encoder controls both passed all 300 behavioral
iterations. In each, the first resource batch failed, the second was neutral,
and the third grew again. A larger warmup is therefore not an established fix.
The ASan output recheck also preserves resource failures, while its cancellation
rows pass; the extra output thread starts at Windows `TppWorkerThread`.
The strict process-resource gate remains failed. Diagnostic controls never
waive failures or replace the full qualification matrix.

The complete `71242209` [Release](native-faults-71242209-release.json) and
[Debug/ASan](native-faults-71242209-asan.json) reruns passed 40/48 and 41/48 CTest
entries respectively. Each emitted 38/42 required records; early failures left
follow-on rows missing. Resource failures include encoder/output handles and
microphone/output thread counts. The additional microphone thread in a separate
diagnostic starts at Windows `TppWorkerThread`; its owner worker retired and its
handles were balanced. This does not waive the process-resource check.

The ASan microphone no-progress warmup also failed its behavioral deadline.
A focused diagnostic reproduced no typed error after 1,500 ms, with four frames
and a successful explicit stop. Inspection found that each empty WASAPI wake
started another full 1,000 ms wait instead of consuming the remaining progress
budget. The capture loop now waits only until the existing progress deadline.
The fault probe always joins capture before reporting the actual failure, and
continues to the no-progress row even if the device-loss resource row fails.
The [focused ASan diagnostic](microphone-deadline-recheck-2026-09-19.json)
passed 100/100 measured cycles after 100 warmups with the correction, maximum
1,115.59 ms and zero handle/thread growth. The uncorrected diagnostic failed
after 53 measured passes with no typed error yet and a successful explicit stop.
This correction's focused validation remains separate from the earlier full suites.
The ordinary `71242209` Debug run was interrupted for this correction and is not
claimed as a completed qualification.

The corrected `ce821886` [focused microphone suites](microphone-focused-ce821886.json)
confirm no-progress at 100/100 after 100 warmups in Release, Debug and ASan,
maximum 1,072.30 / 1,065.83 / 1,077.13 ms respectively, with zero resource growth.
All three ASan CTest entries and all five fault rows passed. Release and Debug
still fail the strict process-thread checks in the other microphone rows, and
their early cancellation-row failure leaves pending-shutdown unmeasured in
those runs. No resource gate is relaxed by the deadline correction.

CTest can print failure markers immediately after its padding dots. The evidence
reader now retains those failed completion rows, covered by parser regression
tests. The earlier raw archives are preserved unchanged; their missing CTest
failure entries did not change their overall FAIL result.
