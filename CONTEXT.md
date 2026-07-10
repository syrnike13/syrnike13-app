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
`voice-op-<uuid>`). Only the Director may create or supersede it. Credentials,
backend reservation/finalization and local media intent must all name that exact
operation. The Director explicitly maps committed, candidate and retained Room
resources; transport reuse never decides operation ownership. Any async
side-effect is guarded by recency inside the Director, so an old `operation_id`
cannot mutate current intent or manufacture a replacement operation from a
media-recovery path.

### Control operation (controlOperationId)
The Director's last server-confirmed control-plane authority. A join/candidate
is promoted to control only when the server accepts it
(`VoiceServerUpdate`/commit) or returns a typed rejection with its authoritative
operation. `gatewayDispatched` records transport handoff only; it never promotes
the dispatched operation. Explicit terminal leave/reset may clear local
authority. A timeout leaves authority unknown and does not trigger a tight loop
that mints replacement operations.

### Prepared voice reservation
The backend's provisional ownership record for a Director operation. A normal
join/move is compare-and-swap fenced against both the expected control
operation and the **finalized voice session**. Exact retransmission of the same
serialized reservation snapshot is idempotent; a different operation must pass
CAS.

An accepted reservation is a **prepared terminal lease**: downstream room,
token or delivery failure does not roll it back to an older authority. It stays
authoritative until exact finalization, explicit replacement,
`retain_finalized`, disconnect/cancellation or expiry. Only after preparation
may the backend return credentials signed for that operation. Operation-fenced
self flags and pending screen/camera track state accumulate on the reservation
and transfer into the finalized session. Reservation/session updates use exact
serialized-record CAS so a stale webhook cannot overwrite newer flags.

### Finalized voice session
The backend session that actually owns `voice_current` and roster membership.
A normal join is finalized when voice ingress observes the browser participant
whose signed token attribute contains the exact current reservation
`operation_id`. Finalization consumes that exact reservation; a stale webhook
cannot finalize or clean up a newer operation.

On Windows native microphone handoff, the reservation is used to publish and
acknowledge the candidate native track **before** the browser participant is
connected and finalizes the operation. The predecessor therefore remains a
valid finalized native publisher until its replacement is known-good. A failed
or superseded candidate never commits its browser Room and the Director retains
or restores the predecessor.

The browser LiveKit identity is operation-scoped:
`<user_id>:browser:<operation_id>`. The signed token attribute and identity must
name the same valid operation. This makes replacement and cleanup address a
specific transport instead of a reusable user identity; a stale webhook can no
longer disconnect a newer participant that happens to belong to the same user.
UI membership always maps this transport identity back to its base user.

### Voice transport cleanup
An immutable, durable cleanup descriptor containing only operation, base user,
channel and LiveKit node. Every terminal authority transition (reservation
replacement/cancel/retain, finalized replacement, explicit leave and terminal
webhook) atomically enqueues the exact old operation in Redis while committing
the authority change. Gateway and webhook control paths never wait for LiveKit
teardown RPCs.

The crond reconciler removes only operation-scoped browser/native identities,
uses bounded RPC deadlines, re-lists the room, and completes the descriptor
only when no matching transport remains. The descriptor survives process
restart for seven days; missing descriptors are removed from the queue index.

### retain_finalized
The distinct A-return control request for an already connected source:
`retain_finalized(retained A, expected control B)`. It does **not** create A2,
rewrite A's active session or retag A's signed browser transport. The backend
atomically verifies finalized A and prepared B, consumes only B, leaves
`voice_current=A`, and records TTL receipt `voice_retain_receipt:A:B = A`.
Replay succeeds only with no reservation, exact current/raw session A and that
receipt. If B already finalized or another authority won, the typed conflict
names that authority and the client falls back to a fresh Director join instead
of pretending the retained transport changed ownership.

### Credential lease
An immutable set of browser/native LiveKit credentials for one Director
operation and channel. Refresh renews the same operation and its
operation-scoped participant identities; it never creates another operation or
changes server ownership.

### Move
Changing from one voice channel to another. The Director sends one join request
for a new operation with the expected finalized predecessor. The backend
prepares it with compare-and-swap while the predecessor stays finalized and
audible. The new operation becomes finalized only after its signed browser
participant joins; finalization then retires the predecessor. There is no
permanent legacy operation mode.

Returning to a retained source before the candidate request reaches the
gateway is a local cancellation. Once the request was dispatched, returning is
an explicit `retain_finalized(A, expected B)` request. The signed A operation is
preserved; a conflict retires the retained optimisation and requires a fresh
join. Dispatch alone does not change `controlOperationId`.

### Hard-leave
An explicit disconnect/cleanup request. It is used for user leave and terminal
cleanup, not as a client-orchestrated sub-step of move. A prepared candidate
does not evict the finalized predecessor; exact finalization performs that
transition. The backend cancels a prepared reservation with CAS, then re-reads
and removes the finalized session. `VoiceChannelLeave` carries that finalized
operation ID; the Director ignores missing or non-matching remote leave
observations. An explicit local leave may complete local teardown without
waiting for that broadcast.

