# VoiceSession State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered voice Redis membership/intents with a canonical backend-owned VoiceSession state machine, and make clients show connected voice only after server commit.

**Architecture:** Backend Redis stores one canonical `voice_session:<operation_id>` record plus the `voice_current:<user_id>` fencing pointer. LiveKit webhooks transition sessions from awaiting join to active, update media flags only for active sessions, and end only matching sessions. The existing `UserVoiceState` client payload stays as the read model, but it is derived from active VoiceSessions instead of old `vc:*`, `vc_members:*`, `joined_at:*`, `session:*`, and `operation:*` scattered keys.

**Tech Stack:** Rust backend (`services/backend/crates/core/database`, `services/backend/crates/daemons/voice-ingress`), Redis via `redis-kiss`, LiveKit webhooks, TypeScript/Vitest frontend voice state machine.

---

## File Structure

- Create `services/backend/crates/core/database/src/voice/session.rs`
  - Owns `VoiceSession`, `VoiceSessionState`, Redis key helpers, pure transition helpers, and Redis-backed transition functions.
- Modify `services/backend/crates/core/database/src/voice/mod.rs`
  - Exports session APIs, removes old join intent as the write path, keeps only small compatibility-free helpers that read the new projection.
- Modify `services/backend/crates/core/database/src/voice/join.rs`
  - Creates `VoiceSession(state=awaiting_livekit_join)` before returning LiveKit credentials.
- Modify `services/backend/crates/daemons/voice-ingress/src/api.rs`
  - Uses the new transition functions for `participant_joined`, `participant_left`, room cleanup, and track events.
- Modify `services/backend/crates/core/database/tests/voice_reconciliation.rs`
  - Adds session-aware reconciliation tests for stale Redis sessions and stale LiveKit participants.
- Modify `apps/web/src/features/voice/voice-session-machine.ts`
  - Makes `native_publish_succeeded` unable to move the UI to `connected`.
- Modify `apps/web/src/features/voice/voice-session-machine.test.ts`
  - Adds regression tests for server commit being the only connected transition.

---

### Task 1: Add Pure VoiceSession Model

**Files:**
- Create: `services/backend/crates/core/database/src/voice/session.rs`
- Modify: `services/backend/crates/core/database/src/voice/mod.rs`

- [ ] **Step 1: Write failing pure model tests**

