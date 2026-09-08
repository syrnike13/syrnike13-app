# Product cutover validation

These are integration checks for #130 on Windows on 2026-09-08/09. They are
development evidence, not the release qualification or eight-hour soak required
by #132. The tested tree starts at `3a040872` and includes this cutover change.

## Environment

The actual Electron 43.1.0 application uses Engine v2, the project LiveKit server,
and isolated local backend API, events, voice-ingress, database, Redis, RabbitMQ
and crond services. A second signed-in browser client uses installed Chrome and
a synthetic moving camera image. Tests drive ordinary UI controls and inspect
the public desktop API, SFU publications and renderer presentation counters.

The local stand must include crond: its reconciliation refreshes expiring voice
membership projections. An earlier stand omitted it; long-lived Ready snapshots
from that stand are not valid hydration evidence. The final renderer reload
check below was repeated with crond running.

## Observed behavior

| Scenario | Result |
| --- | --- |
| Join with media off, independently enable camera and screen | Connected through v2; camera, microphone, screen video and screen audio publish together. |
| User mute and deafen | Microphone/output state changes while camera/screen publications retain their IDs. User mute survives undeafen. |
| Server mute | Private authority update reaches the client without another user action. Microphone publication is revoked, while camera, screen video and screen audio keep their IDs. Unmute republishes microphone in the same Room and preserves user mute. |
| Server deafen | Subscription permission and output change; membership and local publication IDs remain stable. |
| Push-to-talk | Public held/released commands change effective microphone mute with all four publication IDs and utility epoch unchanged. |
| Device selection | Explicit input, output and camera selection through UI preserves participant/publications. |
| Camera policy rejection | Independent camera failure; no Room recovery. Selecting a permitted profile restores the path. |
| Per-user volume | User menu changes volume to 0.5; public persisted listener settings confirm it. Restored to 1.0. |
| Manual screen profile | Explicit 960×540 choice changes only the screen publication; other publication IDs remain stable. |
| Adaptation warning | One visible warning persists under the observed limitation and clears on stop. Camera, microphone and Room remain active. |
| Administrative move A→B→A | Destination membership settles, prior room has no native participant; camera/screen reset according to existing move privacy semantics. |
| Fast UI A→B→A | Three pairs of clicks, 733/493/615 ms apart, settle in A with zero native participants in B and no renderer errors. |
| Renderer reload with all media | Voice Operation, Connection Epoch and all SFU track IDs remain identical. Camera preview, screen preview and remote camera presentation resume; no renderer errors. |
| Forced utility termination | Exactly one replacement utility. Microphone, camera and output recover. Expired screen source produces `screen_source_unavailable`; explicit reselection restores screen. No duplicate SFU sources or renderer errors. |
| Logout with all local media active | Old utility is confirmed absent and native SFU participant removed; second browser participant survives. New account uses one replacement runtime. |
| App shutdown with all local media active | Old utility is kernel-confirmed absent; only the browser participant remains in the SFU. |

The remote browser decoded the native camera at 1280×720 (539 frames in the
recorded sample). Native presentation decoded the browser camera at 1280×720:
632 received, 630 drawn, no draw failures. Both directions were inspected visually.
The Windows camera driver supplied its phone-service placeholder image; this
proves transport/presentation, not physical camera scene quality.

The final reload sample contains three active consumers (local camera, local
screen and remote camera), each receiving and drawing frames. Integration tests
also cover stale revisions, old renderer releases, bounded thumbnail cancellation,
pending SDK admission and utility termination failure. The lifecycle smoke covers
50 starts/stops plus incompatible, unexpected-exit and deliberately stalled hosts;
stalled-host retirement checks a retained Windows process handle.

## Automated checks

- Web: 213 files / 1,076 tests passed. Subsequent sidebar/director and UI changes
  received their affected test runs (18 sidebar tests, 27 director tests, and
  15 stage/banner tests).
- Desktop: complete 39 files / 260 tests passed after the final changes.
  Diagnostic logging/bundling: all 10 tests pass, including the redaction change.
- Platform: complete six files / 61 tests passed after the final changes.
- Backend permissions: all 11 tests passed in the Linux builder; the local backend
  was rebuilt and exercised for direct moderation updates.
- Native Release: 38/39 initially passed; the source-enumeration fixture was scoped
  to its own windows and its targeted rerun passed.
- Native Debug: 36/39 initially passed; GPU drain passed on rerun. The two window
  fixtures passed after avoiding 64 unnecessary visible temporary HWNDs during
  handle-reuse probing. Production enumeration/capture deadlines were unchanged.
- Native ASan Debug: complete 39/39 pass, including all GPU tests (190.65 seconds).
- The complete Media Lab passed all 21 scenarios on `3f61baa7`, including its
  50-cycle lifecycle check. The initial local monitor scenario was obstructed by
  the Windows Start menu. Exposing the animated scene restored receiver content
  evidence without changing fixture code or acceptance thresholds.
- Hosted Debug initially reported one additional process thread after monitor
  capture, with zero additional handles or live D3D engine objects. The repeated
  Debug and Release suites passed with the original zero-thread-delta budget.
- CI exposed a race in the unsafe-owner test: Engine state becomes Failed before
  the fatal callback is delivered. The test now waits for that callback and checks
  its final count after joined shutdown. Its 100 repetitions pass in Release and
  ASan Debug; production event ordering is unchanged.

## Diagnostic example and remaining qualification

[The redacted JSONL gzip bundle](product-cutover-diagnostics.jsonl.gz) was created
through `desktop.diagnostics.createBundle` from actual renderer/native runtime
events. The final sample is 239,640 compressed bytes. It contains state, command,
native diagnostics, presentation metrics and bundle inventory records. A scan
against fixture credentials, user/channel IDs, device name and local user path
found no matches. Logs from earlier test sessions are re-sanitized during export.

Physical keyboard PTT is not established by injected input (the native hook
intentionally rejects it). Per-user volume persistence is verified, not audible
mixing quality. Only one Windows camera driver was available. Multi-device
hardware switching, physical camera quality, acoustic assessment, long-running
resource budgets and the full #132 qualification matrix remain separate work.
