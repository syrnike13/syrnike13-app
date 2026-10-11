# Isolated local screen preview (#123)

Loaded-machine and multi-adapter qualification remain later epic work.

Local preview is an optional projection of the current WGC monitor/window
frame. It does not create a LiveKit track, own Room, restart capture, or change
the hardware H.264 profile. Product Voice UI integration remains #130.

Offers dropped because both preview slots are in use remain counted as pool
drops without changing a healthy preview to failed. This is expected when
capture runs faster than presentation. Allocation, GPU and budget failures
still report degradation.

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
profiles with source sizes up to 3840×2160 and the encoded CPU output pool.
Preview rejects larger source dimensions. Reported
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
pending when capture/encoder stopped issuing commands.
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

## Verification

`local-screen-preview` imports the real GPU texture, checks its pixels, holds
leases across stop and verifies that every preview texture and lease is
released. It carries `requires-gpu-video`.

## Terminal WGC cleanup with a retained frame

Automatic terminal cleanup used to finalize its resource snapshot while the
consumer still held the last WGC frame, so a later explicit stop could not
refresh the already-finalized count. Finalization now waits until callback
cleanup has finished and the retained engine frame count is zero; the normal
capture stop already waits for that drain and invokes finalization again.