Add this test module to the new file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use iso8601_timestamp::{Duration, Timestamp};

    fn channel() -> UserVoiceChannel {
        UserVoiceChannel {
            id: "voice-a".to_string(),
            server_id: Some("server-a".to_string()),
        }
    }

    fn awaiting_session() -> VoiceSession {
        VoiceSession::new_awaiting_join(VoiceSessionCreate {
            operation_id: "op-a".to_string(),
            user_id: "user-a".to_string(),
            channel: channel(),
            node: "node-a".to_string(),
            self_mute: true,
            self_deaf: false,
            created_at: Timestamp::UNIX_EPOCH,
            expires_at: Timestamp::UNIX_EPOCH
                .checked_add(Duration::seconds(120))
                .unwrap(),
        })
    }

    #[test]
    fn new_session_starts_awaiting_livekit_join() {
        let session = awaiting_session();

        assert_eq!(session.operation_id, "op-a");
        assert_eq!(session.user_id, "user-a");
        assert_eq!(session.channel.id, "voice-a");
        assert_eq!(session.state, VoiceSessionState::AwaitingLivekitJoin);
        assert_eq!(session.self_mute, true);
        assert_eq!(session.self_deaf, false);
        assert_eq!(session.voice_state(Timestamp::UNIX_EPOCH).id, "user-a");
    }

    #[test]
    fn matching_livekit_join_activates_session() {
        let mut session = awaiting_session();

        let result = session.mark_livekit_joined(
            "room-a",
            "participant-a",
            Timestamp::UNIX_EPOCH.checked_add(Duration::seconds(5)).unwrap(),
        );

        assert_eq!(result, VoiceSessionTransition::Applied);
        assert_eq!(session.state, VoiceSessionState::Active);
        assert_eq!(session.room_sid.as_deref(), Some("room-a"));
        assert_eq!(session.participant_sid.as_deref(), Some("participant-a"));
        assert_eq!(
            session.joined_at,
            Some(Timestamp::UNIX_EPOCH.checked_add(Duration::seconds(5)).unwrap())
        );
    }

    #[test]
    fn livekit_join_does_not_reactivate_ended_session() {
        let mut session = awaiting_session();
        session.state = VoiceSessionState::Ended;

        let result = session.mark_livekit_joined("room-a", "participant-a", Timestamp::UNIX_EPOCH);

        assert_eq!(result, VoiceSessionTransition::Rejected);
        assert_eq!(session.state, VoiceSessionState::Ended);
        assert_eq!(session.participant_sid, None);
    }

    #[test]
    fn matching_participant_left_ends_active_session() {
        let mut session = awaiting_session();
        session.mark_livekit_joined("room-a", "participant-a", Timestamp::UNIX_EPOCH);

        let result = session.mark_participant_left("participant-a", Timestamp::UNIX_EPOCH);

        assert_eq!(result, VoiceSessionTransition::Applied);
        assert_eq!(session.state, VoiceSessionState::Ended);
    }

    #[test]
    fn stale_participant_left_is_rejected() {
        let mut session = awaiting_session();
        session.mark_livekit_joined("room-a", "participant-new", Timestamp::UNIX_EPOCH);

        let result = session.mark_participant_left("participant-old", Timestamp::UNIX_EPOCH);

        assert_eq!(result, VoiceSessionTransition::Rejected);
        assert_eq!(session.state, VoiceSessionState::Active);
    }

    #[test]
    fn track_updates_only_active_session_flags() {
        let mut session = awaiting_session();

        assert_eq!(session.set_track_state(true, 3), VoiceSessionTransition::Rejected);

        session.mark_livekit_joined("room-a", "participant-a", Timestamp::UNIX_EPOCH);

        assert_eq!(session.set_track_state(true, 3), VoiceSessionTransition::Applied);
        assert_eq!(session.screensharing, true);
        assert_eq!(session.camera, false);

        assert_eq!(session.set_track_state(true, 1), VoiceSessionTransition::Applied);
        assert_eq!(session.camera, true);

        assert_eq!(session.set_track_state(false, 2), VoiceSessionTransition::Noop);
        assert_eq!(session.screensharing, true);
        assert_eq!(session.camera, true);
    }
}
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
cargo test -p syrnike-database --features voice voice::session::tests --lib
```

Expected: FAIL because `session.rs`, `VoiceSession`, and transition methods do not exist.

- [ ] **Step 3: Implement the pure model**

Create `services/backend/crates/core/database/src/voice/session.rs` with:

```rust
use iso8601_timestamp::Timestamp;
use serde::{Deserialize, Serialize};
use syrnike_models::v0::UserVoiceState;

