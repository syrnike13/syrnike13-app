# Windows media engine v2

This package owns the Windows native media engine used by Electron: the C++20 control core, the thin `windows_media.node` binding, LiveKit Room transport, and independent microphone, output, camera, screen, screen-audio, and video-presentation owners. Windows desktop has no browser RTC fallback.

The Engine is one-shot: one instance can start and shut down once, and another lifecycle creates a new instance. All lifecycle and desired-state commits run on its single control thread; Room work runs on transport lanes guarded by operation deadlines. A non-cooperative SDK operation produces a typed fatal event, after which Electron replaces the utility process rather than reusing unknown native ownership.

Build and verify with:

```sh
pnpm --filter @syrnike13/windows-media-engine build
pnpm --filter @syrnike13/windows-media-engine test
pnpm --filter @syrnike13/windows-media-engine verify
pnpm --filter @syrnike13/windows-media-engine protocol:check
```

Tests labeled `requires-gpu-video` need a local D3D11 video device and are excluded on hosted CI runners. Architecture notes live in `docs/native-v2`.
