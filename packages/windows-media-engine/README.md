# Windows media engine v2

This package owns the Windows native media engine used by Electron. It contains the C++20 control core, `media_probe.exe`, the thin `windows_media.node` binding, LiveKit Room transport, and independent microphone, output, camera, screen, screen-audio, and video-presentation owners. Product screen capture uses the existing WGC/DXGI paths and production GPU pipeline. The disposable Media Lab retains its CPU reference sender as a delivery oracle. Windows desktop has no browser RTC fallback or v1 compatibility adapter.

The Engine is one-shot: one instance can start and shut down once, and another lifecycle creates a new instance. All lifecycle and desired-state commits run on its single control thread; Room work runs on persistent transport lanes guarded by independent operation deadlines. Protocol v4 stores bounded declarative media intent and private one-attempt credential leases. Media SDK tasks share one serial worker with a bounded queue and reserved Room control admission. A non-cooperative SDK operation produces a typed fatal event, after which Electron replaces the utility process rather than reusing unknown native ownership.

Build and verify with:

```sh
pnpm --filter @syrnike13/windows-media-engine build
pnpm --filter @syrnike13/windows-media-engine test
pnpm --filter @syrnike13/windows-media-engine probe:repeat
pnpm --filter @syrnike13/windows-media-engine probe:sources
pnpm --filter @syrnike13/windows-media-engine probe:sources:sanitized
pnpm --filter @syrnike13/windows-media-engine probe:capture-monitor
pnpm --filter @syrnike13/windows-media-engine probe:capture-monitor:repeat
pnpm --filter @syrnike13/windows-media-engine probe:capture-monitor:slow
pnpm --filter @syrnike13/windows-media-engine probe:capture-monitor:stop-during-start
pnpm --filter @syrnike13/windows-media-engine probe:capture-window
pnpm --filter @syrnike13/windows-media-engine probe:capture-window:resize
pnpm --filter @syrnike13/windows-media-engine probe:capture-window:minimize
pnpm --filter @syrnike13/windows-media-engine probe:capture-window:close
pnpm --filter @syrnike13/windows-media-engine probe:capture-window:repeat
pnpm --filter @syrnike13/windows-media-engine verify
pnpm --filter @syrnike13/windows-media-engine protocol:check
```

`probe:sources` runs 1000 source reconciliations, emits machine-readable JSON, and verifies the documented handle/thread budget. The sanitized variant is the CI artifact gate and omits titles, labels, and exact source IDs. See `docs/native-v2/SOURCE_ENUMERATION.md` for opaque identity semantics, completeness, bounds, fixture coverage, and the Windows handle-reuse limitation.

The monitor probes place a controlled animated window on the selected monitor, capture it through WGC, and emit JSON evidence for 600 frames, a one-frame-per-second consumer, 50 start/stop cycles, and stop-during-start. See `docs/native-v2/MONITOR_CAPTURE.md` for ownership, queue, lease, debug-layer, and process-local source-ID contracts.

The window probes capture a controlled animated HWND and exercise 30 generation-fenced resizes, ten-second minimize/restore, hide/show, cross-monitor movement, terminal close, a typed handle-reuse attempt, and 50 lifecycle cycles. See `docs/native-v2/WINDOW_CAPTURE.md` for event, ownership, resize-retirement, and no-content semantics.

The CPU screen path is a non-production delivery oracle with a process-level fault boundary. See `docs/native-v2/SCREEN_CPU_REFERENCE.md` for its evidence, `docs/native-v2/SCREEN_PUBLICATION_SEAM.md` for the Room-free publication boundary, and `docs/native-v2/SCREEN_GPU_PRODUCTION.md` for GPU conversion, hardware encoding, and bounds. Product resource ownership and protocol contracts are documented in `docs/native-v2/RESOURCE_OWNERSHIP.md` and `docs/native-v2/PROTOCOL.md`.