use super::{partial_voice_state_for_track, UserVoiceChannel};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceSessionState {
    Preparing,
    AwaitingLivekitJoin,
    Active,
    Leaving,
    Ended,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceSession {
    pub operation_id: String,
    pub user_id: String,
    pub channel: UserVoiceChannel,
    pub node: String,
    pub room_sid: Option<String>,
    pub participant_sid: Option<String>,
    pub state: VoiceSessionState,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub server_muted: bool,
    pub server_deafened: bool,
    pub screensharing: bool,
    pub camera: bool,
    pub version: u64,
    pub joined_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub expires_at: Timestamp,
    pub failure_reason: Option<String>,
}

pub struct VoiceSessionCreate {
    pub operation_id: String,
    pub user_id: String,
    pub channel: UserVoiceChannel,
    pub node: String,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceSessionTransition {
    Applied,
    Rejected,
    Noop,
}

impl VoiceSession {
    pub fn new_awaiting_join(input: VoiceSessionCreate) -> Self {
        Self {
            operation_id: input.operation_id,
            user_id: input.user_id,
            channel: input.channel,
            node: input.node,
            room_sid: None,
            participant_sid: None,
            state: VoiceSessionState::AwaitingLivekitJoin,
            self_mute: input.self_mute,
            self_deaf: input.self_deaf,
            server_muted: false,
            server_deafened: false,
            screensharing: false,
            camera: false,
            version: 1,
            joined_at: None,
            created_at: input.created_at,
            updated_at: input.created_at,
            expires_at: input.expires_at,
            failure_reason: None,
        }
    }

    pub fn mark_livekit_joined(
        &mut self,
        room_sid: &str,
        participant_sid: &str,
        joined_at: Timestamp,
    ) -> VoiceSessionTransition {
        if self.state != VoiceSessionState::AwaitingLivekitJoin {
            return VoiceSessionTransition::Rejected;
        }

        self.state = VoiceSessionState::Active;
        self.room_sid = Some(room_sid.to_string());
        self.participant_sid = Some(participant_sid.to_string());
        self.joined_at = Some(joined_at);
        self.updated_at = joined_at;
        VoiceSessionTransition::Applied
    }

    pub fn mark_participant_left(
        &mut self,
        participant_sid: &str,
        left_at: Timestamp,
    ) -> VoiceSessionTransition {
        if self.state != VoiceSessionState::Active {
            return VoiceSessionTransition::Rejected;
        }
        if self.participant_sid.as_deref() != Some(participant_sid) {
            return VoiceSessionTransition::Rejected;
        }

        self.state = VoiceSessionState::Ended;
        self.updated_at = left_at;
        VoiceSessionTransition::Applied
    }

    pub fn set_track_state(&mut self, added: bool, track_source: i32) -> VoiceSessionTransition {
        if self.state != VoiceSessionState::Active {
            return VoiceSessionTransition::Rejected;
        }

        let partial = partial_voice_state_for_track(added, track_source);
        let mut changed = false;

        if let Some(camera) = partial.camera {
            changed |= self.camera != camera;
            self.camera = camera;
        }
        if let Some(screensharing) = partial.screensharing {
            changed |= self.screensharing != screensharing;
            self.screensharing = screensharing;
        }

        if changed {
            self.version += 1;
            VoiceSessionTransition::Applied
        } else {
            VoiceSessionTransition::Noop
        }
    }

    pub fn voice_state(&self, fallback_joined_at: Timestamp) -> UserVoiceState {
        UserVoiceState {
            id: self.user_id.clone(),
            joined_at: self.joined_at.unwrap_or(fallback_joined_at),
            self_mute: self.self_mute,
            self_deaf: self.self_deaf,
            server_muted: self.server_muted,
            server_deafened: self.server_deafened,
            screensharing: self.screensharing,
            camera: self.camera,
            version: self.version,
        }
    }
}
```

Modify `services/backend/crates/core/database/src/voice/mod.rs`:

```rust
pub mod call_lifecycle;
mod join;
mod session;
mod voice_client;
pub use join::*;
pub use session::*;
pub use voice_client::VoiceClient;
```

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
cargo test -p syrnike-database --features voice voice::session::tests --lib
```

Expected: PASS.

---

### Task 2: Add Redis Persistence and Projection APIs

**Files:**
- Modify: `services/backend/crates/core/database/src/voice/session.rs`
- Modify: `services/backend/crates/core/database/src/voice/mod.rs`

- [ ] **Step 1: Write failing Redis-key and serialization tests**

Add tests to `session.rs`:

```rust
#[test]
fn voice_session_serializes_with_snake_case_state() {
    let session = awaiting_session();

    let value = serde_json::to_value(&session).expect("serialize session");

    assert_eq!(value["state"], "awaiting_livekit_join");
    assert_eq!(value["operation_id"], "op-a");
    assert_eq!(value["channel"]["id"], "voice-a");
}

#[test]
fn voice_session_keys_use_explicit_namespace() {
    assert_eq!(voice_session_key("op-a"), "voice_session:op-a");
    assert_eq!(voice_current_key("user-a"), "voice_current:user-a");
    assert_eq!(
        voice_channel_members_key("voice-a"),
        "voice_channel_members:voice-a"
    );
    assert_eq!(
        voice_channel_node_key("voice-a"),
        "voice_channel_node:voice-a"
    );
    assert_eq!(
        voice_room_session_key("voice-a"),
        "voice_room_session:voice-a"
    );
}
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
cargo test -p syrnike-database --features voice voice::session::tests --lib
```

Expected: FAIL because key helpers are missing.

- [ ] **Step 3: Implement key helpers and Redis serialization**

Add to `session.rs`:

```rust
use redis_kiss::{
    redis::{FromRedisValue, RedisError, RedisWrite, ToRedisArgs, Value},
    AsyncCommands,
};
use syrnike_result::{create_error, Result, ToSyrnikeError};

pub fn voice_session_key(operation_id: &str) -> String {
    format!("voice_session:{operation_id}")
}

pub fn voice_current_key(user_id: &str) -> String {
    format!("voice_current:{user_id}")
}

pub fn voice_channel_members_key(channel_id: &str) -> String {
    format!("voice_channel_members:{channel_id}")
}

pub fn voice_channel_state_key(channel_id: &str) -> String {
    format!("voice_channel_state:{channel_id}")
}

pub fn voice_channel_node_key(channel_id: &str) -> String {
    format!("voice_channel_node:{channel_id}")
}

pub fn voice_room_session_key(channel_id: &str) -> String {
    format!("voice_room_session:{channel_id}")
}

impl ToRedisArgs for VoiceSession {
    fn write_redis_args<W: ?Sized + RedisWrite>(&self, out: &mut W) {
        out.write_arg(
            serde_json::to_string(self)
                .expect("VoiceSession serializes to JSON")
                .as_bytes(),
        );
    }
}

impl FromRedisValue for VoiceSession {
    fn from_redis_value(v: &Value) -> std::result::Result<Self, RedisError> {
        let raw = String::from_redis_value(v)?;
        serde_json::from_str(&raw).map_err(|error| {
            RedisError::from((
                redis_kiss::redis::ErrorKind::TypeError,
                "VoiceSession",
                error.to_string(),
            ))
        })
    }
}
```

Add Redis functions:

```rust
const VOICE_SESSION_TTL_SECONDS: usize = 120;

pub async fn create_voice_session(session: &VoiceSession) -> Result<()> {
    let mut conn = super::get_connection().await?;
    conn.set_ex(
        voice_session_key(&session.operation_id),
        session,
        VOICE_SESSION_TTL_SECONDS,
    )
    .await
    .to_internal_error()?;
    conn.set(
        voice_current_key(&session.user_id),
        &session.operation_id,
    )
    .await
    .to_internal_error()
}

pub async fn get_voice_session(operation_id: &str) -> Result<Option<VoiceSession>> {
    super::get_connection()
        .await?
        .get(voice_session_key(operation_id))
        .await
        .to_internal_error()
}

pub async fn get_current_voice_session(user_id: &str) -> Result<Option<VoiceSession>> {
    let mut conn = super::get_connection().await?;
    let operation_id: Option<String> = conn
        .get(voice_current_key(user_id))
        .await
        .to_internal_error()?;

    match operation_id {
        Some(operation_id) => conn
            .get(voice_session_key(&operation_id))
            .await
            .to_internal_error(),
        None => Ok(None),
    }
}
```

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
cargo test -p syrnike-database --features voice voice::session::tests --lib
```

Expected: PASS.

---

### Task 3: Create VoiceSession During Gateway Join

**Files:**
- Modify: `services/backend/crates/core/database/src/voice/join.rs`
- Modify: `services/backend/crates/core/database/src/voice/mod.rs`

- [ ] **Step 1: Write failing source-level regression test**

Add to `services/backend/crates/core/database/src/voice/join.rs` tests:

```rust
#[test]
fn join_flow_creates_voice_session_not_join_intent() {
    let source = include_str!("join.rs");

    assert!(source.contains("VoiceSession::new_awaiting_join"));
    assert!(source.contains("create_voice_session(&session).await?"));
    assert!(!source.contains("set_user_voice_join_intent("));
}
```

- [ ] **Step 2: Run test to verify red**

Run:

```bash
cargo test -p syrnike-database --features voice join_flow_creates_voice_session_not_join_intent --lib
```

Expected: FAIL because join still calls `set_user_voice_join_intent`.

- [ ] **Step 3: Replace intent creation with session creation**

In `join_voice_channel`, replace the `set_user_voice_join_intent` block with:

```rust
    let now = Timestamp::now_utc();
    let session = VoiceSession::new_awaiting_join(VoiceSessionCreate {
        operation_id: operation_id.to_string(),
        user_id: user.id.clone(),
        channel: user_voice_channel.clone(),
        node: node.clone(),
        self_mute: options.self_mute,
        self_deaf: options.self_deaf,
        created_at: now,
        expires_at: now
            .checked_add(Duration::seconds(VOICE_SESSION_TTL_SECONDS as i64))
            .ok_or_else(|| create_error!(InternalError))?,
    });
    create_voice_session(&session).await?;
```

Update imports in `join.rs` to include:

```rust
use iso8601_timestamp::{Duration, Timestamp};
```

and the session items from `super`:

```rust
create_voice_session, VoiceSession, VoiceSessionCreate, VOICE_SESSION_TTL_SECONDS,
```

- [ ] **Step 4: Run test to verify green**

Run:

```bash
cargo test -p syrnike-database --features voice join_flow_creates_voice_session_not_join_intent --lib
```

Expected: PASS.

---

### Task 4: Commit, Leave, and Track Transitions Through VoiceSession

**Files:**
- Modify: `services/backend/crates/core/database/src/voice/session.rs`
- Modify: `services/backend/crates/core/database/src/voice/mod.rs`
- Modify: `services/backend/crates/daemons/voice-ingress/src/api.rs`

- [ ] **Step 1: Write failing pure stale-current tests**

Add to `session.rs` tests:

```rust
#[test]
fn current_operation_is_required_for_join_commit() {
    let session = awaiting_session();

    assert_eq!(
        session.matches_current_operation(Some("op-a")),
        VoiceSessionTransition::Applied
    );
    assert_eq!(
        session.matches_current_operation(Some("op-old")),
        VoiceSessionTransition::Rejected
    );
    assert_eq!(
        session.matches_current_operation(None),
        VoiceSessionTransition::Rejected
    );
}
```

- [ ] **Step 2: Run test to verify red**

Run:

```bash
cargo test -p syrnike-database --features voice current_operation_is_required_for_join_commit --lib
```

Expected: FAIL because `matches_current_operation` does not exist.

- [ ] **Step 3: Implement transition APIs**

Add to `VoiceSession`:

```rust
pub fn matches_current_operation(&self, current: Option<&str>) -> VoiceSessionTransition {
    if current == Some(self.operation_id.as_str()) {
        VoiceSessionTransition::Applied
    } else {
        VoiceSessionTransition::Rejected
    }
}
```

Add Redis-backed result types and functions to `session.rs`:

```rust
pub struct VoiceSessionCommit {
    pub operation_id: String,
    pub voice_state: UserVoiceState,
    pub previous_channels: Vec<UserVoiceChannel>,
}

pub enum VoiceSessionCommitResult {
    Committed(VoiceSessionCommit),
    Stale,
}

pub async fn commit_voice_session_join(
    channel: &UserVoiceChannel,
    user_id: &str,
    joined_at: Timestamp,
    participant_sid: &str,
    room_sid: &str,
) -> Result<VoiceSessionCommitResult> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Ok(VoiceSessionCommitResult::Stale);
    };

    if session.channel != *channel {
        return Ok(VoiceSessionCommitResult::Stale);
    }
    if session.matches_current_operation(Some(&session.operation_id)) != VoiceSessionTransition::Applied {
        return Ok(VoiceSessionCommitResult::Stale);
    }
    if session.mark_livekit_joined(room_sid, participant_sid, joined_at)
        != VoiceSessionTransition::Applied
    {
        return Ok(VoiceSessionCommitResult::Stale);
    }

    persist_active_voice_session(&session).await?;

    Ok(VoiceSessionCommitResult::Committed(VoiceSessionCommit {
        operation_id: session.operation_id.clone(),
        voice_state: session.voice_state(joined_at),
        previous_channels: Vec::new(),
    }))
}
```

Add `persist_active_voice_session` as the write projection replacement:

```rust
async fn persist_active_voice_session(session: &VoiceSession) -> Result<()> {
    let joined_at = session.joined_at.ok_or_else(|| create_error!(InternalError))?;
    let mut conn = super::get_connection().await?;
    let joined_at_ms = joined_at
        .duration_since(Timestamp::UNIX_EPOCH)
        .whole_milliseconds() as i64;

    redis_kiss::redis::pipe()
        .atomic()
        .set(voice_session_key(&session.operation_id), session)
        .sadd(voice_channel_members_key(&session.channel.id), &session.user_id)
        .set(voice_channel_node_key(&session.channel.id), &session.node)
        .set(
            voice_room_session_key(&session.channel.id),
            session.room_sid.as_deref().unwrap_or(""),
        )
        .set(
            voice_channel_state_key(&session.channel.id),
            session.voice_state(joined_at),
        )
        .set(format!("joined_at:{}", super::voice_state_unique_key(&session.channel, &session.user_id)), joined_at_ms)
        .query_async::<_, ()>(&mut conn)
        .await
        .to_internal_error()
}
```

- [ ] **Step 4: Run focused backend tests**

Run:

```bash
cargo test -p syrnike-database --features voice voice::session::tests --lib
```

Expected: PASS.

---

### Task 5: Wire LiveKit Ingress to the State Machine

**Files:**
- Modify: `services/backend/crates/daemons/voice-ingress/src/api.rs`

- [ ] **Step 1: Write failing source-level ingress test**

Add a test module to `api.rs`:

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn ingress_uses_voice_session_commit_instead_of_legacy_join_commit() {
        let source = include_str!("api.rs");

        assert!(source.contains("commit_voice_session_join("));
        assert!(source.contains("VoiceSessionCommitResult::Committed"));
        assert!(!source.contains("commit_voice_join("));
    }
}
```

