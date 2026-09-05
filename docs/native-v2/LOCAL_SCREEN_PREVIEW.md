# Isolated local screen preview (#123)

Local acceptance: [paired reports and the 12-scenario matrix](local-screen-preview-acceptance.json).
The evidence records the uncommitted source fingerprint, exact SDK DLL hashes,
project SFU hash, and raw report hashes. It is not evidence of a merge or deploy.

On the qualification machine, the separate monitor run delivered 49.4 observer
FPS with 54 ms p95 capture age. Window normal delivered 39.8 FPS / 23 ms;
never-release delivered 40.3 FPS / 91 ms; pressure delivered 40.5 FPS / 23 ms.
The 100-cycle burst stayed within the same 250 ms p95 limit (229 ms).
All twelve scenarios finished with zero managed preview textures/leases and
zero publication/encoder slots. Release CTest passed 21/21; desktop tests
225/225; lab tests 14/14. ASan Debug passed lifecycle, GPU converter/encoder,
and local-preview tests (3/3), including real GPU pixels and D3D live resources.

One earlier monitor run overlapping the full desktop test suite exceeded the
latency/gap budgets (293 ms p95); the separate rerun passed unchanged limits.
This is recorded as a qualification limitation, not hidden as a passing run.
Loaded-machine and multi-adapter qualification remain later epic work.

Local preview is an optional projection of the current WGC monitor/window
frame. It does not create a LiveKit track, own Room, restart capture, or change
the hardware H.264 profile. Product Voice UI integration remains #130.

```text
WGC lease -> latest capture slot -> GPU conversion -> encoder admission
                    |                                   |
                    |                           encoded publication -> observer
                    +-> optional GPU BGRA blit (after encoder admission)
                          -> two independent 1280x720 shared textures
                          -> nonblocking completion query
                          -> typed local-preview lease -> Electron renderer
```

The sender's NV12 encoder input is never exported to Electron. Preview submits
its own GPU copy while the source lease is still valid, then releases the WGC
lease. It retains no WGC lease, source input view, or encoder slot. The existing
D3D immediate-context ordering places conversion before the optional copy.
Preview uses `try_lock` for both its state and the shared immediate context;
contention drops the preview frame. Neither encoder admission nor publication
waits for preview release, a GPU query, or a renderer callback.

The process-scoped `LocalScreenPreview` admits only one active publication
owner. A stale owner cannot allocate a second pool. `demand(revision, enabled)`
rejects stale revisions. Its generation changes independently of source and
publication generations; leases include both correlation values. Stop preview
retires only preview slots. Stop publication retires preview before ending the
sender worker. Pending copies and exported leases remain counted across
off/on, resize, and renderer recreation.

States are `off`, `starting`, `running`, `degraded`, and `stopped`. Invalid
preview input, resource pressure, or exhausted slots are separate from screen
publication failures. The next successfully delivered preview restores
`running`. Demand stays enabled across renderer recreation; an explicit off/on
revision pair can be used to retire the old projection without republishing.

## Resource admission

| Consumer | Reservation / hard limit | Admission and release |
|---|---:|---|
| Publication | 192 MiB reserved ahead of preview | Preview cannot borrow it. The existing fixed capture/conversion/encoded pools retain their own ownership. |
| Remote receive | 256 MiB reserved ahead of preview | Its existing four-slot process pool and track state are unchanged. |
| Local preview | 8 MiB partition; two 1280×720 BGRA textures | Only remaining optional budget is available. Two aligned allocations total **7,471,104 bytes (7.125 MiB)**. |
| Combined managed reservation | 456 MiB | Setting available budget to 448 MiB denies preview, clears safe free allocations, and retains exported backing only until authoritative release. |

The publication reservation conservatively covers the existing fixed output
profiles with source sizes up to 3840×2160, including the lab marker texture and
encoded CPU output pool. Preview rejects larger source dimensions. Reported
publication bytes and preview backing bytes are separate; row/heap alignment
for preview uses 256-byte rows and 64-KiB allocations. These are managed backing
estimates, not a measurement or cap of opaque encoder/decoder/driver-internal
allocations. Adapter-wide accounting and broader hardware qualification remain
later epic work. Preview never grows its partition under pressure.

Lowering admission budget cannot revoke an exported renderer lease. That
retained allocation stays within the original 8 MiB hard partition, while all
new preview admission stops. The higher-priority reservations remain available
even when the renderer never releases either preview texture.

## GPU and renderer lifetime

Slots are free, copying, ready, delivered, retired/retiring, or quarantined.
Only one newest completed frame is taken; superseded ready copies are dropped.
A completed copy older than 250 ms is discarded. A query that is still pending
after 200 ms quarantines its allocation rather than reusing unsafe backing.
Quarantine is bounded by the same two slots and does not stop publication.

