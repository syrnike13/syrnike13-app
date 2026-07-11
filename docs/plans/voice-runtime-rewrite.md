# Voice runtime full rewrite

- **Status:** Implemented; validation complete on Windows x64
- **Date:** 2026-07-11
- **Branch:** local `develop`; one coherent push after the cutover is functional
- **Decision:** [ADR-0003](../adr/0003-unified-voice-session.md)
- **Architecture review:** generated outside the repository in the OS temp
  directory

## 1. Outcome

Replace the current browser-anchor plus per-kind native publisher design with:

```text
Voice Director
  ├─ Voice Authority adapter
  └─ RTC Engine adapter
       ├─ web: one browser Room / participant
       └─ Windows: one native Room / participant
            ├─ remote audio mixer + WASAPI output
            ├─ microphone track + one warm capture/DSP pipeline
            ├─ camera track
            ├─ screen video track
            └─ screen audio track
```

The rewrite is complete only when Windows has no browser LiveKit Room and no
per-kind native Room, and when web and desktop are driven by the same Voice
Director interface.

## 2. Non-negotiable invariants

1. Only Voice Director creates Voice Operations or changes Voice Intent.
2. Only Voice Authority commits Voice Membership, after matching RTC presence.
3. Every physical RTC attempt has a unique Connection Epoch and identity.
4. One RTC Engine owns one Room and one participant.
5. Media Track failure cannot initiate Room reconnect or Voice Operation.
6. Mute is desired state, never a queued imperative request behind connect.
7. Gateway reconnect cannot destroy healthy RTC before a newer authoritative
   snapshot.
8. Late work is fenced by Voice Operation plus Connection Epoch; per-track
   generation exists only inside the RTC Engine implementation.
9. Windows media, hotkey, and overlay hosts are independent crash domains.
10. There is no Windows browser RTC or production legacy fallback.
11. A cancelled native connect/publish attempt settles its original request and
    cannot block the actor mailbox or disconnect a newer generation.
12. Desktop account/session replacement rotates the complete Voice Director
    scope and `clientInstanceId` before the new control transport starts.

## 3. Target interfaces

These are behavioural interfaces. Exact TypeScript spelling may change during
implementation, but ownership and allowed information flow may not.

### Voice Director

```ts
type VoiceCommand =
  | { type: 'join'; channelId: string }
  | { type: 'leave' }
  | { type: 'setUserMuted'; muted: boolean }
  | { type: 'setUserDeafened'; deafened: boolean }
  | { type: 'setInputMode'; mode: 'voice_activity' | 'push_to_talk' }
  | { type: 'setPushToTalkHeld'; held: boolean }
  | { type: 'retryVoice' }
  | { type: 'retryMedia'; kind: MediaKind }

interface VoiceDirector {
  dispatch(command: VoiceCommand): void
  snapshot(): VoiceSnapshot
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void
  shutdown(reason: 'app_exit' | 'sleep' | 'logout'): Promise<void>
}
```

The interface deliberately has no Room, token, native session ID, request ID,
or generation.

### Voice Authority adapter

```ts
interface VoiceAuthorityAdapter {
  reserve(input: VoiceReservationRequest, signal: AbortSignal): Promise<VoiceLease>
  cancel(input: VoiceCancellation): Promise<void>
  subscribe(listener: (event: VoiceAuthorityEvent) => void): () => void
  requestSnapshot(): Promise<void>
}
```

`VoiceLease` contains one selected-engine credential, never separate
microphone/screen/camera credentials.

### RTC Engine adapter

```ts
interface RtcEngineAdapter {
  connect(lease: VoiceLease, desired: MediaDesiredState): Promise<void>
  disconnect(cause: DisconnectCause): Promise<void>
  updateDesiredMedia(desired: MediaDesiredState): void
  updateMediaDemand(demand: MediaDemand): void
  subscribe(listener: (event: RtcEngineEvent) => void): () => void
}
```

`updateDesiredMedia` is non-blocking and latest-wins. It stores mute, deafen,
PTT, device, camera, screen, and quality intent even while connect is running.

### Public snapshot

