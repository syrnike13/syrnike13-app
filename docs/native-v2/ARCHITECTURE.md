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

`NativeRtcEngineAdapter` owns no native resources. It publishes `available: false` immediately and rejects connection attempts with the non-retryable `native_media_unavailable` failure. The desktop media IPC exposes the same finite state and never starts a utility process, recovery timer, or browser RTC fallback on Windows.

## Preserved

- `VoiceDirector`, voice intent, authority, membership, gateway transport, and `RtcEngineAdapter` remain the control-plane seam, so v2 can replace the executor without rewriting membership semantics.
- The browser `BrowserRtcEngineAdapter` remains the web implementation, but Windows desktop does not use it as a fallback.
- Hotkey and overlay addons retain separate utility processes and failure domains, so removing media cannot disable desktop input or overlay behavior.

## Removed

- The v1 native media addon, LiveKit SDK fork, media actors, capture/audio/video code, shared-texture bridge, media utility host, recovery controller, and their build/test harnesses are removed from `develop`.
- Desktop packaging contains only the hotkey and overlay addons plus their manifest; no `syrnike_media.node`, LiveKit DLL, media helper, or custom runtime executable is allowed.
- Historical v1 behavior is available from Git history and `main`; v2 must not copy old C++ files or wrap the old engine behind a compatibility API.

## Next implementation seam

Future work belongs in `packages/windows-media-engine`. The first executable code must define explicit owners, owner threads, cancellation, teardown order, and bounded waits before adding LiveKit, WASAPI, Media Foundation, D3D, capture, or rendering dependencies.
