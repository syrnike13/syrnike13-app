# Windows media engine v2

This package owns the isolated lifecycle skeleton for the replacement Windows native media engine. It contains a media-free C++20 core, `media_probe.exe`, and the thin `windows_media.node` binding. It has no LiveKit, audio, capture, camera, graphics, or compatibility dependency on v1.

The Engine is one-shot: one instance can start and shut down once, and another lifecycle creates a new instance. All state transitions run on its single control thread; shutdown is idempotent and bounded. A non-cooperative test worker is contained by process termination rather than a detached cleanup thread.

Build and verify with:

```sh
pnpm --filter @syrnike13/windows-media-engine build
pnpm --filter @syrnike13/windows-media-engine test
pnpm --filter @syrnike13/windows-media-engine probe:repeat
pnpm --filter @syrnike13/windows-media-engine verify
```