```ts
type VoiceConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'recovering'
  | 'failed'

type MediaState = 'off' | 'starting' | 'running' | 'muted' | 'failed'

type VoiceSnapshot = Readonly<{
  intentChannelId: string | null
  membershipChannelId: string | null
  connection: VoiceConnectionState
  operationId?: string
  connectionEpoch?: string
  retryAttempt?: number
  microphone: MediaSnapshot
  output: MediaSnapshot
  camera: MediaSnapshot
  screen: MediaSnapshot
  effectiveMuted: boolean
  userMuted: boolean
  userDeafened: boolean
}>
```

Renderer UI reads this snapshot; it does not reconstruct state from native
events, gateway presence, and React refs.

## 4. Work sequence and local commits

All commits remain local until section 11 passes. Each commit must build with
the preceding commits; no intermediate commit is pushed to `origin/develop`.

### Commit A — contract and characterization

Create:

- `packages/platform/src/voice/voice-types.ts`
- `packages/platform/src/voice/voice-director.ts`
- `packages/platform/src/voice/voice-director.test.ts`
- `packages/platform/src/voice/voice-engine.ts`
- `packages/platform/src/voice/voice-authority.ts`

Change:

- `packages/platform/src/index.ts`
- `packages/platform/src/api.ts`
- platform media/IPC validators and their tests

Work:

- define Voice Operation, Client Instance, Connection Epoch, selected RTC
  Engine, Voice Lease, Voice Snapshot, Media Desired State, typed errors;
- implement the pure latest-wins reducer and effect scheduler;
- express recovery, move, leave, sleep, lock, mute, and media failure as
  deterministic state-machine tests;
- add a fake Voice Authority adapter and fake RTC Engine adapter;
- forbid engine events from creating operations or changing Voice Intent.

Exit criteria:

- A→B→A with arbitrarily reordered fake completions always ends at A;
- failed B after A close ends `failed(B)` and disconnected;
- mute during connect updates desired state synchronously;
- track failure leaves Voice Membership unchanged.

### Commit B — transport-neutral Voice Authority

Preserve the existing Redis exact-CAS reservation/session implementation where
its invariant still applies.

Change:

- `services/backend/crates/core/database/src/voice/session.rs`
- `services/backend/crates/core/database/src/voice/join.rs`
- `services/backend/crates/core/database/src/voice/mod.rs`
- `services/backend/crates/core/database/src/events/client.rs`
- `services/backend/crates/bonfire/src/voice.rs`
- `services/backend/crates/daemons/voice-ingress/src/api.rs`
- `services/backend/crates/daemons/crond/src/tasks/voice_calls.rs`
- generated/shared schema files in `packages/api-types`

Replace:

- browser-specific commit anchor with `rtc_engine` claim validation;
- three native credential fields with one Windows native credential;
- per-kind native participant identity parsing with one identity containing
  user, client instance, operation, and epoch;
- unversioned reconnect inference with an Authoritative Voice Snapshot version.

Remove:

- `retain_finalized` and retained-source optimization;
- make-before-break predecessor reservation semantics;
- native microphone/screen/camera identity variants;
- cleanup logic that guesses ownership from media kind.

Keep:

- reserve before token issuance;
- participant-presence commit in voice ingress;
- exact operation-scoped cleanup descriptors;
- idempotent CAS and stale webhook rejection;
- voice call lifecycle and roster publication.

Exit criteria:

- web presence commits only a web reservation;
- native presence commits only a Windows reservation;
- stale epoch presence/leave cannot replace or clear newer membership;
- a second Client Instance replaces the first only after explicit join;
- gateway reconnect produces a complete versioned snapshot before destructive
  reconciliation is permitted.

### Commit C — one-room native media core

Create or replace with equivalent names:

- `packages/desktop-native/native/src/media/livekit_voice_room.hpp/.cpp`
- `packages/desktop-native/native/src/media/remote_audio_mixer.hpp/.cpp`
- `packages/desktop-native/native/src/media/audio_output_actor.hpp/.cpp`
- `packages/desktop-native/native/src/media/camera_actor.hpp/.cpp`
- `packages/desktop-native/native/src/media/video_frame_bridge.hpp/.cpp`

Rewrite:

- `media_runtime.hpp/.cpp`
- `livekit_publication_client.hpp/.cpp`
- `microphone_actor.hpp/.cpp`
- `screen_actor.hpp/.cpp`
- `microphone_publication_controller.hpp/.cpp`
- `screen_publication_controller.hpp/.cpp`
- `runtime_types.hpp`
- `media_addon.cpp`
- native CMake sources and tests

