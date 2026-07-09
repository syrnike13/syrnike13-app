use iso8601_timestamp::{Duration, Timestamp};
use redis_kiss::{
    redis::{cmd, Cmd, FromRedisValue, RedisError, RedisWrite, ToRedisArgs, Value},
    AsyncCommands,
};
use serde::{Deserialize, Serialize};
use syrnike_models::v0::UserVoiceState;
use syrnike_result::{create_error, Result, ToSyrnikeError};

use super::{partial_voice_state_for_track, UserVoiceChannel};

pub const VOICE_SESSION_TTL_SECONDS: usize = 120;
pub const VOICE_MEMBERSHIP_TTL_SECONDS: usize = 30;

pub fn voice_session_key(operation_id: &str) -> String {
    format!("voice_session:{operation_id}")
}

pub fn voice_current_key(user_id: &str) -> String {
    format!("voice_current:{user_id}")
}

pub fn voice_channel_members_key(channel_id: &str) -> String {
    format!("voice_channel_members:{channel_id}")
}

pub fn voice_channel_node_key(channel_id: &str) -> String {
    format!("voice_channel_node:{channel_id}")
}

pub fn voice_room_session_key(channel_id: &str) -> String {
    format!("voice_room_session:{channel_id}")
}

pub fn voice_active_channels_key() -> &'static str {
    "voice_active_channels"
}

const CREATE_VOICE_SESSION: &str = r#"
local previous = redis.call('GET', KEYS[2])
local raw_session = ARGV[1]
if previous ~= false and previous ~= ARGV[2] then
  local replaces_operation_id = previous
  local previous_raw = redis.call('GET', 'voice_session:' .. previous)
  if previous_raw ~= false then
    local previous_ok, previous_session = pcall(cjson.decode, previous_raw)
    if previous_ok
      and type(previous_session) == 'table'
      and previous_session.state == 'awaiting_livekit_join'
      and type(previous_session.replaces_operation_id) == 'string'
      and previous_session.replaces_operation_id ~= ''
    then
      replaces_operation_id = previous_session.replaces_operation_id
    end
  end

  local ok, session = pcall(cjson.decode, raw_session)
  if ok and type(session) == 'table' then
    session.replaces_operation_id = replaces_operation_id
    raw_session = cjson.encode(session)
  end
end

redis.call('SETEX', KEYS[1], tonumber(ARGV[3]), raw_session)
redis.call('SET', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
"#;

const SAVE_CURRENT_VOICE_SESSION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

redis.call('SETEX', KEYS[2], tonumber(ARGV[3]), ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
"#;

const COMMIT_VOICE_SESSION_JOIN: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

local current_node = redis.call('GET', KEYS[5])
if current_node == false or current_node ~= ARGV[5] then
  return 0
end

redis.call('SETEX', KEYS[2], tonumber(ARGV[7]), ARGV[2])
redis.call('SADD', KEYS[3], ARGV[3])
redis.call('SADD', KEYS[4], ARGV[4])
redis.call('SET', KEYS[5], ARGV[5])
if ARGV[6] ~= '' then
  redis.call('SET', KEYS[6], ARGV[6])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[8]))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[8]))
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[8]))
redis.call('EXPIRE', KEYS[5], tonumber(ARGV[8]))
if ARGV[6] ~= '' then
  redis.call('EXPIRE', KEYS[6], tonumber(ARGV[8]))
end

return 1
"#;

const DELETE_CURRENT_VOICE_SESSION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

redis.call('SREM', KEYS[3], ARGV[2])
if redis.call('SCARD', KEYS[3]) == 0 then
  redis.call('SREM', KEYS[4], ARGV[3])
  redis.call('DEL', KEYS[5])
  redis.call('DEL', KEYS[6])
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
"#;

