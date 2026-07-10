# CONTEXT.md — Domain glossary

This file names the concepts used across the voice subsystem so architecture
discussions stay precise. Update it as terms crystallize.

## Voice subsystem

### Intent (интент)
The user's *desired* voice channel — what the user just clicked. There is
exactly one **current intent** at a time. The whole point of the
`VoiceIntentDirector` (see below) is that the current intent is **immutable
while observed** and **last-write-wins** on change: a new click supersedes any
in-flight transition, an old `operation_id` can never move the user off the
current intent.

### VoiceIntentDirector (Director)
The single module that owns voice presence state. Deep module behind a small
interface (`join / leave / move`). Owns: the current **intent**, the
**committed channel** (server-confirmed), the **transition queue**, and
**operation recency**. Everything else (LiveKit rooms, native publishers,
gateway events, recovery) lives *behind* it.

### Intent types
- **desired** — the channel the user last asked to be in.
- **committed** — the channel the server has confirmed via broadcast commit
  (`VoiceChannelJoin` / `VoiceChannelMove`). Only the committed channel counts
  as "really in voice" for the roster.
- **phase** — `idle | leaving | joining | connected`. The Director is in exactly
  one phase; a transition is serialized through the queue.

### Transition queue (очередь переходов)
An explicit queue of discrete steps the Director executes **one at a time**.
A voice operation (`join`, `leave`, `move`) is decomposed into steps; a new
intent **truncates the tail** of the queue (coalesce), so the user's latest
click always becomes the final goal. No step starts until the previous one
reaches a terminal state.

### Operation recency (operation_id)
Every transition carries a client-generated `operation_id` (fencing token,
`voice-op-<uuid>`). The Director treats an `operation_id` as **current** only
while it is the head of the queue. Any async side-effect (room teardown,
publisher stop, gateway reply) is guarded by recency inside the Director — an
old `operation_id` can never mutate the current intent. This replaces the
scattered tombstone/ref guards with one local invariant.

### Move
Changing from one voice channel to another. On the wire it is a **single
`move` operation**: the client sends one request, the backend performs a
**hard-leave (old op) + join (new op)** under the hood. The client does not
orchestrate the two sub-steps itself. Legacy `replaces_operation_id` /
`moved_from` backend semantics remain as a fallback and are expected to
atrophy.

### Hard-leave
A fire-and-forget `VoiceStateUpdate { channel_id: null }` for a superseded
operation, sent to tell the server the user is definitively abandoning the
old channel. The Director does **not** wait for a leave commit before
starting the next join — this keeps moves Discord-fast. Determinism comes
from the queue, not from blocking.

### Native voice publisher
A desktop media publisher (microphone / screen / camera) implemented as its
**own LiveKit participant** with identity `<user_id>:desktop-native:<kind>-N`,
joining the voice room as a separate peer. A published track **cannot be
repointed between rooms** at the LiveKit level (a track belongs to a room's
participant). A seamless move keeps the WASAPI capture thread and DSP state
alive through the **Microphone Pipeline**, processes each PCM frame once, and
temporarily fans it out to a room-owned `AudioSource`/track for both the
committed and candidate rooms. Only the latest publish execution generation may
promote the candidate; after its publication is confirmed, the old room-owned
source and track are retired.

### Microphone Pipeline
The single persistent Windows-native microphone pipeline owned by
`MediaRuntime`. It owns the selected input device, one WASAPI capture path, DSP
configuration, warm state, and microphone level meter. Preview render and
LiveKit publish are **consumers** of this pipeline and may coexist at the same
time; they must not open parallel capture paths for the same execution.

Only microphone **publish** exposes session/generation identity through the
renderer-facing `desktop.media` interface, because only publish participates in
voice-session fencing and room ownership. Preview still has an internal
main-to-utility generation for cancellation and recovery, but the renderer
never sees it. Renderer preview lifecycle is reported as identity-free
`running` / `stopped` / `error` state. A renderer-visible "monitor
pseudo-session" is forbidden.

### Native Runtime Supervisor
The Electron-main module that owns one native utility host lifecycle. It
starts the host, validates its contract/build handshake, correlates requests,
applies bounded restart backoff, opens a crash circuit after repeated failures,
and rejects in-flight work with `runtime_lost`. It owns process execution only:
it never owns voice intent, a target channel, or a LiveKit participant choice.

There are two independent supervisors: **media** and **hooks**. This keeps a
media crash from taking down chat, the renderer, hotkeys, or overlay detection.

### MediaRuntime
The instance-owned Windows native module behind `syrnike_media.node`. It owns
exactly one LiveKit runtime lease, the `ScreenActor`, the `MicrophoneActor` that
implements the persistent `Microphone Pipeline`, and the `PreviewActor` render
consumer. Preview and publish consume the pipeline without owning microphone
capture. Its interface is deliberately small: enqueue a typed command, observe
typed events, and request asynchronous shutdown. JSON, stdin/stdout transport,
and process-global media state are not part of this interface.

### Native media actor
An instance-owned, serial command executor inside `MediaRuntime`. The
`MicrophoneActor`, `ScreenActor`, and `PreviewActor` own their respective
threads and resources, apply latest-generation-wins fencing, and reach an
explicit terminal state before releasing them. Microphone capture and DSP are
centralized in the `Microphone Pipeline`; `PreviewActor` owns only render-side
playback, while publish owns only room-specific LiveKit resources. Native
executors do not infer user intent; they execute only commands already
authorized by the renderer-side native media owner.

### Native execution generation
A monotonic fencing number scoped to a native execution kind/session. A newer
start, reconnect, stop, or cancellation invalidates older asynchronous native
work. Generation is intentionally separate from `operation_id`: the Director
owns voice-operation recency, while the native runtime uses generation only to
prevent stale implementation work from mutating current execution state.

### Recovery
Reconciliation between the Director's `committed` channel and the server's
view of the user's presence (after WS reconnect, or a detected drift).
Recovery lives **inside** the Director: it owns `committed`, so it is the
natural place to detect and repair drift by enqueueing a corrective
transition. There is no separate `runVoiceRecovery` orchestrator.

### Two event streams (legacy hazard — being removed)
Historically, voice state was driven by two independent match surfaces:
`VoiceServerUpdate` (unicast, token, `op_id+channel`) and the broadcast
`VoiceChannelJoin/Move` (strict triple `active≈desired≈commit`). Under the
Director, `VoiceServerUpdate` carries **only credentials** and never moves
intent; only the broadcast commit moves `committed`. This collapses the two
surfaces into one source of truth.
