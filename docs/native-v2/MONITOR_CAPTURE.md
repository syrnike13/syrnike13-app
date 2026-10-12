# Isolated WGC monitor capture

Issue #118 adds one local Windows capture path: an opaque monitor source ID is revalidated by `SourceRegistry`, converted to a short-lived native monitor token, opened through `IGraphicsCaptureItemInterop::CreateForMonitor`, and exposed as a bounded frame lease. It is probe-only: LiveKit, Electron, preview, audio, DXGI Desktop Duplication, encoding, and automatic recovery remain outside this module.

## Callback, lease, and stop sequence

```mermaid
sequenceDiagram
    participant P as Probe consumer
    participant C as MonitorCapture
    participant R as SourceRegistry
    participant W as WGC backend
    participant G as D3D11 owner

    P->>C: start(opaque monitor sourceId)
    C->>R: resolve + resolveMonitorTarget
    R-->>C: validated short-lived monitor token
    C->>W: start(token)
    W->>G: create capture-owned BGRA device/context
    W->>W: CreateForMonitor + frame pool + session
    W-->>C: running
    loop each WGC frame
        W->>C: BackendFrame(metadata, bounded WGC frame lease)
        C->>C: enqueue latest, drop oldest at total capacity 3
        P->>C: waitForFrame
        C-->>P: move-only FrameLease
        P->>G: sampledHash (bounded subresource copy/readback)
        P->>C: release
    end
    P->>C: stop(deadline)
    C->>C: reject new frames and leases
    C->>W: revoke callbacks, close session and frame pool
    W->>W: wait for callbacks until the same absolute deadline
    C->>C: wait for start operation to leave capture-owned state
    C->>C: wait for outstanding leases until deadline
    C->>W: finalizeStop
    W->>G: D3D live-object report, release session borrow
    C-->>P: stopped or typed lease deadline failure
```

The free-threaded WGC callback only validates the frame and transfers its `Direct3D11CaptureFrame` plus surface into the bounded output lease. It does not allocate a full-size texture or issue a GPU copy. Dropping, releasing, or destroying the lease closes the retained WGC frame at the documented release point; hash readback and its bounded `CopySubresourceRegion` happen only on the probe consumer thread. The frame pool has one producer slot beyond the three-frame public bound, so a slow consumer still causes deterministic supersession instead of blocking the producer. The callback captures weak shared state, so a callback arriving after terminal stop cannot dereference `MonitorCapture`.

The output bound counts queued frames plus outstanding leases. When capacity three is full, the oldest queued frame is superseded; if all three slots are leased, the new frame is dropped. A `FrameLease` is move-only, releases its texture automatically on destruction, and returns `already_released` from a repeated explicit release.

## Device and capture-item lifetime

Each production capture instance owns its regular D3D11 device/context, session, frame pool, callback tokens, and per-capture live-resource ledger. D3D11 debug devices are the single diagnostic exception: the Windows debug runtime retains process handles after each device destruction, so one process-scoped debug device is warmed before the measured baseline while every capture keeps a separate ledger and owns no resources from another capture. Immediate-context operations are serialized.

One `GraphicsCaptureItem` is retained per live native target because repeated `CreateForMonitor` also leaves process-scoped WGC bookkeeping. Its cache key contains both stable registry identity and the current `HMONITOR`. `Closed` marks entries for eviction; stopping after the native monitor disappears also evicts its entry because Windows does not always send `Closed` when an output is disabled. Reconnect with a different native target cannot reuse the old entry. Callbacks carry cache-entry generations and weak ownership. The cache keeps COM/MTA support alive until its WinRT objects are released, independently of short-lived capture workers. The per-session `Closed` callback emits typed `source_removed`, with no fallback to another monitor.

The probe performs a non-measured warm-up of 64 frames or the measured frame count, capped at 600, before taking its baseline. After every measured session it waits on a resource condition with a five-second deadline, requires threads to return to baseline, and enforces a hard four-handle Windows runtime budget for transient WGC/D3D bookkeeping. The budget is reported in JSON and applies to normal, slow, repeat, and stop-during-start instead of being silently ignored outside the repeat mode. Engine-owned D3D resources use the exact capture-local ledger, while `ReportLiveDeviceObjects` provides the independent debug-layer result.

## Stop deadline

One absolute deadline covers backend callback drain, completion of an in-flight `start()`, and outstanding frame leases. An unreleased lease returns `frame_lease_deadline_exceeded`; a stuck callback returns `wgc_callback_deadline_exceeded`; and unresolved startup returns `capture_start_deadline_exceeded`. In each case the capture moves to `failed` without unsafe reuse. A startup that cannot cross the deadline retires the utility process instead of detaching or joining an unbounded thread. A lease released before the deadline lets stop finish normally.

`monitor-capture` covers this contract with a scripted backend.