const REMOVE_ACTIVE_VOICE_SESSION_PROJECTION: &str = r#"
redis.call('SETEX', KEYS[1], tonumber(ARGV[4]), ARGV[1])
redis.call('SREM', KEYS[2], ARGV[2])
if redis.call('SCARD', KEYS[2]) == 0 then
  redis.call('SREM', KEYS[3], ARGV[3])
  redis.call('DEL', KEYS[4])
  redis.call('DEL', KEYS[5])
end
return 1
"#;

const REPLACE_CURRENT_VOICE_SESSION_OPERATION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

redis.call('SETEX', KEYS[2], tonumber(ARGV[4]), ARGV[2])
redis.call('SET', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('DEL', KEYS[3])
return 1
"#;

const REFRESH_ACTIVE_VOICE_SESSION_PROJECTION: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[3] then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
redis.call('SETEX', KEYS[3], tonumber(ARGV[2]), ARGV[8])
redis.call('SETEX', KEYS[4], tonumber(ARGV[1]), ARGV[5])
if ARGV[6] ~= '' then
  redis.call('SETEX', KEYS[5], tonumber(ARGV[1]), ARGV[6])
end
redis.call('SADD', KEYS[6], ARGV[7])
redis.call('EXPIRE', KEYS[6], tonumber(ARGV[1]))
return 1
"#;

const REMOVE_ORPHANED_ACTIVE_VOICE_CHANNEL: &str = r#"
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
return 1
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceSessionState {
    AwaitingLivekitJoin,
    Active,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceSession {
    pub operation_id: String,
    pub replaces_operation_id: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceSessionCommit {
    pub operation_id: String,
    pub voice_state: UserVoiceState,
    pub previous_channels: Vec<UserVoiceChannel>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceSessionCommitResult {
    Committed(VoiceSessionCommit),
    Stale,
}

impl VoiceSession {
    pub fn new_awaiting_join(input: VoiceSessionCreate) -> Self {
        Self {
            operation_id: input.operation_id,
            replaces_operation_id: None,
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

async fn run_eval<T>(
    script: &'static str,
    num_keys: usize,
    append_args: impl FnOnce(&mut Cmd),
) -> Result<T>
where
    T: FromRedisValue,
{
    let mut command = cmd("EVAL");
    command.arg(script).arg(num_keys);
    append_args(&mut command);
    command
        .query_async(&mut super::get_connection().await?.into_inner())
        .await
        .to_internal_error()
}

pub async fn create_voice_session(session: &VoiceSession) -> Result<()> {
    let raw_session = serde_json::to_string(session).to_internal_error()?;
    run_eval(CREATE_VOICE_SESSION, 2, |command| {
        command
            .arg(voice_session_key(&session.operation_id))
            .arg(voice_current_key(&session.user_id))
            .arg(raw_session)
            .arg(&session.operation_id)
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(VOICE_SESSION_TTL_SECONDS);
    })
    .await
}

pub async fn save_current_voice_session(session: &VoiceSession) -> Result<bool> {
    let saved: i64 = run_eval(SAVE_CURRENT_VOICE_SESSION, 2, |command| {
        command
            .arg(voice_current_key(&session.user_id))
            .arg(voice_session_key(&session.operation_id))
            .arg(&session.operation_id)
            .arg(session)
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(VOICE_MEMBERSHIP_TTL_SECONDS);
    })
    .await?;

    Ok(saved == 1)
}

pub async fn replace_current_voice_session_operation(
    previous_operation_id: &str,
    session: &VoiceSession,
) -> Result<bool> {
    let replaced: i64 = run_eval(REPLACE_CURRENT_VOICE_SESSION_OPERATION, 3, |command| {
        command
            .arg(voice_current_key(&session.user_id))
            .arg(voice_session_key(&session.operation_id))
            .arg(voice_session_key(previous_operation_id))
            .arg(previous_operation_id)
            .arg(session)
            .arg(&session.operation_id)
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(VOICE_MEMBERSHIP_TTL_SECONDS);
    })
    .await?;

    Ok(replaced == 1)
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

pub async fn get_replaced_active_voice_session(
    session: &VoiceSession,
) -> Result<Option<VoiceSession>> {
    if session.state != VoiceSessionState::AwaitingLivekitJoin {
        return Ok(None);
    }

    let Some(previous_operation_id) = session.replaces_operation_id.as_deref() else {
        return Ok(None);
    };

    Ok(get_voice_session(previous_operation_id)
        .await?
        .filter(|previous| {
            previous.user_id == session.user_id
                && previous.operation_id != session.operation_id
                && previous.state == VoiceSessionState::Active
        }))
}

pub async fn get_active_voice_session_for_user(user_id: &str) -> Result<Option<VoiceSession>> {
    let Some(session) = get_current_voice_session(user_id).await? else {
        return Ok(None);
    };

    if session.state == VoiceSessionState::Active {
        return Ok(Some(session));
    }

    get_replaced_active_voice_session(&session).await
}

async fn persist_active_voice_session_if_current(session: &VoiceSession) -> Result<bool> {
    let committed: i64 = run_eval(COMMIT_VOICE_SESSION_JOIN, 6, |command| {
        command
            .arg(voice_current_key(&session.user_id))
            .arg(voice_session_key(&session.operation_id))
            .arg(voice_active_channels_key())
            .arg(voice_channel_members_key(&session.channel.id))
            .arg(voice_channel_node_key(&session.channel.id))
            .arg(voice_room_session_key(&session.channel.id))
            .arg(&session.operation_id)
            .arg(session)
            .arg(&session.channel.id)
            .arg(&session.user_id)
            .arg(&session.node)
            .arg(session.room_sid.as_deref().unwrap_or(""))
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(VOICE_MEMBERSHIP_TTL_SECONDS);
    })
    .await?;

    Ok(committed == 1)
}

pub(super) async fn remove_active_voice_session_projection(session: &VoiceSession) -> Result<()> {
    run_eval(REMOVE_ACTIVE_VOICE_SESSION_PROJECTION, 5, |command| {
        command
            .arg(voice_session_key(&session.operation_id))
            .arg(voice_channel_members_key(&session.channel.id))
            .arg(voice_active_channels_key())
            .arg(voice_channel_node_key(&session.channel.id))
            .arg(voice_room_session_key(&session.channel.id))
            .arg(session)
            .arg(&session.user_id)
            .arg(&session.channel.id)
            .arg(VOICE_SESSION_TTL_SECONDS);
    })
    .await
}

pub async fn list_active_voice_channel_ids() -> Result<Vec<String>> {
    super::get_connection()
        .await?
        .smembers(voice_active_channels_key())
        .await
        .to_internal_error()
}

pub async fn delete_current_voice_session(session: &VoiceSession) -> Result<bool> {
    let deleted: i64 = run_eval(DELETE_CURRENT_VOICE_SESSION, 6, |command| {
        command
            .arg(voice_current_key(&session.user_id))
            .arg(voice_session_key(&session.operation_id))
            .arg(voice_channel_members_key(&session.channel.id))
            .arg(voice_active_channels_key())
            .arg(voice_channel_node_key(&session.channel.id))
            .arg(voice_room_session_key(&session.channel.id))
            .arg(&session.operation_id)
            .arg(&session.user_id)
            .arg(&session.channel.id);
    })
    .await?;

    Ok(deleted == 1)
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

    if session.channel.id != channel.id
        || session.mark_livekit_joined(room_sid, participant_sid, joined_at)
            != VoiceSessionTransition::Applied
    {
        return Ok(VoiceSessionCommitResult::Stale);
    }
    session.expires_at = joined_at
        .checked_add(Duration::seconds(VOICE_SESSION_TTL_SECONDS as i64))
        .ok_or_else(|| create_error!(InternalError))?;

    if !persist_active_voice_session_if_current(&session).await? {
        return Ok(VoiceSessionCommitResult::Stale);
    }

    let mut previous_channels = Vec::new();
    if let Some(previous_operation_id) = session.replaces_operation_id.as_deref() {
        if let Some(mut previous_session) = get_voice_session(previous_operation_id).await? {
            if previous_session.state == VoiceSessionState::Active
                && previous_session.user_id == session.user_id
                && previous_session.operation_id != session.operation_id
            {
                previous_channels.push(previous_session.channel.clone());
                previous_session.state = VoiceSessionState::Ended;
                previous_session.updated_at = joined_at;
                remove_active_voice_session_projection(&previous_session).await?;
            }
        }
    }

    Ok(VoiceSessionCommitResult::Committed(VoiceSessionCommit {
        operation_id: session.operation_id.clone(),
        voice_state: session.voice_state(joined_at),
        previous_channels,
    }))
}

pub(super) async fn refresh_active_voice_session_projection_ttl(
    session: &VoiceSession,
) -> Result<()> {
    run_eval(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION, 6, |command| {
        command
            .arg(voice_current_key(&session.user_id))
            .arg(voice_channel_members_key(&session.channel.id))
            .arg(voice_session_key(&session.operation_id))
            .arg(voice_channel_node_key(&session.channel.id))
            .arg(voice_room_session_key(&session.channel.id))
            .arg(voice_active_channels_key())
            .arg(VOICE_MEMBERSHIP_TTL_SECONDS)
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(&session.operation_id)
            .arg(&session.user_id)
            .arg(&session.node)
            .arg(session.room_sid.as_deref().unwrap_or_default())
            .arg(&session.channel.id)
            .arg(session);
    })
    .await
}

pub async fn remove_orphaned_active_voice_channel(channel: &UserVoiceChannel) -> Result<()> {
    run_eval(REMOVE_ORPHANED_ACTIVE_VOICE_CHANNEL, 4, |command| {
        command
            .arg(voice_active_channels_key())
            .arg(voice_channel_node_key(&channel.id))
            .arg(voice_room_session_key(&channel.id))
            .arg(voice_channel_members_key(&channel.id))
            .arg(&channel.id);
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use iso8601_timestamp::Timestamp;

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
            Timestamp::UNIX_EPOCH
                .checked_add(Duration::seconds(5))
                .unwrap(),
        );

        assert_eq!(result, VoiceSessionTransition::Applied);
        assert_eq!(session.state, VoiceSessionState::Active);
        assert_eq!(session.room_sid.as_deref(), Some("room-a"));
        assert_eq!(session.participant_sid.as_deref(), Some("participant-a"));
        assert_eq!(
            session.joined_at,
            Some(
                Timestamp::UNIX_EPOCH
                    .checked_add(Duration::seconds(5))
                    .unwrap()
            )
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

        assert_eq!(
            session.set_track_state(true, 3),
            VoiceSessionTransition::Rejected
        );

        session.mark_livekit_joined("room-a", "participant-a", Timestamp::UNIX_EPOCH);

        assert_eq!(
            session.set_track_state(true, 3),
            VoiceSessionTransition::Applied
        );
        assert_eq!(session.screensharing, true);
        assert_eq!(session.camera, false);

        assert_eq!(
            session.set_track_state(true, 1),
            VoiceSessionTransition::Applied
        );
        assert_eq!(session.camera, true);

        assert_eq!(
            session.set_track_state(false, 2),
            VoiceSessionTransition::Noop
        );
        assert_eq!(session.screensharing, true);
        assert_eq!(session.camera, true);
    }

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

    #[test]
    fn pending_voice_session_lease_outlives_active_projection_lease() {
        assert!(VOICE_SESSION_TTL_SECONDS > VOICE_MEMBERSHIP_TTL_SECONDS);
    }

    #[test]
    fn redis_commit_script_fences_against_current_operation() {
        assert!(COMMIT_VOICE_SESSION_JOIN.contains("redis.call('GET', KEYS[1]) ~= ARGV[1]"));
        assert!(COMMIT_VOICE_SESSION_JOIN.contains("current_node == false"));
        assert!(COMMIT_VOICE_SESSION_JOIN.contains("redis.call('SADD', KEYS[4], ARGV[4])"));
    }

    #[test]
    fn redis_create_script_carries_replaced_active_session_through_pending_chain() {
        assert!(CREATE_VOICE_SESSION.contains("previous_session.state == 'awaiting_livekit_join'"));
        assert!(CREATE_VOICE_SESSION
            .contains("replaces_operation_id = previous_session.replaces_operation_id"));
    }

    #[test]
    fn redis_delete_and_save_scripts_fence_against_current_operation() {
        assert!(SAVE_CURRENT_VOICE_SESSION.contains("redis.call('GET', KEYS[1]) ~= ARGV[1]"));
        assert!(DELETE_CURRENT_VOICE_SESSION.contains("redis.call('GET', KEYS[1]) ~= ARGV[1]"));
        assert!(DELETE_CURRENT_VOICE_SESSION.contains("redis.call('SCARD', KEYS[3]) == 0"));
        assert!(
            REMOVE_ACTIVE_VOICE_SESSION_PROJECTION.contains("redis.call('SREM', KEYS[3], ARGV[3])")
        );
        assert!(REPLACE_CURRENT_VOICE_SESSION_OPERATION
            .contains("redis.call('GET', KEYS[1]) ~= ARGV[1]"));
    }

    #[test]
    fn redis_voice_membership_scripts_keep_ttl_on_live_state() {
        assert!(CREATE_VOICE_SESSION.contains("redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))"));
        assert!(SAVE_CURRENT_VOICE_SESSION
            .contains("redis.call('SETEX', KEYS[2], tonumber(ARGV[3]), ARGV[2])"));
        assert!(
            SAVE_CURRENT_VOICE_SESSION.contains("redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))")
        );
        assert!(COMMIT_VOICE_SESSION_JOIN
            .contains("redis.call('SETEX', KEYS[2], tonumber(ARGV[7]), ARGV[2])"));
        assert!(
            COMMIT_VOICE_SESSION_JOIN.contains("redis.call('EXPIRE', KEYS[1], tonumber(ARGV[8]))")
        );
        assert!(
            COMMIT_VOICE_SESSION_JOIN.contains("redis.call('EXPIRE', KEYS[3], tonumber(ARGV[8]))")
        );
        assert!(
            COMMIT_VOICE_SESSION_JOIN.contains("redis.call('EXPIRE', KEYS[4], tonumber(ARGV[8]))")
        );
        assert!(
            COMMIT_VOICE_SESSION_JOIN.contains("redis.call('EXPIRE', KEYS[5], tonumber(ARGV[8]))")
        );
        assert!(
            COMMIT_VOICE_SESSION_JOIN.contains("redis.call('EXPIRE', KEYS[6], tonumber(ARGV[8]))")
        );
        assert!(REPLACE_CURRENT_VOICE_SESSION_OPERATION
            .contains("redis.call('SETEX', KEYS[2], tonumber(ARGV[4]), ARGV[2])"));
        assert!(REPLACE_CURRENT_VOICE_SESSION_OPERATION
            .contains("redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))"));
    }

    #[test]
    fn redis_voice_heartbeat_scripts_refresh_ttl_and_clean_orphan_active_channels() {
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('GET', KEYS[1]) == ARGV[3]"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('SADD', KEYS[2], ARGV[4])"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('SETEX', KEYS[3], tonumber(ARGV[2]), ARGV[8])"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('SETEX', KEYS[4], tonumber(ARGV[1]), ARGV[5])"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('SETEX', KEYS[5], tonumber(ARGV[1]), ARGV[6])"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('SADD', KEYS[6], ARGV[7])"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("redis.call('EXPIRE', KEYS[6], tonumber(ARGV[1]))"));
        assert!(
            REMOVE_ORPHANED_ACTIVE_VOICE_CHANNEL.contains("redis.call('SREM', KEYS[1], ARGV[1])")
        );
        assert!(REMOVE_ORPHANED_ACTIVE_VOICE_CHANNEL
            .contains("redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])"));
    }
}