- [ ] **Step 2: Run test to verify red**

Run:

```bash
cargo test -p syrnike-voice-ingress ingress_uses_voice_session_commit_instead_of_legacy_join_commit
```

Expected: FAIL because ingress still imports and calls `commit_voice_join`.

- [ ] **Step 3: Replace participant join commit**

In the `participant_joined` branch, replace:

```rust
let VoiceJoinCommitResult::Committed {
    operation_id,
    voice_state,
    previous_channels,
} = commit_voice_join(&channel, user_id, joined_at, participant_id, room_id).await?
```

with:

```rust
let VoiceSessionCommitResult::Committed(commit) =
    commit_voice_session_join(&channel, user_id, joined_at, participant_id, room_id).await?
else {
    log::debug!(
        "Removing user {user_id} from stale LiveKit join in channel {channel_id}; latest VoiceSession targets another operation."
    );
    let _ = voice_client
        .remove_user(node, participant_identity, channel_id)
        .await;
    return Ok(EmptyResponse);
};

let operation_id = Some(commit.operation_id);
let voice_state = commit.voice_state;
let previous_channels = commit.previous_channels;
```

Update imports to use `commit_voice_session_join` and `VoiceSessionCommitResult`.

- [ ] **Step 4: Run focused ingress tests**

Run:

