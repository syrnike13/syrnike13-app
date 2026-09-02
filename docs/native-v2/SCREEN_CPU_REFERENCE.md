# CPU screen publication reference

The CPU screen path is a correctness oracle for issue #120. It is deliberately
non-production: it performs a D3D11 staging readback and CPU resize before using
the public LiveKit `VideoSource` API. It is not a fallback for a future GPU or
hardware encoder path.

## Frame ownership

```text
WGC frame callback
  -> MonitorCapture/WindowCapture queue owns FrameLease
  -> producer moves lease into ScreenFramePipeline pending slot
  -> sender moves newest lease into ScreenPipelineFrame (active)
  -> CpuScreenConverter reads lease into its reusable BGRA input buffer
  -> converter writes the reusable 1280x720 BGRA VideoFrame
  -> synchronous VideoSource::captureFrame returns
  -> ScreenPipelineFrame releases the lease exactly once
```

The capture callback only moves a lease into its existing bounded capture queue;
it never waits for readback, conversion, or LiveKit. The screen pipeline has one
pending slot (`kScreenFramePipelineCapacity = 1`) and replaces that slot on
overload, so continuity is sacrificed before latency. A frame may be pending or
active, never both, and stop releases the pending lease and waits for the active
lease until its explicit deadline.

## Limits and conversion

- `kScreenFrameMaximumAge` is 250 ms. The pipeline checks age before conversion,
  after deliberate converter delay, and after conversion, so stale work cannot
  reach LiveKit.
- WGC clock skew up to 100 ms into the future is accepted because capture and
  consumer sample QPC at different instants. Zero timestamps and larger future
  offsets use the stale-frame release path.
- `CpuScreenConverter` accepts immutable BGRA8 metadata, copies the D3D texture
  row-by-row through one size-keyed staging texture, and reuses one CPU input
  buffer per source generation. A generation or dimension change replaces the
  buffer before any pixels from the new frame are read.
- The reference output is BGRA8 at 1280x720 and 30 fps. Resize uses documented
  nearest-neighbour sampling; no additional color transform is needed because
  the public LiveKit source accepts BGRA and owns its internal encoder format
  conversion.
- CPU input is capped at 7680x4320x4 bytes, output storage is allocated once by
  `lab::ReferenceScreenSender`, and timing sample arrays stop growing at 4096
  entries.

## Publication lifecycle

`lab::ReferenceScreenSender` owns the LiveKit source, local screen track, reusable output
frame, worker, and publication lifecycle. Start succeeds only after
`publishTrack` exposes a real local publication. The Media Lab additionally
waits for LiveKit's public local-subscriber callback before it starts producing
evidence frames.

Stop first prevents new pipeline submissions, wakes the worker, releases pending
and active leases, joins the worker, and unpublishes only the screen track. If
the Room is already disconnected, server-side track state is already gone, so
stop skips network unpublish and still releases every local object. The
companion synthetic audio track proves that ordinary screen stop and source
close do not disconnect the Room or stop other tracks.

This lifecycle is laboratory-only. `publishTrack`, D3D readback,
`VideoSource::captureFrame`, worker join, and `unpublishTrack` may block inside
third-party/native code, so the `stop` deadline cannot make every call bounded.
The outer Media Lab deadline terminates the disposable publisher process if one
does not return. Production code must use the separate asynchronous boundary in
[SCREEN_PUBLICATION_SEAM.md](SCREEN_PUBLICATION_SEAM.md), and must not link to or
copy this sender's Room ownership.

## Receiver marker and clocks

The converter writes a 144-bit luminance marker into every published frame:

```text
16 magic | 32 sequence | 48 capture epoch ms | 16 generation |
16 source width | 16 source height
```

Capture timestamps originate in WGC's steady/QPC domain. Immediately before
publication, the converter correlates that value with `system_clock` and writes
epoch milliseconds into the marker. The neutral Node observer decodes the
marker after LiveKit delivery and reports sequence range, gaps, out-of-order and
duplicate frames, capture-to-receive p50/p95/max age, stale frames, dimension
transitions, maximum no-frame duration, moving-content changes, and end reason.
Receiver delivery is the source of truth; sender counters alone cannot make a
scenario pass.

## Media Lab evidence

Run all screen scenarios from the repository root:

```powershell
$env:MEDIA_LAB_SCREEN_ONLY = 'true'
pnpm native-media:lab
```

Set `MEDIA_LAB_SCREEN_MODE` to isolate one of these scenarios:

- `screen-cpu-monitor`
- `screen-cpu-window`
- `screen-cpu-slow-pipeline`
- `screen-cpu-late-observer`
- `screen-cpu-observer-rejoin`
- `screen-cpu-resize`
- `screen-cpu-source-close`
- `screen-cpu-stop-during-conversion`
- `screen-cpu-room-disconnect`
- `screen-cpu-repeat` (30 cycles)

The ignored `packages/native-media-lab/artifacts/latest-report.json` combines
sender and neutral-observer evidence. `SCREEN_CPU_REPORT.resources` is measured
inside one connected, already-warmed Room, so it catches resources retained by
repeated publication without counting the SDK's process-global Tokio and
WebRTC runtime initialization. Every sender report also requires zero pending
frames, zero active frames, `released == submitted`, zero capture leases, queue
depth at or below one, and zero live D3D reference objects. The repeat mode
first warms process-global initialization, reconnects the Room, primes one
reusable screen transceiver in that same measured session, then runs 30 cycles.
The first cycle establishes the exact sender-local warmed baseline; cycles 2–30
must return to it after unpublish. The report preserves a `resources.series`
entry after each acknowledged unpublish with handle/thread deltas, published frame count,
pending/active pipeline frames, and live D3D resources. Published tracks and
pending publications are zero by acknowledgement; reusable-transceiver count
is `null` because the public SDK does not expose that diagnostic.

The final repeat resource oracle allows at most twelve additional process
handles and no additional threads after settling. This process-wide value also
includes the bounded WGC capture-item cache for the measured fixture identity.
Individual acknowledged publication cycles retain no pipeline frames or threads
and have a 32-handle transient ceiling; the full series remains visible so a
monotonic trend cannot be hidden by the final value. Both allowances remain far
below the hundreds of handles and threads created by an unreused transceiver per
cycle.

The latest accepted full screen run from this implementation is preserved as
[`examples/screen-cpu-media-lab-report.json`](examples/screen-cpu-media-lab-report.json).
It contains every screen scenario plus all 30 repeat-cycle samples, so review
and CI can compare evidence without relying on an issue comment or ignored
local artifact.
