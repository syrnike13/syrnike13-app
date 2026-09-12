# Windows native media v2 architecture boundary

## Current product boundary

Windows desktop uses Engine v2 as its only RTC/media executor:

```text
Renderer voice UI
  -> DesktopVoiceService
    -> VoiceDirector
      -> VoiceAuthority / VoiceMembership
      -> NativeRtcEngineAdapterV2
        -> MediaRuntimeSupervisor
          -> Electron media utility
            -> windows_media.node / Engine v2

Web client
  -> BrowserRtcEngineAdapter (unchanged)

Electron hotkeys / overlay
  -> independent utility hosts
  -> syrnike_hotkey.node / syrnike_overlay.node
```

`NativeRtcEngineAdapterV2` owns the latest immutable desired snapshot, credential
lease binding, and renderer demand. `MediaRuntimeSupervisor` owns utility process
lifetime, protocol admission, pending requests, and host epochs. Native Room and
media owners live only in the utility process. A terminal Room/runtime loss is
reported to Voice Director; a camera, microphone, output, screen, or presentation
failure remains within its media path.

The web client keeps `BrowserRtcEngineAdapter`. Electron selects the desktop voice
client whenever the desktop bridge is present, so Windows desktop has no browser
RTC fallback. A missing packaged utility is exposed as the typed
`media_unavailable` runtime state.

## Preserved

- `VoiceDirector`, voice intent, authority, membership, gateway transport, and `RtcEngineAdapter` remain the control-plane seam. Voice Membership still follows backend authority rather than media readiness.
- The browser `BrowserRtcEngineAdapter` remains the web implementation, but Windows desktop does not use it as a fallback.
- Hotkey and overlay addons retain separate utility processes and failure domains, so removing media cannot disable desktop input or overlay behavior.

## Removed

- The v1 native media addon, LiveKit SDK fork, media actors, capture/audio/video code, shared-texture bridge, media utility host, recovery controller, and their build/test harnesses are removed from `develop`.
- The legacy media target and vendored SDK tree are absent. Desktop packaging contains the isolated v2 `windows_media.node` plus its pinned LiveKit runtime DLLs; product voice does not load the removed v1 target.
- Historical v1 behavior is available from Git history and `main`; v2 must not copy old C++ files or wrap the old engine behind a compatibility API.

## Lifecycle and utility boundary

The native implementation lives in `packages/windows-media-engine`:

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

The CPU publication oracle is described in [SCREEN_CPU_REFERENCE.md](SCREEN_CPU_REFERENCE.md). It runs only in the disposable Media Lab publisher, owns a direct Room reference for test convenience, and has no in-process guarantee against a non-returning SDK or D3D call. Product Engine, addon, Electron, and `NativeRtcEngineAdapterV2` do not link to or instantiate that sender.

The production boundary introduced by #121 is described in [SCREEN_PUBLICATION_SEAM.md](SCREEN_PUBLICATION_SEAM.md). The screen pipeline submits bounded commands and encoded-slot tokens to the Room/media-session owner; it never receives owning Room or participant pointers. Engine v2 now composes that seam with the other independent media owners used by the product adapter.

The one-shot `Engine` follows this finite transition table. A second lifecycle creates a new `Engine` rather than resetting a consumed instance.

```text
Stopped -> Starting -> Running -> Stopping -> Stopped
             |          |
             +-------> Failed -> Stopping -> Stopped
```

Only the control thread commits lifecycle transitions and accepted desired-state snapshots. Its command queue has capacity 16 and reserves shutdown/completion progress. Public state uses a bounded coalescing buffer with sequence-gap snapshot recovery, while diagnostics are independently lossy; neither callback mutates Engine state. The TypeScript supervisor owns at most 16 pending requests and may restart the utility after 250 ms and 1 second. On a fresh host epoch, `NativeRtcEngineAdapterV2` installs the current credential lease and submits only its latest accepted desired snapshot; stale replies and events are rejected by epoch, request, revision, and generation checks.

Deadlines are fixed at 2 seconds for core startup, 1 second for core ping and shutdown requests, 5 seconds for the Electron handshake, 12 seconds for a Room connect attempt, 2 seconds for Room disconnect/cancellation, and 1.5 seconds for outer utility shutdown. `RoomOwner` owns the Room-operation watchdog independently of synchronous SDK calls. A missed deadline emits exactly one `room_operation_unresponsive` failure, moves the Engine to `Failed`, and makes the supervisor kill and replace the compromised utility epoch; no second Room worker starts over the hung one.

Before a successful LiveKit connect becomes public, the transport compares `Room::roomInfo().name` and the local participant identity with the expected values from the desired Room intent. A mismatch is torn down and reported as non-retryable `room_authority_mismatch`; its credential lease remains consumed, and the utility epoch is retired so uncertain wrong-Room ownership cannot be reused.

The lifecycle boundary carries the exact protocol v4 described in `PROTOCOL.md`. Its full-snapshot desired state is accepted and queried on the same C++ control thread, while Room and independent track intents are reconciled asynchronously through bounded owner-specific lanes.

The remote-video receive path is described in [REMOTE_VIDEO_RECEIVE.md](REMOTE_VIDEO_RECEIVE.md).
It uses a bounded remote track owner, a process-wide four-slot shared texture pool,
and an Electron bridge with authoritative GPU release. Renderer-specific demand is
re-established after navigation or renderer replacement without reconnecting Room.

The final product ownership diagram, desired-state example, replay rules, and
removed compatibility paths are documented in [PRODUCT_CUTOVER.md](PRODUCT_CUTOVER.md).
