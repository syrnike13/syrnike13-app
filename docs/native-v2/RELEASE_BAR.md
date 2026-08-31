# Windows native media v2 release bar

Windows native media remains unavailable until every item below is demonstrated on supported Windows hardware and recorded in CI or a repeatable qualification run.

## Lifecycle foundation evidence

- `media_probe lifecycle-repeat --count 100` creates a new one-shot Engine per cycle and requires exact post-warmup thread/handle baseline after every cycle.
- CTest covers the transition table, all public event variants, concurrent ping/shutdown, shutdown during `Starting`, deterministic startup rollback, an in-flight apply/deadline race with a coherent unchanged snapshot, double shutdown, late-event fencing, forced process containment for a non-cooperative test worker, and 100 consecutive bounded outcomes for each hung Room connect/disconnect/cancellation path.
- The Electron smoke performs 50 real utility-process start/handshake/ping/shutdown cycles, rejects an incompatible protocol environment, kills a running utility process, and starts another clean cycle in the surviving Electron main process.
- Every Electron smoke cycle round-trips the same desired-state fixture through TypeScript, the utility host, N-API, and C++ before comparing the queried snapshot field for field. Direct addon conformance covers revision conflicts, maximum bounds, one-over and malformed rejection, late-callback fencing, and a 502-event diagnostic flood that delivers at most the queue capacity while control remains responsive.
- Release, Debug, and Debug/ASan builds use the same core sources; CI retains the probe executable, PDBs, manifests, and command output as evidence.
- CI runs the non-mutating generated-protocol check before native compilation, so a descriptor change cannot be hidden by build-time regeneration.

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
