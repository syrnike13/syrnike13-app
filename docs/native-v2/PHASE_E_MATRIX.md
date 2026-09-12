# Phase E qualification matrix

This is the status of Phase E on 2026-09-12. It covers issue #130 (product
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
for 100 measured iterations. The archived Release and Debug runs contain 41
records from the then-current list; all 41 reached 100/100 owner checks. Three
encoder rows failed their resource assertion, so those runs are failed
qualification runs even though their behavioral assertions passed.

| Fault scope | Result | Evidence and limitation |
| --- | --- | --- |
| WGC source closes | PASS* | Release and Debug native rows: 100/100, zero positive resource delta. *Historical native build; product shutdown during the held call is separate. |
| WGC frame callback after stop | PASS* | Release and Debug native rows: 100/100 generation/late-frame checks. *Historical native build. |
| DXGI access lost or device removed | PASS* | Both native results: 100/100 per result, balanced leases and owner checks. *Historical native build. |
| Encoder accepts input but makes no output | **FAIL** | Behavioral row reached 100/100, but Release and Debug resource checks retained +201 handles. Isolated activation stages and the post-reboot no-output probe show machine/driver-dependent NVIDIA Media Foundation retention; no source change is justified without a reproducible application-owned leak. |
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
| App shutdown during a pending or hung operation | **PARTIAL** | Ten held SDK/microphone/camera rows have 100/100 historical PASS evidence; output initialization/render and screen publication have failed prefixes; WGC product setup is blocked. This is the only shutdown scope required here, rather than 18 separate 100-cycle shutdown matrices. |
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
| `output-initialize` | **FAIL / rerun required** | One 77/100 series failed at iteration 78; an independent control reached 100/100. |
| `output-render` | **FAIL / rerun required** | 36/100; old harness recorded 4,944 ms while close itself was observed at 4,849 ms. |
| `sdk-screen-publish` | **FAIL / rerun required** | 28 completed cases before the unchanged 4,900 ms gate failed. |
| `wgc-window-frame-pool` | **BLOCKED** | Current rebuilt product could not find the local validation link before injection; no WGC fault was entered. |
| Screen unpublish/audio, encoder, monitor WGC, and DXGI held calls | NOT RUN | No complete product shutdown row exists yet. |

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
| Full relevant desktop/platform/web/native qualification | **FAIL / PARTIAL** | Local focused suites are green (desktop 290, platform 64, web 1077, harness 3), but native Release/Debug are 44/47 because of encoder resource rows; the latest hosted main job also failed an intermittent +1 WGC probe thread. |

## Current gate

Phase E is **not qualified for merge yet**. The implementation and most recovery
behavior are present, but the gate stays closed until the encoder resource result
is either fixed with application-owned evidence or formally isolated as an
external machine blocker, the pending shutdown rows are rerun with the corrected
harness, the WGC product fixture can inject its operation, and one consistent
final-build Release/Debug/ASan result is archived. The eight-hour and
multi-machine work remains issue #132 and is not part of these blockers.
