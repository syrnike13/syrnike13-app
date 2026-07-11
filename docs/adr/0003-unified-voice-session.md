# ADR-0003 — Unified Voice Session with platform RTC engines

- **Status:** Accepted
- **Date:** 2026-07-11
- **Supersedes:** ADR-0001 execution model and ADR-0002 media/host ownership

## Context

The previous desktop design combined a browser participant used as the backend
commit anchor with separate native microphone and screen participants. Voice
Intent, browser Room lifecycle, native publication, recovery, and gateway
reconciliation were distributed across the renderer, Electron main, several
large controller modules, and per-kind C++ publication controllers. A media
timeout could therefore trigger a Voice Operation, a gateway reconnect could
destroy a healthy Room, and a same-identity reconnect could wedge LiveKit.

The product requires one behavioural model for web and Windows, while Windows
must keep native crashes isolated from Electron and must not fall back to
browser RTC.

## Decision

### One Voice Director and two RTC adapters

The Voice Director is the only owner of Voice Intent, Voice Operation recency,
Voice Membership transitions, and Voice Recovery. It exposes one behavioural
interface and has two adapters at the RTC seam:

- web: one browser LiveKit Room and participant;
- Windows desktop: one native LiveKit Room and participant in a media utility
  process.

On desktop the Voice Director lives in Electron main, so renderer reload does
not reconnect RTC. On web one owner-tab runs the Voice Director; other tabs
observe it through `BroadcastChannel`/Web Locks and cannot start recovery.

Windows has no browser RTC participant and no runtime fallback. Failure to load
the native engine stops voice explicitly while chat and the renderer survive.

### Reserve, connect, authoritative commit

Every join or recovery creates a Voice Operation and Connection Epoch. The
backend creates a Voice Reservation containing the selected RTC Engine, Client
Instance, and signed participant identity. Voice ingress commits Voice
Membership only after observing that exact participant and publishes an
Authoritative Voice Snapshot. A client ACK or gateway-connected event never
commits membership.

One account has one active Client Instance in voice. A new explicit join may
replace it; recovery from an older instance may not reclaim it. Stale operations
and epochs may only clean up their own resources.

Gateway interruption does not close a healthy RTC connection. Destructive
reconciliation requires an explicit server command or a complete newer
Authoritative Voice Snapshot.

### Break-before-make moves and latest-wins cancellation

A move closes the current Room before connecting the destination. The warm
Microphone Pipeline remains alive, but a voice gap is accepted. If destination
join fails, the client remains disconnected with a manual Retry; it does not
return to the old channel automatically.

A newer Voice Intent immediately invalidates unfinished older generations.
Late credentials, callbacks, and snapshots may not mutate the current Voice
Session. Cooperative native cancellation has a two-second deadline; a stuck
operation causes only the media utility process to be replaced.

All LiveKit connect/publish attempts run outside their actor mailbox. A cancel
command therefore remains executable while an SDK call is pending, settles the
superseded request with a typed reply, joins the attempt before runtime teardown,
and generation-fences its eventual completion. A media-command timeout probes
only the affected actor first; it does not immediately recycle the shared Room.

### Membership is independent from media readiness

Voice Membership is committed by Room connection, not microphone publication.
The user-facing connection line is only `Connecting to RTC → Connected`.
Microphone, camera, screen, screen audio, and output expose independent typed
states and errors. A Media Failure stops or degrades only that media path and
never reconnects the Room.

The Windows Native Media Session owns one participant and publishes every local
Media Track through it. It also subscribes to all remote audio, mixes it with
per-user local persistent volume, and renders it through WASAPI. Remote video is
subscribed on Media Demand and is delivered to the renderer through D3D11
shared textures, with a CPU path reserved for tests and unsupported hardware.
Electron is pinned to 43.1.0 because this cutover relies on its typed
`sharedTexture` import API; Electron 35 cannot provide the GPU bridge contract
and is not ABI-compatible with this native distribution.

Speaking Activity is owned by the RTC Engine adapter rather than the renderer.
The web adapter derives it from the processed local microphone and decoded
remote microphone tracks; the native adapter derives local activity from the
Microphone Pipeline gate and remote activity from native decoded PCM before
publishing the canonical identity set. `ActiveSpeakersChanged` from LiveKit is
not a competing UI source, because merging a delayed server event with local
activity would resurrect stale green indicators.

### Microphone and control semantics

The Microphone Pipeline is opened once and survives mute and channel moves. A
muted join warms capture/DSP and publishes one muted track. Mute/unmute changes
desired state immediately; it never waits behind connect, stops capture,
unpublishes, or reconnects Room. Preview consumes the same pipeline and emits a
coalesced level meter at 20–30 Hz.

Effective Mute is computed independently from User Mute. Deafen also mutes the
microphone while preserving the previous User Mute. Server mute/deafen and
lock-screen privacy mute do not change user buttons. Voice activity and
push-to-talk share this same desired-state calculation.
The authority wire represents self-deafen as both `self_mute` and `self_deaf`;
clearing self-deafen restores the preserved User Mute value. While self-deafened,
the microphone button is an undeafen shortcut rather than a separate mute toggle.

Input changes use candidate WASAPI/DSP pipelines and atomically swap only after
healthy PCM is observed. If an input or output device disappears, the Native
Media Session switches to the current system default without reconnecting Room
and reports the change to the user.

Electron voice ownership is scoped to the authenticated desktop session.
Changing account/session identity shuts down the old director, authority,
transport, and RTC adapter before creating a new `clientInstanceId`; refreshing
the token for the same session only reauthenticates the control transport.

### Recovery and operating-system lifecycle

LiveKit first receives up to ten seconds to recover a transient network loss
within the same Connection Epoch. A terminal failure creates a new epoch and
participant identity. Runtime recovery uses delays of 250 ms, 1 s, and 5 s,
then up to twenty attempts at five-second intervals. After the final failure it
requires manual Retry.

A full application restart never restores voice automatically. Windows sleep
ends Voice Intent and requires a manual join after resume. Locking Windows keeps
Room and output alive but forces privacy mute until unlock.

Voluntary leave completes after local Room close; backend cleanup is idempotent
and may finish later. Local close has the same two-second deadline before media
host replacement.

### Three native fault domains

Windows ships three Node-API DLL modules loaded by three independent Electron
utility processes:

- media: RTC, microphone, output, camera, screen, and preview;
- hotkey: global keyboard hooks;
- overlay: foreground and overlay detection.

Each host has its own supervisor, contract, diagnostics, and recovery. A crash
in one host cannot restart either of the others.

### Diagnostics and delivery

Voice modules write a bounded structured diagnostic ring containing operation,
epoch, request correlation, state transitions, typed errors, and timings. It
never records tokens, room URLs, user IDs, device/window names, paths, or media;
local files expire after seven days.

The implementation is a full rewrite rather than incremental modification of
the current ownership model. Work is performed locally on `develop` and pushed
once as a coherent contract-versioned cutover. There is no production legacy
fallback. The first cutover includes microphone, native output, camera, screen,
screen audio, and remote GPU video.

## Consequences

- The RTC seam is real because web and Windows provide two adapters for one
  interface.
- Voice bugs and tests gain locality in the Voice Director and Voice Authority
  modules instead of being distributed across provider callbacks and recovery
  runners.
- Windows media implementation becomes larger internally but deeper: callers
  know one Room/session interface rather than per-kind sessions and generations.
- Break-before-make intentionally trades seamless moves for deterministic
  ownership and cancellation.
- The first cutover is large and cannot be merged partially; contract-version
  mismatch must fail closed instead of starting restart loops.