Each producer call acquires the keyed mutex with zero timeout, submits the
blit, ends its event query, and releases device ownership. The consumer polls
`GetData` once; it does not loop or wait inside the sender. Polling permits
driver submission (no `DONOTFLUSH`), because the last query otherwise remained
pending when capture/encoder stopped issuing commands in the Electron harness.
Export occurs only after successful completion. See the Microsoft contracts
for [ReleaseSync](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgikeyedmutex-releasesync)
and [GetData](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-getdata).

`LocalPreviewBridge` uses the same `TextureLeaseBridge` implementation as remote
video, with its **own instance, schema, generation, and two-entry bound**.
`kind: local-preview`, revision, source/publication correlation, dimensions,
sequence, and timestamp are validated before import. Native HANDLE values stay
between utility and main; the renderer only receives Electron's texture and
typed metadata. Only `allReferencesReleased` returns an exported native slot.
IPC receipt, draw acknowledgement, a timeout, and renderer reload cannot do so.
Release messages are retried until exact-key acknowledgement; native rejects
wrong, stale and duplicate releases without freeing another allocation.

Publication stop also returns encoded outputs that finished encoding but had
not yet been admitted to the sender. Those tail slots were never borrowed by
LiveKit and must be drained before reporting zero resources.

## Executable evidence

Build the published pinned SDK and the isolated Electron bridge:

```powershell
pnpm --filter @syrnike13/windows-media-engine build:lab
pnpm --filter @syrnike13/desktop build:video-lab
pnpm --filter @syrnike13/native-media-lab build
$env:MEDIA_LAB_SERVER_EXE = 'C:/absolute/path/to/project-livekit-server.exe'
$env:PREVIEW_LAB_SCENARIO = 'normal'
pnpm --filter @syrnike13/native-media-lab preview
```

Scenarios: `normal` (window), `monitor`, `slow` (one draw per second),
`never-release`, `cycles` (100 off/on pairs), `reload`, `close`, `resize`,
`source-close`, `pressure`, `late-join`, and `publication-stop` with an
outstanding renderer frame. Every scenario uses the production 1080p60/8 Mbps
hardware H.264 sender and a separate `@livekit/rtc-node` observer. There is no
adaptive policy or screen audio. The local server uses disposable loopback
ports 17990–17992, random credentials and a disposable Electron profile.

Default duration is 20 seconds after publication progresses; allowed range is
18–60 seconds. The native fixture owner caps execution at 90 seconds; outer
process deadline is 110 seconds. Shutdown requests publication stop, destroys
the renderer, and checks safe lease drain for at most 15 seconds. All child
processes are awaited/terminated on failure; no fixture or server is installed.

Reports are written under `packages/native-media-lab/artifacts/`:

- `preview-<scenario>.json`: preview states, counters, backing, timings and
  concurrent publication/encoder/Room counters at 100-ms intervals.
- `preview-<scenario>.json.observer.json`: actual decoded frames, source markers,
  publication SIDs, frame-age p95, gaps, source sizes, and per-second FPS.
- `preview-<scenario>.json.acceptance.json`: paired reports and verifier result.

The observer retains at most 8192 age samples; the harness duration bounds
control telemetry to approximately 1100 snapshots. Renderer/native outstanding
frames are always bounded by two independently of report collection.

Admission is measured with these fixed acceptance thresholds: observer average
at least 20 FPS, each complete steady-state second at least 15 frames,
capture-to-decode p95 below 250 ms, and no inter-frame gap of 500 ms or more.
These are delivery floors under contention, not a claim of physical 60-Hz
presentation. The observer must see exactly one publication and no reconnect;
publication terminal failures and encoder stalls must remain zero. Stalled
preview must stop accepting frames while publication counters continue, and
pressure must reclaim safe preview allocations. All managed slots must be
empty after stop. The verifier rejects internally healthy counters without
actual remote delivery.

`local-screen-preview` CTest additionally checks exported GPU pixels and
downscale, fixed-pool stall, invalid/stale releases, stale demand, 100 concurrent
stop/release cycles, pressure, isolated preview failure, producer-thread exit
with a pending copy, and D3D debug-layer live textures. It carries the existing
`requires-gpu-video` label and must run on real Windows GPU hardware; hosted CI
does not supply that hardware. Bridge tests cover cross-generation bounds,
uncertain imports and schema separation from remote video.

## Follow-up: terminal WGC cleanup with a retained frame

The hosted nightly run exposed a pre-existing source-close diagnostic race:
automatic terminal cleanup finalized its resource snapshot while the consumer
still held the last WGC frame. A later explicit stop could not refresh the
already-finalized count. Finalization now waits until callback cleanup has
finished and the retained engine frame count is zero; the normal capture stop
already waits for that drain and invokes finalization again.

The `capture-window-close` probe now holds a frame across the terminal event,
joins backend cleanup, verifies finalization has not happened, then releases the
frame and verifies clean stop. The D3D-debug result is recorded separately in
`window-close-held-frame-acceptance.json`: zero live engine objects, zero added
threads and one added handle within the existing four-handle budget. Earlier
preview evidence retains its original source fingerprints; this supplementary
proof covers the follow-up fix.
