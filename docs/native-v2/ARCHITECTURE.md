# Windows native media v2 architecture boundary

## Current boundary

The application preserves voice intent, authority, membership, and orchestration while the Windows media executor is absent:

```text
Renderer voice UI
  -> DesktopVoiceService
    -> VoiceDirector
      -> VoiceAuthority / VoiceMembership
      -> RtcEngineAdapter
        -> NativeRtcEngineAdapter: native_media_unavailable

Web client
  -> BrowserRtcEngineAdapter (unchanged)

Electron hotkeys / overlay
  -> independent utility hosts
  -> syrnike_hotkey.node / syrnike_overlay.node
```

`NativeRtcEngineAdapter` owns no native resources and publishes the non-retryable `native_media_unavailable` state. Its temporary `connect()` resolves without starting media so authoritative Voice Membership can survive executor unavailability; the availability event keeps every media path explicitly unavailable. The isolated media utility is exercised by the Phase A protocol/lab, but product voice is not wired to it before the later cutover.

## Preserved

- `VoiceDirector`, voice intent, authority, membership, gateway transport, and `RtcEngineAdapter` remain the control-plane seam, so v2 can replace the executor without rewriting membership semantics.
- The browser `BrowserRtcEngineAdapter` remains the web implementation, but Windows desktop does not use it as a fallback.
- Hotkey and overlay addons retain separate utility processes and failure domains, so removing media cannot disable desktop input or overlay behavior.

## Removed

- The v1 native media addon, LiveKit SDK fork, media actors, capture/audio/video code, shared-texture bridge, media utility host, recovery controller, and their build/test harnesses are removed from `develop`.
- The legacy media target and vendored SDK tree are absent. Desktop packaging contains the isolated v2 `windows_media.node` plus its pinned LiveKit runtime DLLs; product voice does not load the removed v1 target.
- Historical v1 behavior is available from Git history and `main`; v2 must not copy old C++ files or wrap the old engine behind a compatibility API.

## Lifecycle foundation

The Phase A executable slice lives in `packages/windows-media-engine`:

```text
Electron main: MediaRuntimeSupervisor
  -> Electron media utility process
    -> windows_media.node: AddonOwner
      -> media_core.lib: Engine
        -> one bounded control queue / one control thread
        -> RoomOwner -> one LiveKit transport worker lane

media_probe.exe
  -> media_core.lib directly
```

The one-shot `Engine` follows this finite transition table. A second lifecycle creates a new `Engine` rather than resetting a consumed instance.

```text
Stopped -> Starting -> Running -> Stopping -> Stopped
             |          |
             +-------> Failed -> Stopping -> Stopped
```

Only the control thread commits lifecycle transitions and accepted desired-state snapshots. Its command queue has capacity 16 and reserves shutdown/completion progress. Public state uses a bounded coalescing buffer with sequence-gap snapshot recovery, while diagnostics are independently lossy; neither callback mutates Engine state. The TypeScript supervisor owns at most 16 pending requests and may restart the utility after 250 ms and 1 second. It does not replay desired state after restart, so the future orchestration owner must submit credentials and a new authoritative snapshot.

Deadlines are fixed at 2 seconds for core startup, 1 second for core ping and shutdown requests, 5 seconds for the Electron handshake, 10 seconds for SDK connect, and 1.5 seconds for outer utility shutdown. Protocol identity and limits are generated from the canonical JSON descriptor. A non-cooperative SDK worker is never detached: Electron terminates the isolated utility after the outer deadline.

The lifecycle boundary carries the exact protocol v3 described in `PROTOCOL.md`. Its full-snapshot desired state is accepted and queried on the same C++ control thread, while the room intent is reconciled asynchronously through one transport lane; track intents still support only `off`, so `NativeRtcEngineAdapter` remains unavailable until the later desktop cutover.
