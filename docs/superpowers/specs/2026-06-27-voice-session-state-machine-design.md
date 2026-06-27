# VoiceSession State Machine Design

## Problem

Voice currently mixes three different facts:

- the user wants to be in a voice channel;
- LiveKit has a real RTC participant in a room;
- Redis says the user is present in the product voice state shown to clients.

Those facts are updated in different processes and at different times. The current
system uses join intents, LiveKit webhooks, Redis membership keys, session IDs,
operation IDs, and frontend local state as separate guards. This reduces some
races, but the model is not explicit enough. A user can be locally connected to
LiveKit while the server voice state is not committed yet, or a stale LiveKit
event can arrive after the user has already moved elsewhere.

The goal is to make voice state boring and falsifiable: every visible product
state must correspond to an explicit VoiceSession transition.

## Decision

Introduce a canonical `VoiceSession` state machine owned by the backend.

LiveKit remains the source of truth for physical RTC facts:

- a participant really joined a room;
- a participant really left a room;
- a track was really published, muted, unpublished, or unmuted.

The Syrnike backend remains the source of truth for product facts:

- which channel the user intends to join;
- whether the user is allowed to connect, speak, listen, publish video, or share
  screen;
- which DM or group call is ringing or active;
- which native sidecar identities belong to the current operation;
- which voice state should be shown to clients.

Redis stores the canonical VoiceSession records and the read projection used by
gateway clients. The application must not read LiveKit's internal Redis keys
directly. LiveKit is accessed through its RoomService API and webhook events.

## VoiceSession Model

Each join attempt creates one session:

```text
VoiceSession {
  operation_id: string
  user_id: string
  channel_id: string
  server_id?: string
  node: string
  room_sid?: string
  participant_sid?: string
  state: preparing | awaiting_livekit_join | active | leaving | ended | failed
  self_mute: boolean
  self_deaf: boolean
  created_at: timestamp
  updated_at: timestamp
  expires_at: timestamp
  failure_reason?: string
}
```

`operation_id` is the fencing token. A LiveKit webhook, gateway retry, native
sidecar event, or timeout may mutate only the current session for that user and
channel. If the operation does not match, the event is stale and must be ignored
or cleaned up in LiveKit.

## Redis Shape

The new Redis model should use explicit namespaced keys:

```text
voice_session:<operation_id>       canonical session record
voice_current:<user_id>            current operation id for the user
voice_channel_members:<channel_id> active user ids for UI projection
voice_channel_state:<channel_id>   serialized channel voice state projection
voice_channel_node:<channel_id>    selected LiveKit node
voice_room_session:<channel_id>    current LiveKit room sid
```

The old scattered keys such as `vc:*`, `vc_members:*`, `joined_at:*`,
`session:*`, and `operation:*` should be removed as part of the migration. No
backwards-compatible dual-write layer is planned.

## Join Flow

1. The client sends a gateway `VoiceStateUpdate` with `channel_id` and a fresh
   `operation_id`.
2. The backend validates the channel, permissions, capacity, selected LiveKit
   node, and call notification inputs.
3. The backend creates `VoiceSession(state=awaiting_livekit_join)` and writes
   `voice_current:<user_id> = operation_id`.
4. The backend creates or reuses the LiveKit room and returns `VoiceServerUpdate`
   with browser and native LiveKit credentials.
5. The client connects to LiveKit.
6. LiveKit sends `participant_joined`.
7. `voice-ingress` asks the state machine to commit the join.
8. The state machine verifies the session is current and awaiting this LiveKit
   participant, then transitions to `active`.
9. The read projection receives the user in `voice_channel_members:<channel_id>`.
10. The backend publishes `VoiceChannelJoin` or `VoiceChannelMove`.

The user is not a committed product voice participant until step 8.

## Client Connected States

The frontend must separate RTC connection from server commit:

```text
connecting_gateway
fetching_rtc_token
connecting_rtc
rtc_connected_waiting_server_commit
connected
failed
```

`room.connect()` moves the UI to `rtc_connected_waiting_server_commit`, not
`connected`. The UI becomes `connected` only after a gateway commit event with
the matching `operation_id`.

This intentionally sacrifices optimistic UI speed to avoid false voice presence.

## Leave Flow

1. A client leave request, channel switch, permission loss, or cleanup marks the
   current session as `leaving`.
2. The backend asks LiveKit to remove the base participant and current native
   sidecars.
