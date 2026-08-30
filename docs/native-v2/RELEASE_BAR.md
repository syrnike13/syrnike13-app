# Windows native media v2 release bar

Windows native media remains unavailable until every item below is demonstrated on supported Windows hardware and recorded in CI or a repeatable qualification run.

## Lifecycle foundation evidence

- `media_probe lifecycle-repeat --count 100` creates a new one-shot Engine per cycle and requires exact post-warmup thread/handle baseline after every cycle.
- CTest covers the transition table, concurrent ping/shutdown, shutdown during `Starting`, deterministic startup rollback, double shutdown, late-event fencing, and forced process containment for a non-cooperative test worker.
- The Electron smoke performs 50 real utility-process start/handshake/ping/shutdown cycles, rejects an incompatible protocol environment, kills a running utility process, and starts another clean cycle in the surviving Electron main process.
- Release, Debug, and Debug/ASan builds use the same core sources; CI retains the probe executable, PDBs, manifests, and command output as evidence.

This evidence only opens the lifecycle boundary. It does not make desktop media available and does not satisfy any audio, video, capture, transport, or hardware row below.

## Correctness

- Join, leave, channel move, reconnect, credential rotation, logout, suspend, lock, unlock, and app shutdown preserve Voice Director and membership invariants without stale participants or publications.
- Microphone, output, camera, screen video, screen audio, device changes, permission denial, and device loss have typed finite failures and idempotent teardown.
- Windows desktop never falls back to renderer-owned RTC, and hotkey/overlay failures cannot restart or corrupt the media engine.

## Ownership and shutdown

- Every native resource appears in `RESOURCE_OWNERSHIP.md` with one owner object and owner thread.
- Cancellation reaches every blocking operation, all waits are bounded, callbacks cannot outlive their owner, and shutdown is safe when repeated or interrupted at any initialization stage.
- Process, thread, handle, COM, GPU, audio, capture, and LiveKit resource counts return to an agreed baseline after repeated sessions and failure injection.

## Quality and operations

- Focused unit, integration, process-boundary, packaging, and hardware tests pass in Release and diagnostic builds.
- Soak runs cover rapid reconnect, device churn, screen/camera contention, network loss, sleep/wake, and renderer replacement without crash, hang, unbounded queue growth, or leaked resources.
- Signed production packaging contains only allowlisted artifacts with verified hashes, and diagnostics identify the failing stage without credentials, tokens, paths, or user content.

The release decision requires evidence for every row; a successful local happy-path call is insufficient.