### LocalMediaIntent
The immutable renderer-to-Electron desired publication envelope derived from
Director state. It carries the current `operationId`, an atomic
`envelopeRevision`, and independent microphone/screen revisions. Microphone is
`off | retain | publish`; screen is `off | prepare | publish`. Renderer code
does not orchestrate native `sessionId` or generation values.

`microphone: retain` is valid only for an already observed, successfully
committed microphone publication. It preserves that publication and may apply
mute while replacement credentials are pending. If no committed publication
exists, `retain` is an off/no-op state; it must never promote an in-flight or
failed attempt.

### Native voice publisher
A desktop media publisher (microphone / screen / camera) implemented as its
**own LiveKit participant** with identity
`<user_id>:desktop-native:<operation_id>:<kind>`,
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

Publication `sessionId` and native execution generation are implementation
details below the Electron seam. Renderer code submits `LocalMediaIntent` and
fences observed state by operation and per-kind revision; it neither chooses
nor sends native execution identity. A generation may appear in diagnostics,
but it is never renderer-owned choreography. Preview has its own internal
revision and reports identity-free `running | stopped | error`; a
renderer-visible monitor pseudo-session is forbidden.

### Native Runtime Supervisor
The Electron-main module that owns one native utility host lifecycle. It
starts the host, validates its contract/build handshake, correlates requests,
applies bounded restart backoff, opens a crash circuit after repeated failures,
and rejects in-flight work with `runtime_lost`. It owns process execution only:
it never owns voice intent, a target channel, or a LiveKit participant choice.

There are two independent supervisors: **media** and **hooks**. This keeps a
media crash from taking down chat, the renderer, hotkeys, or overlay detection.

A query timeout does not prove that the host is dead and may be followed by an
actor-specific liveness probe (`microphone` and `screen` are probed
independently). A mutating publication timeout is different: its commit outcome
is unknowable across the process seam, so keeping the same host could preserve
a ghost publication. The supervisor rejects the request as `runtime_lost`,
recycles that media-host epoch, and reconciles only the latest desired record.
Process/transport/native-fatal failure and failed actor probes also recycle the
host. A healthy query lane cannot hide a wedged publication actor.

### NativeMediaReconciler
The deep Electron-main module behind the declarative desktop seam. It atomically
accepts the latest immutable `LocalMediaIntent`, owns desired/current/retry
state separately for microphone and screen, coalesces newer revisions, and
projects sequenced observed events upward. Runtime restart recovery reapplies
only its latest immutable desired records. The execution controller is an
adapter below this seam; it must not keep a mutable publication recovery
snapshot or invent desired state.

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
threads and resources and apply generation commit fencing. Publication
controllers move blocking work to bounded attempt/retirement workers so actor
mailboxes remain responsive. Microphone capture and DSP are centralized in the
`Microphone Pipeline`; `PreviewActor` owns only render-side playback, while
publish owns room-specific LiveKit resources. Native executors do not infer
user intent; they reconcile only desired records accepted by
`NativeMediaReconciler`.

### Native execution generation
A monotonic fencing number scoped to a native execution kind/session. A newer
start, reconnect, stop, or cancellation invalidates older asynchronous native
work. Generation is intentionally separate from `operation_id`: the Director
owns voice-operation recency, while the native runtime uses generation only to
prevent stale implementation work from mutating current execution state. It is
not a renderer command or voice ownership token.

### Publication attempt worker
The bounded native worker that owns one blocking LiveKit connect/publish/
teardown attempt outside the actor control loop. Microphone and screen keep at
most their committed, candidate and bounded retirement slots. Contention before
the outer deadline returns retryable `actor_busy`; capacity still occupied
after the deadline returns `actor_unresponsive`, and the supervisor recycles
the media host instead of spawning another worker.

The remaining limitation is below this interface: the current LiveKit SDK uses
synchronous calls that cannot be cooperatively cancelled. A permanently stuck
worker is released only by forced utility-host termination. Isolation bounds
the damage, but graceful in-process cancellation/teardown is still unproven.

### Recovery
Reconciliation between the Director's `committed` channel and the server's
view of the user's presence (after WS reconnect, or a detected drift).
Recovery lives **inside** the Director: it owns `committed`, so it is the
natural place to detect and repair drift by enqueueing a corrective
transition. There is no separate `runVoiceRecovery` orchestrator.

Electron local-media retry is a different implementation concern: the
`NativeMediaReconciler` may retry the current per-kind revision, but it cannot
create a voice operation, change a channel, or revive an older revision.

### Credential and commit event streams
Historically, voice state was driven by two independent match surfaces:
`VoiceServerUpdate` (unicast, token, `op_id+channel`) and the broadcast
`VoiceChannelJoin/Move` (strict triple `active≈desired≈commit`). Under the
Director, `VoiceServerUpdate` carries **only credentials** and never moves
intent. Credentials correspond to a prepared terminal lease. Broadcast commit
from exact signed-operation finalization moves `committed`; successful
`retain_finalized` reasserts unchanged finalized A. Operation-fenced leave
observations clear only their matching commit. These event kinds have distinct
roles and one server-confirmed control authority.