3. `participant_left` confirms the leave.
4. The state machine verifies `participant_sid` and `operation_id`, then marks
   the session `ended`.
5. The read projection removes the user from the channel.
6. The backend publishes `VoiceChannelLeave`.

If LiveKit does not emit `participant_left` within a timeout, the backend may
force-finalize the session. Force-finalization is allowed only while the same
operation is still current.

## Track Flow

LiveKit track events update only the projection for an active current session:

```text
track_published Camera            -> camera=true
track_unpublished Camera          -> camera=false
track_published ScreenShare       -> screensharing=true
track_unpublished ScreenShare     -> screensharing=false
track_published Microphone        -> no membership flag change
track_published ScreenShareAudio  -> no membership flag change
```

Track events from stale base participants are ignored. Track events from stale
native sidecars remove that sidecar from LiveKit and do not mutate the read
projection.

## Native Sidecars

Desktop native media uses separate LiveKit participants:

```text
<user_id>:desktop-native:<operation_id>:microphone
<user_id>:desktop-native:<operation_id>:screen
<user_id>:desktop-native:<operation_id>:camera
```

Native sidecars are not membership. A native sidecar can update media flags for
the base user only when:

- its base identity matches `user_id`;
- its operation id matches the current active VoiceSession;
- the base session is active.

If a native sidecar is seen without a current active base session, the backend
removes it from LiveKit.

## Reconciliation

Add a backend repair loop for active voice channels.

For each active channel:

1. Load active VoiceSessions from Redis.
2. Ask LiveKit RoomService for current participants.
3. If a base participant is missing for an active session, finalize that session
   as stale and publish leave.
4. If LiveKit contains a base participant without a current session, remove that
   participant from LiveKit.
5. If LiveKit contains a native sidecar without a matching active base session,
   remove that sidecar from LiveKit.
6. If the projection differs from canonical sessions, rebuild the projection and
   publish snapshots only when the user-visible state changes.

Reconciliation is a repair mechanism, not the primary write path.

## Call Lifecycle

DM and group call lifecycle must follow committed sessions, not intents.

- Ringing starts only when the first session becomes active.
- A call becomes active based on committed active participants.
- A call ends when all committed active sessions leave, subject to the existing
  DM/group leave policy.
- Stale LiveKit participants and native sidecars must not keep a call alive.

## Error Handling

- Gateway request accepted but LiveKit never joins: session becomes `failed` or
  `ended` after timeout; client receives a recoverable failure.
- LiveKit join arrives for old operation: remove participant from LiveKit and do
  not publish product voice state.
- LiveKit leave arrives for old participant sid: ignore it.
- Track event arrives before session is active: ignore it or queue only if the
  matching session is still awaiting commit and the base participant matches.
  Prefer ignoring and relying on later LiveKit state/reconciliation for
  stability.
- Permission loss: transition current session to `leaving`, remove LiveKit
  participant, and publish leave after finalization.

## Testing Strategy

Add backend tests for the state machine transitions:

- join request creates `awaiting_livekit_join`;
- matching `participant_joined` commits to `active`;
- stale `participant_joined` is rejected;
- matching `participant_left` ends the session;
- stale `participant_left` is ignored;
- track events update projection only for the active current operation;
- native sidecars do not create membership;
- reconciliation removes stale Redis sessions and stale LiveKit participants.

Add frontend tests for visible states:

- `room.connect()` alone does not produce `connected`;
- matching `VoiceChannelJoin` moves to `connected`;
- stale commit events do not mutate the current local session;
- channel switch keeps old LiveKit events from changing the new channel state.

## Non-Goals

- Do not read LiveKit internal Redis keys directly.
- Do not maintain backwards-compatible voice Redis keys.
- Do not redesign the media encoding or native capture pipeline as part of this
  work.
- Do not change user-facing voice permissions semantics unless the state machine
  exposes an existing bug.

## Success Criteria

- A user is visible in a voice channel only after LiveKit confirms the base
  participant joined.
- Screen share is visible only after LiveKit confirms the screen track.
- Rapid channel switching cannot leave the user visible in two channels.
- Stale native sidecars cannot keep membership or calls alive.
- Restarting `voice-ingress` or missing one webhook is repaired by
  reconciliation.
- New clients receive a `Ready.voice_states` snapshot derived from the projection,
  and that projection can be rebuilt from canonical VoiceSessions.
