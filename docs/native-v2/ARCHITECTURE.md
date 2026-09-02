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
        -> RoomOwner -> deadline watchdog
                     -> one LiveKit operation lane plus one cancellation lane

media_probe.exe
  -> media_core.lib directly
  -> media_sources.lib -> SourceRegistry -> Win32 SourceEnumerator
  -> media_capture.lib -> MonitorCapture/WindowCapture -> WGC/D3D11

native_media_lab_publisher.exe
  -> media_capture.lib -> WGC/D3D11 FrameLease
  -> media_screen.lib -> one-slot CPU reference pipeline/converter
  -> lab::ReferenceScreenSender -> public LiveKit VideoSource API
```

Source discovery is a separate deep module described in [SOURCE_ENUMERATION.md](SOURCE_ENUMERATION.md). Its public seam returns process-local opaque IDs and bounded value snapshots, while Win32 identity keys and handles stop at the adapter boundary. Issue #117 intentionally leaves the Engine protocol, addon, Electron, capture sessions, and LiveKit unchanged.

The first isolated capture slice is described in [MONITOR_CAPTURE.md](MONITOR_CAPTURE.md). It consumes the opaque monitor ID through the registry, owns a bounded three-frame latest-wins lease queue, and ends at local probe verification; it does not publish or preview frames.

The window extension is described in [WINDOW_CAPTURE.md](WINDOW_CAPTURE.md). It resolves one exact HWND lifetime, preserves the three-frame lease bound, fences each content-size transition by generation, and distinguishes minimized/hidden no-content from terminal close without selecting a replacement window.

The CPU publication oracle is described in [SCREEN_CPU_REFERENCE.md](SCREEN_CPU_REFERENCE.md). It runs only in the disposable Media Lab publisher, owns a direct Room reference for test convenience, and has no in-process guarantee against a non-returning SDK or D3D call. Product Engine, addon, Electron, and `NativeRtcEngineAdapter` do not link to or instantiate that sender.

The production boundary for #121 is described in [SCREEN_PUBLICATION_SEAM.md](SCREEN_PUBLICATION_SEAM.md). The screen pipeline will submit bounded commands and encoded-slot tokens to the Room/media-session owner; it will never receive owning Room or participant pointers. The compiled seam is deliberately deferred until #121 supplies both the real SDK adapter and a deterministic failure-injection adapter, so the interface is shaped by two implementations rather than by the CPU oracle alone.

The one-shot `Engine` follows this finite transition table. A second lifecycle creates a new `Engine` rather than resetting a consumed instance.

```text
Stopped -> Starting -> Running -> Stopping -> Stopped
             |          |
             +-------> Failed -> Stopping -> Stopped
```

Only the control thread commits lifecycle transitions and accepted desired-state snapshots. Its command queue has capacity 16 and reserves shutdown/completion progress. Public state uses a bounded coalescing buffer with sequence-gap snapshot recovery, while diagnostics are independently lossy; neither callback mutates Engine state. The TypeScript supervisor owns at most 16 pending requests and may restart the utility after 250 ms and 1 second. It does not replay desired state after restart, so the future orchestration owner must submit credentials and a new authoritative snapshot.

Deadlines are fixed at 2 seconds for core startup, 1 second for core ping and shutdown requests, 5 seconds for the Electron handshake, 12 seconds for a Room connect attempt, 2 seconds for Room disconnect/cancellation, and 1.5 seconds for outer utility shutdown. `RoomOwner` owns the Room-operation watchdog independently of synchronous SDK calls. A missed deadline emits exactly one `room_operation_unresponsive` failure, moves the Engine to `Failed`, and makes the supervisor kill and replace the compromised utility epoch; no second Room worker starts over the hung one.

Before a successful LiveKit connect becomes public, the transport compares `Room::roomInfo().name` and the local participant identity with the expected values from the desired Room intent. A mismatch is torn down and reported as non-retryable `room_authority_mismatch`; its credential lease remains consumed, and the utility epoch is retired so uncertain wrong-Room ownership cannot be reused.

The lifecycle boundary carries the exact protocol v3 described in `PROTOCOL.md`. Its full-snapshot desired state is accepted and queried on the same C++ control thread, while the room intent is reconciled asynchronously through bounded transport lanes; track intents still support only `off`, so `NativeRtcEngineAdapter` remains unavailable until the later desktop cutover.
