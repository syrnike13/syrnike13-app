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

## Lifecycle foundation

The first executable v2 slice lives in `packages/windows-media-engine` and contains no media API:

```text
Electron main: MediaRuntimeSupervisor
  -> Electron media utility process
    -> windows_media.node: AddonOwner
      -> media_core.lib: Engine
        -> one bounded control queue / one control thread

media_probe.exe
  -> media_core.lib directly
```

The one-shot `Engine` follows this finite transition table. A second lifecycle creates a new `Engine` rather than resetting a consumed instance.

```text
Stopped -> Starting -> Running -> Stopping -> Stopped
             |          |
             +-------> Failed -> Stopping -> Stopped
```

Only the control thread commits lifecycle transitions and accepted desired-state snapshots. Its command queue has capacity 16 and reserves the last slot for shutdown. The addon uses separate Node-API queues for lossless public state and lossy diagnostics, each with capacity 64; neither callback can start, stop, recover, or mutate the Engine. The TypeScript supervisor owns at most 16 pending requests and may restart the utility host after 250 ms and 1 second before entering `failed`. It does not replay desired state automatically after a restart, so the future orchestration owner must submit a new full snapshot with the authoritative revision.

Deadlines are fixed at 2 seconds for core startup, 1 second for core ping and shutdown, 5 seconds for the Electron handshake, and 1.5 seconds for the outer utility shutdown. Queue capacities, protocol version, and native deadlines are generated from the TypeScript contract before the C++ build, so the manifest, verifier, and Engine cannot drift independently. A non-cooperative worker is never detached: the outer probe or Electron main terminates the utility process after its deadline.

The lifecycle boundary now carries the exact protocol v2 described in `PROTOCOL.md`. Its full-snapshot desired state is accepted and queried on the same C++ control thread, but every media intent supports only `off`; `NativeRtcEngineAdapter` therefore remains unavailable until the later desktop cutover.