Design:

- `LiveKitVoiceRoom` exclusively owns the Room, local participant, credential,
  connection epoch, subscriptions, and Room teardown;
- track actors receive a room-owned publication interface but cannot connect or
  disconnect Room;
- one microphone `AudioSource` remains published and muted/unmuted in place;
- screen video and screen audio share one screen lifecycle but independent
  track cleanup;
- camera is a first-class actor in the first cutover;
- remote audio is decoded/mixed in native code and rendered through WASAPI;
- video is decoded into D3D11 shared textures; handles are epoch- and
  sequence-fenced before delivery to Electron;
- device enumeration and candidate hot-swap never run on the Node event loop;
- media desired-state updates have a separate non-blocking control lane;
- blocked connect/close receives two seconds before host termination.

Delete after replacement:

- any per-kind `LiveKitRoomSession` owner;
- committed/candidate Room slots inside microphone/screen publication modules;
- per-kind participant credentials and reconnect commands;
- process priority changes; retain only thread-scoped MMCSS.

Exit criteria:

- exactly one Room/participant in mic+camera+screen scenarios;
- stopping/failing one track never disconnects another;
- 1000 warm/mute/track start-stop cycles open one WASAPI capture path;
- preview meter delivers 20–30 coalesced updates per second;
- remote audio volume/deafen/output swap are testable through one interface;
- video demand stops decode without changing membership.

### Commit D — three utility hosts and narrow supervisors

Create:

- `syrnike_hotkey.node` and its utility entrypoint;
- `syrnike_overlay.node` and its utility entrypoint;
- separate hotkey and overlay transport contracts/supervisors.

Change:

- `packages/desktop-native/native/CMakeLists.txt`
- native build/staging/manifest/verification/smoke scripts;
- `apps/desktop/src/utility/runtime-host.ts`
- utility entry files;
- `apps/desktop/src/main/native-runtime/contract.ts` or replace it with
  per-runtime contracts;
- `runtime-supervisor.ts`, `utility-adapter.ts`, artifact verification;
- current hooks/overlay main modules and tests;
- Windows CI workflow.

Keep one generic supervisor implementation only if it hides handshake,
timeouts, restart, and circuit policy behind a small interface. Runtime command
schemas must not remain one giant union solely to reuse that implementation.

Exit criteria:

- media, hotkey, and overlay processes can be crash-injected independently;
- media restart does not unregister hotkeys or overlay rules;
- hotkey or overlay restart does not touch Voice Membership;
- package contains three `.node` files, LiveKit DLLs, and no runtime `.exe`.

### Commit E — desktop Voice Director in Electron main

Create:

- `apps/desktop/src/main/voice/desktop-voice-director.ts`
- `apps/desktop/src/main/voice/desktop-voice-authority-adapter.ts`
- `apps/desktop/src/main/voice/native-rtc-engine-adapter.ts`
- `apps/desktop/src/main/voice/voice-ipc.ts`
- tests with fake authority, fake utility adapter, renderer reload, logout,
  sleep/lock, and crash injection.

