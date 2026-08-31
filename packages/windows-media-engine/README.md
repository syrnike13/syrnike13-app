# Windows media engine v2

This package owns the isolated lifecycle foundation for the replacement Windows native media engine. It contains the C++20 core, `media_probe.exe`, the thin `windows_media.node` binding, and the Phase A LiveKit Room transport. Audio, capture, camera, graphics, and compatibility code from v1 remain absent.

The Engine is one-shot: one instance can start and shut down once, and another lifecycle creates a new instance. All lifecycle and desired-state commits run on its single control thread; Room work runs on persistent transport lanes guarded by independent operation deadlines. Protocol v3 stores bounded declarative intent and private one-attempt credential leases. A non-cooperative SDK operation produces a typed fatal event, after which Electron replaces the utility process rather than reusing unknown native ownership.

Build and verify with:

```sh
pnpm --filter @syrnike13/windows-media-engine build
pnpm --filter @syrnike13/windows-media-engine test
pnpm --filter @syrnike13/windows-media-engine probe:repeat
pnpm --filter @syrnike13/windows-media-engine verify
pnpm --filter @syrnike13/windows-media-engine protocol:check
```
