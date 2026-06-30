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
participant). However, the native process can **swap rooms** via the existing
`connect_microphone` stdin command, reusing the `AudioSource`, capture
thread, and DSP state — so a seamless move is a *wiring* change (reconnect
IPC + stable session across a move), not a LiveKit-SDK change.

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