Change:

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/desktop-session.ts`
- preload and platform desktop interfaces;
- `native-media-engine.ts`
- native diagnostics/metrics attachment.

The main process already owns persisted desktop session credentials. The
desktop Voice Authority adapter therefore owns its authenticated control
connection in main instead of delegating Voice Operations to renderer. Session
replacement/logout must rotate or destroy that adapter. Tokens remain in main
and are never included in diagnostic events or renderer snapshots.

The native RTC adapter translates one Voice Lease into one media-host
`connectVoice` command. It stores desired media independently and reapplies the
latest value after host recovery. It never exposes native request IDs,
session IDs, or generations upward.

Windows lifecycle:

- renderer reload: Room continues; new renderer receives Voice Snapshot;
- media crash: new epoch/identity and 20-attempt recovery policy;
- gateway/control reconnect: Room continues until authoritative snapshot;
- app exit/logout/sleep: local Room closes, intent clears;
- Win+L: privacy mute only; unlock restores effective state calculation.

Exit criteria:

- desktop can join/leave/move without renderer-owned LiveKit or gateway voice
  orchestration;
- renderer destruction during a call causes no new participant;
- media host crash cannot affect Electron main, chat, hotkeys, or overlay;
- diagnostics correlate operation/epoch/request without sensitive values.

### Commit F — web RTC adapter and owner-tab

Create:

- `apps/web/src/features/voice/voice-browser-rtc-adapter.ts`
- `apps/web/src/features/voice/voice-authority-adapter.ts`
- `apps/web/src/features/voice/voice-tab-owner.ts`
- adapter and leader-election tests.

Rewrite:

- `voice-provider.tsx` as thin Director composition and context projection;
- `voice-join.ts` into the browser RTC adapter;
- `voice-gateway.ts` into transport for the authority adapter;
- `voice-session-context.ts` to project Voice Snapshot;
- voice flags, local setup, screen share, and stage controllers to send desired
  media commands rather than own transitions.

Delete after migration:

- `voice-intent-director.ts/.test.ts` after tests move to platform;
- `voice-intent-executor.ts/.test.ts`;
- `voice-intent-gateway-events.ts/.test.ts`;
- `voice-native-media-owner.ts/.test.ts`;
- `voice-recovery-runner.ts/.test.ts`;
- `native-media-coordinator.ts/.test.ts`;
- native-first and LocalMediaIntent orchestration from renderer;
- retained Room and retain-finalized client paths.

Preserve and adapt:

- browser capture and local setup implementation;
- `voice-room-audio`, remote audio mixer, stage/media rendering;
- preference stores, device picker, speaking/gate calculation;
- screen/camera UI and their pure state helpers;
- gateway reliable delivery mechanics below the authority interface.

Exit criteria:

- one owner-tab has one browser Room;
- another tab can display state but cannot run recovery;
- explicit takeover replaces the previous Client Instance exactly once;
- mic failure keeps browser Room/output connected;
- browser and Windows pass the same shared Director behaviour suite.

### Commit G — UI projection and deletion pass

Change UI to render:

- connection line: `Connecting to RTC` or `Connected` only;
- named media errors: microphone, output, camera, screen, screen audio;
- recovering attempt number and final manual Retry;
- administrative mute/deafen separately from user buttons;
- automatic default-device switch notification;
- runtime load/ABI failure without generic `Native media execution failed`.

Apply the deletion test to every old module. A pass-through module remains only
when deleting it would leak platform differences into multiple callers.

Repository assertions:

- no `onSidecarLost`, helper/EXE vocabulary, per-kind native identities,
  `retain_finalized`, or browser Room on Windows;
- no renderer-generated native session ID/generation;
- no generic media error presented to users when a typed error exists;
- no production runtime fallback.

## 5. Acceptance matrix

### Intent and authority

1. Idle → A on web: reserve web, one browser participant, matching presence
   commits A.
2. Idle → A on Windows: reserve native, one native participant, matching
   presence commits A; no browser participant exists.
3. Wrong engine, operation, client instance, or epoch cannot commit.
4. A→B closes A locally before reserving/connecting B.
5. Failed B leaves `failed(B)` and disconnected; manual Retry creates a new
   operation/epoch.
6. Rapid A→B→A before token B: B is canceled and only final A may connect.
7. Rapid A→B→A after token/RTC B: late B closes itself and cannot commit or
   mutate final A.
8. A→B→C with every async completion reordered ends only in C.
9. A second Client Instance wins only after explicit join; recovery from the
   replaced instance cannot take membership back.
10. Voluntary leave becomes locally disconnected after Room close without
    waiting for gateway snapshot.

### Gateway and network

11. Gateway reconnect with temporarily empty store leaves healthy RTC intact.
12. Only a newer complete Authoritative Voice Snapshot may correct membership.
13. Network loss shorter than ten seconds recovers the same epoch through
    LiveKit reconnect.
14. Terminal network failure creates a new epoch and never reuses identity.
15. Twenty failed recovery attempts stop at manual Retry without a crash loop.

### Media independence

16. Mute/unmute during blocked connect is accepted immediately and the latest
    value is applied when microphone track exists.
17. Mute keeps capture/DSP and publication alive and never renegotiates Room.
18. Mic failure leaves Room/output connected and reports microphone failure.
19. Camera failure leaves audio and screen unchanged.
20. Screen target close stops only screen video/audio and does not select a new
    target automatically.
21. Output failure leaves membership intact and retries/falls back to default.
22. Device switch validates candidate PCM before atomic swap.
23. Device unplug always switches to current system default and reports it.
24. Preview and publication share exactly one WASAPI capture path.
25. Preview meter is delivered at 20–30 Hz without blocking control events.
26. Deafen preserves User Mute and restores it when deafen ends.
27. Server mute/deafen never moves user buttons.
28. Win+L forces privacy mute; unlock restores computed Effective Mute.

### Native lifetime and isolation

29. One native Room publishes mic, camera, screen video, and screen audio.
30. Track start/stop never creates another participant.
31. Media host crash preserves Electron/renderer/chat/hotkey/overlay and starts
    recovery with a new epoch.
32. Hung cancel/close kills only media host after two seconds.
33. Hotkey crash restores actual registrations without touching media.
34. Overlay crash restores actual rules without touching media/hotkeys.
35. Renderer reload preserves desktop voice and receives current snapshot.
36. Full app restart does not restore voice.
37. Windows sleep closes voice and resume does not auto-join.

### Video and performance

38. All remote audio is subscribed and mixed natively.
39. Remote video is subscribed only while demanded and quality follows demand.
40. D3D11 shared texture handles from an old epoch are rejected.
41. 1080p60 delivers at least 55 FPS with no freeze longer than one second.
42. Electron main event-loop lag p99 remains at or below 50 ms.
43. 1000 lifecycle cycles show no monotonic thread/handle growth.
44. Eight-hour soak grows memory by less than 2 MB/hour after warmup.

### Packaging

45. Debug and Release native builds pass CTest.
46. Electron ABI load smoke passes for all three `.node` modules.
47. Packaged smoke joins fake/controlled RTC and survives media crash injection.
48. Runtime resources contain no project-owned `.exe`.
49. Unsigned artifacts are allowed for the current project policy; signature is
    not a cutover blocker.

## 6. Test migration

Port behaviour, not source shape:

- move reducer/property scenarios from `voice-intent-director.test.ts` to the
  shared Voice Director suite;
- move executor join/move/recovery cases into fake authority/RTC integration;
- preserve reliable gateway ACK/retry tests under the authority adapter;
- replace native media owner/coordinator tests with desktop adapter desired-
  state tests;
- replace controller session-map tests with one-room epoch tests;
- keep supervisor, utility adapter, artifact, diagnostics, hotkey, and overlay
  tests;
- adapt C++ processing/actor/runtime tests to one shared Room;
- preserve backend CAS, call lifecycle, reconciliation, and ingress tests while
  adding engine/client/epoch claims and snapshot-version cases.

No test may assert private file shape, method names, or duplicated state that is
scheduled for deletion.

## 7. Observability

Every transition records:

- monotonic timestamp;
- Voice Operation and Connection Epoch in non-sensitive hashed/correlation
  form;
- previous/next state;
- command/event kind;
- stage, typed error code, retryability, and duration;
- runtime host epoch and restart attempt where applicable.

Never record credentials, room URL/name, user ID, participant identity, window
title, device name, process path, or media. Logs are size-bounded, rotated, and
removed after seven days.

## 8. Verification commands

Run focused checks after each local commit and the full set before push:

```powershell
pnpm --filter @syrnike13/platform typecheck
pnpm --filter @syrnike13/platform build
pnpm web:test
pnpm web:build
pnpm desktop:test
pnpm desktop:typecheck
pnpm desktop:build
pnpm desktop-native:build:debug
pnpm desktop-native:test:debug
pnpm desktop-native:build
pnpm desktop-native:test
pnpm desktop-native:verify
pnpm backend:check
```

On this Windows workspace, an OpenSSL/vcpkg/backend toolchain failure is an
environment blocker rather than permission to install system dependencies.
Backend validation then completes in Linux CI.

## 9. Push gate

Before the single push to `origin/develop`:

- all shared/web/desktop/native focused tests pass locally;
- full web and desktop builds pass;
- native Debug and Release builds plus CTest pass;
- generated API types match backend wire shape;
- no stale architecture vocabulary remains in code/docs;
- `git diff` contains only the coherent rewrite and documentation;
- the commit range is reviewed as one contract-versioned cutover;
- CI workflow is prepared to exercise backend, Windows native, Electron smoke,
  package verification, and crash injection from the same head commit.

The push is not the end of hardening. It is the earliest point at which nightly
may collect real hardware evidence without running two incompatible voice
architectures.