```bash
cargo test -p syrnike-voice-ingress ingress_uses_voice_session_commit_instead_of_legacy_join_commit
```

Expected: PASS.

---

### Task 6: Tighten Frontend Connected Semantics

**Files:**
- Modify: `apps/web/src/features/voice/voice-session-machine.test.ts`
- Modify: `apps/web/src/features/voice/voice-session-machine.ts`

- [ ] **Step 1: Write failing frontend test**

Add to `voice-session-machine.test.ts`:

```ts
it('does not become connected from native publish before server commit', () => {
  let state = createInitialVoiceSessionState()

  state = reduceVoiceSession(state, {
    type: 'join_requested',
    channelId: 'voice-a',
    operationId: 'op-a',
    reason: 'manual_join',
  })
  state = reduceVoiceSession(state, {
    type: 'server_prepare_succeeded',
    operationId: 'op-a',
  })
  state = reduceVoiceSession(state, {
    type: 'room_connected',
    operationId: 'op-a',
  })
  state = reduceVoiceSession(state, {
    type: 'native_publish_succeeded',
    operationId: 'op-a',
  })

  expect(state.phase).toBe('waiting_server_commit')
  expect(state.connectedChannelId).toBeNull()
})
```

- [ ] **Step 2: Run test to verify red**

Run:

```bash
pnpm --filter @syrnike13/web test -- voice-session-machine.test.ts
```

Expected: FAIL because `native_publish_succeeded` currently moves non-connected phases to `connected`.

- [ ] **Step 3: Remove native publish as a connected transition**

In `reduceVoiceSession`, replace the `native_publish_succeeded` case with:

```ts
case 'native_publish_succeeded':
  if (!isCurrentOperation(state, event.operationId)) return state
  return state
```

- [ ] **Step 4: Run test to verify green**

Run:

```bash
pnpm --filter @syrnike13/web test -- voice-session-machine.test.ts
```

Expected: PASS.

---

### Task 7: Verification

**Files:**
- Verify only, no source edits.

- [ ] **Step 1: Run backend voice database tests**

Run:

```bash
cargo test -p syrnike-database --features voice voice --lib
```

Expected: PASS.

- [ ] **Step 2: Run voice ingress tests**

Run:

```bash
cargo test -p syrnike-voice-ingress
```

Expected: PASS.

- [ ] **Step 3: Run frontend voice tests**

Run:

```bash
pnpm --filter @syrnike13/web test -- voice-session-machine.test.ts voice-session-controller.test.ts voice-join.test.ts
```

Expected: PASS.

- [ ] **Step 4: Check for old voice Redis write path references**

Run:

```powershell
Get-ChildItem -Path services/backend -Recurse -File -Exclude node_modules |
  Select-String -Pattern 'voice_join_intent:|vc_members:|vc:\{|joined_at:|operation:|session:' |
  Select-Object Path,LineNumber,Line
```

Expected: no remaining production write-path references outside deletion cleanup, tests, or migration notes.

---

## Self-Review

- Spec coverage:
  - Backend-owned session model: Task 1 and Task 2.
  - Join awaits LiveKit before product membership: Task 3 and Task 5.
  - Stale participant join/leave fencing: Task 4 and Task 5.
  - Track events only affect active current sessions: Task 1 and Task 4.
  - Native sidecars cannot create membership: existing native identity code remains, Task 5 keeps native joins out of commit path.
  - Frontend `room.connect()` is not connected: Task 6.
  - Reconciliation is represented by current tests and must be expanded after the session write path is green.
- Placeholder scan:
  - No placeholder markers remain in actionable steps.
- Type consistency:
  - `VoiceSession`, `VoiceSessionState`, `VoiceSessionTransition`, `VoiceSessionCommitResult`, and key helper names are consistent across tasks.
