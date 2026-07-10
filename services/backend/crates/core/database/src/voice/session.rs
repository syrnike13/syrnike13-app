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
pub const VOICE_TRANSPORT_CLEANUP_TTL_SECONDS: usize = 7 * 24 * 60 * 60;
const VOICE_RESERVATION_COMMIT_RETRY_LIMIT: usize = 8;
const VOICE_RESERVATION_MUTATION_RETRY_LIMIT: usize = 8;

pub fn voice_session_key(operation_id: &str) -> String {
    format!("voice_session:{operation_id}")
}

pub fn voice_current_key(user_id: &str) -> String {
    format!("voice_current:{user_id}")
}

pub fn voice_reservation_key(operation_id: &str) -> String {
    format!("voice_reservation:{operation_id}")
}

pub fn voice_reservation_current_key(user_id: &str) -> String {
    format!("voice_reservation_current:{user_id}")
}

pub fn voice_channel_reservations_key(channel_id: &str) -> String {
    format!("voice_channel_reservations:{channel_id}")
}

pub fn voice_retain_receipt_key(
    retained_operation_id: &str,
    canceled_operation_id: &str,
) -> String {
    format!("voice_retain_receipt:{retained_operation_id}:{canceled_operation_id}")
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

pub fn voice_transport_cleanup_key(operation_id: &str) -> String {
    format!("voice_transport_cleanup:{operation_id}")
}

pub fn voice_transport_cleanups_key() -> &'static str {
    "voice_transport_cleanups"
}

const PREPARE_VOICE_RESERVATION: &str = r#"
local reservation_current = redis.call('GET', KEYS[2])
local finalized_current = redis.call('GET', KEYS[3])
local expected_finalized = ARGV[5]
if expected_finalized ~= '' then
  if finalized_current ~= expected_finalized then
    return 0
  end
elseif finalized_current ~= false then
  return 0
end

if reservation_current == ARGV[3] then
  if ARGV[6] == '' or redis.call('GET', KEYS[1]) ~= ARGV[6] then
    return 0
  end
  redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), ARGV[1])
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
  if expected_finalized ~= '' then
    redis.call('EXPIRE', KEYS[3], tonumber(ARGV[2]))
    redis.call('EXPIRE', KEYS[4], tonumber(ARGV[2]))
  end
  redis.call('SADD', KEYS[7], ARGV[11])
  redis.call('EXPIRE', KEYS[7], tonumber(ARGV[2]))
  return 1
end
local authoritative = reservation_current
if authoritative == false then
  authoritative = finalized_current
end

local expected_control = ARGV[4]
if expected_control ~= '' then
  if authoritative ~= expected_control then
    return 0
  end
elseif authoritative ~= false then
  return 0
end

if ARGV[7] ~= '' then
  if reservation_current == false or redis.call('GET', KEYS[5]) ~= ARGV[7] then
    return 0
  end
  redis.call('SADD', KEYS[6], reservation_current)
  redis.call('SETEX', KEYS[9], tonumber(ARGV[9]), ARGV[12])
  if ARGV[8] ~= ARGV[10] then
    redis.call('SREM', KEYS[8], ARGV[11])
  end
end

redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), ARGV[1])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
if expected_finalized ~= '' then
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[2]))
  redis.call('EXPIRE', KEYS[4], tonumber(ARGV[2]))
end
redis.call('SADD', KEYS[7], ARGV[11])
redis.call('EXPIRE', KEYS[7], tonumber(ARGV[2]))
return 1
"#;

const DELETE_VOICE_RESERVATION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return 0
end

redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('SETEX', KEYS[5], tonumber(ARGV[5]), ARGV[6])
redis.call('SREM', KEYS[4], ARGV[4])
return 1
"#;

const SAVE_CURRENT_VOICE_SESSION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

if redis.call('GET', KEYS[2]) ~= ARGV[5] then
  return 0
end

redis.call('SETEX', KEYS[2], tonumber(ARGV[3]), ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
"#;

const SAVE_CURRENT_VOICE_RESERVATION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return 0
end

redis.call('SETEX', KEYS[2], tonumber(ARGV[4]), ARGV[3])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
"#;

const GET_CURRENT_VOICE_RECORD: &str = r#"
local operation_id = redis.call('GET', KEYS[1])
if operation_id == false then
  return false
end
return redis.call('GET', ARGV[1] .. operation_id)
"#;

const GET_VOICE_AUTHORITY_SNAPSHOT: &str = r#"
local function current_record(pointer_key, prefix)
  local operation_id = redis.call('GET', pointer_key)
  if operation_id == false then
    return ''
  end
  local raw = redis.call('GET', prefix .. operation_id)
  if raw == false then
    return ''
  end
  return raw
end

return {
  current_record(KEYS[1], ARGV[1]),
  current_record(KEYS[2], ARGV[2])
}
"#;

const COMMIT_VOICE_RESERVATION_JOIN: &str = r#"
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return 0
end

if redis.call('GET', KEYS[3]) ~= ARGV[2] then
  return 0
end

local current = redis.call('GET', KEYS[1])
local expected = ARGV[3]
if expected ~= '' then
  if current ~= expected then
    return 0
  end
elseif current ~= false then
  return 0
end

local current_node = redis.call('GET', KEYS[7])
if current_node == false or current_node ~= ARGV[4] then
  return 0
end

if ARGV[11] ~= '' and redis.call('GET', KEYS[9]) ~= ARGV[11] then
  return 0
end

redis.call('SETEX', KEYS[4], tonumber(ARGV[6]), ARGV[5])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
redis.call('SADD', KEYS[5], ARGV[8])
redis.call('SADD', KEYS[6], ARGV[9])
redis.call('SET', KEYS[7], ARGV[4])
if ARGV[10] ~= '' then
  redis.call('SET', KEYS[8], ARGV[10])
end
redis.call('EXPIRE', KEYS[5], tonumber(ARGV[7]))
redis.call('EXPIRE', KEYS[6], tonumber(ARGV[7]))
if ARGV[12] ~= '' then
  redis.call('SETEX', KEYS[9], tonumber(ARGV[6]), ARGV[12])
  redis.call('SADD', KEYS[12], ARGV[3])
  redis.call('SETEX', KEYS[13], tonumber(ARGV[16]), ARGV[15])
  if ARGV[14] ~= ARGV[8] then
    redis.call('SREM', KEYS[10], ARGV[13])
  end
end
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[11], ARGV[9])
return 1
"#;

const DELETE_CURRENT_VOICE_SESSION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

if redis.call('GET', KEYS[4]) ~= false then
  return 0
end

redis.call('SREM', KEYS[3], ARGV[2])
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('SADD', KEYS[5], ARGV[1])
redis.call('SETEX', KEYS[6], tonumber(ARGV[4]), ARGV[3])
return 1
"#;

const RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return 0
end

if redis.call('GET', KEYS[3]) ~= ARGV[3] then
  return 0
end

if redis.call('GET', KEYS[4]) ~= ARGV[4] then
  return 0
end

redis.call('DEL', KEYS[1])
redis.call('SETEX', KEYS[5], tonumber(ARGV[5]), ARGV[3])
redis.call('SADD', KEYS[6], ARGV[1])
redis.call('SETEX', KEYS[8], tonumber(ARGV[8]), ARGV[9])
redis.call('SREM', KEYS[7], ARGV[7])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[5]))
return 1
"#;

const CONFIRM_RETAINED_VOICE_SESSION: &str = r#"
if redis.call('GET', KEYS[1]) ~= false then
  return 0
end

if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return 0
end

if redis.call('GET', KEYS[3]) ~= ARGV[2] then
  return 0
end

if redis.call('GET', KEYS[4]) ~= ARGV[3] then
  return 0
end

return 1
"#;

const REFRESH_ACTIVE_VOICE_SESSION_PROJECTION: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[3] then
  return 0
end

if redis.call('GET', KEYS[3]) ~= ARGV[8] then
  return 0
end

redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
redis.call('SETEX', KEYS[3], tonumber(ARGV[2]), ARGV[9])
redis.call('SET', KEYS[4], ARGV[5])
if ARGV[6] ~= '' then
  redis.call('SET', KEYS[5], ARGV[6])
end
redis.call('SADD', KEYS[6], ARGV[7])
redis.call('EXPIRE', KEYS[6], tonumber(ARGV[1]))
return 1
"#;

const REMOVE_ORPHANED_ACTIVE_VOICE_CHANNEL: &str = r#"
if redis.call('SCARD', KEYS[4]) ~= 0 then
  return 0
end
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
return 1
"#;

const DELETE_VOICE_CHANNEL_PROJECTION_FOR_ROOM: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if redis.call('SCARD', KEYS[5]) ~= 0 then
  return 0
end

redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[3], ARGV[2])
redis.call('DEL', KEYS[4])
return 1
"#;

const COMPLETE_VOICE_TRANSPORT_CLEANUP: &str = r#"
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return 0
end
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[1], ARGV[1])
return 1
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceSessionState {
    AwaitingLivekitJoin,
    Active,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceReservationState {
    Prepared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceReservation {
    pub operation_id: String,
    pub user_id: String,
    pub channel: UserVoiceChannel,
    pub node: String,
    pub expected_current_operation_id: Option<String>,
    pub expected_finalized_operation_id: Option<String>,
    pub state: VoiceReservationState,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub screensharing: bool,
    pub camera: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub expires_at: Timestamp,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceTransportCleanup {
    pub operation_id: String,
    pub user_id: String,
    pub channel: UserVoiceChannel,
    pub node: String,
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
    pub retired_sessions: Vec<VoiceSession>,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceSessionCommitResult {
    Committed(VoiceSessionCommit),
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceAuthoritySnapshot {
    pub reservation: Option<VoiceReservation>,
    pub session: Option<VoiceSession>,
}

impl VoiceReservation {
    pub fn from_pending_session(
        session: &VoiceSession,
        expected_current_operation_id: Option<String>,
        expected_finalized_operation_id: Option<String>,
    ) -> Self {
        Self {
            operation_id: session.operation_id.clone(),
            user_id: session.user_id.clone(),
            channel: session.channel.clone(),
            node: session.node.clone(),
            expected_current_operation_id,
            expected_finalized_operation_id,
            state: VoiceReservationState::Prepared,
            self_mute: session.self_mute,
            self_deaf: session.self_deaf,
            screensharing: session.screensharing,
            camera: session.camera,
            created_at: session.created_at,
            updated_at: session.updated_at,
            expires_at: session.expires_at,
        }
    }

    pub fn awaiting_session(&self) -> VoiceSession {
        VoiceSession {
            operation_id: self.operation_id.clone(),
            replaces_operation_id: self.expected_finalized_operation_id.clone(),
            user_id: self.user_id.clone(),
            channel: self.channel.clone(),
            node: self.node.clone(),
            room_sid: None,
            participant_sid: None,
            state: VoiceSessionState::AwaitingLivekitJoin,
            self_mute: self.self_mute,
            self_deaf: self.self_deaf,
            server_muted: false,
            server_deafened: false,
            screensharing: self.screensharing,
            camera: self.camera,
            version: 1,
            joined_at: None,
            created_at: self.created_at,
            updated_at: self.updated_at,
            expires_at: self.expires_at,
            failure_reason: None,
        }
    }

    pub fn set_track_state(&mut self, added: bool, track_source: i32) -> VoiceSessionTransition {
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
            VoiceSessionTransition::Applied
        } else {
            VoiceSessionTransition::Noop
        }
    }
}

impl From<&VoiceReservation> for VoiceTransportCleanup {
    fn from(reservation: &VoiceReservation) -> Self {
        Self {
            operation_id: reservation.operation_id.clone(),
            user_id: reservation.user_id.clone(),
            channel: reservation.channel.clone(),
            node: reservation.node.clone(),
        }
    }
}

impl From<&VoiceSession> for VoiceTransportCleanup {
    fn from(session: &VoiceSession) -> Self {
        Self {
            operation_id: session.operation_id.clone(),
            user_id: session.user_id.clone(),
            channel: session.channel.clone(),
            node: session.node.clone(),
        }
    }
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

impl ToRedisArgs for VoiceReservation {
    fn write_redis_args<W: ?Sized + RedisWrite>(&self, out: &mut W) {
        out.write_arg(
            serde_json::to_string(self)
                .expect("VoiceReservation serializes to JSON")
                .as_bytes(),
        );
    }
}

impl FromRedisValue for VoiceReservation {
    fn from_redis_value(v: &Value) -> std::result::Result<Self, RedisError> {
        let raw = String::from_redis_value(v)?;
        serde_json::from_str(&raw).map_err(|error| {
            RedisError::from((
                redis_kiss::redis::ErrorKind::TypeError,
                "VoiceReservation",
                error.to_string(),
            ))
        })
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

impl ToRedisArgs for VoiceTransportCleanup {
    fn write_redis_args<W: ?Sized + RedisWrite>(&self, out: &mut W) {
        out.write_arg(
            serde_json::to_string(self)
                .expect("VoiceTransportCleanup serializes to JSON")
                .as_bytes(),
        );
    }
}

impl FromRedisValue for VoiceTransportCleanup {
    fn from_redis_value(v: &Value) -> std::result::Result<Self, RedisError> {
        let raw = String::from_redis_value(v)?;
        serde_json::from_str(&raw).map_err(|error| {
            RedisError::from((
                redis_kiss::redis::ErrorKind::TypeError,
                "VoiceTransportCleanup",
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
    let expected_current_operation_id =
        match get_current_voice_reservation(&session.user_id).await? {
            Some(current) => Some(current.operation_id),
            None => get_current_voice_session(&session.user_id)
                .await?
                .map(|current| current.operation_id),
        };
    create_voice_session_if_current(session, expected_current_operation_id.as_deref())
        .await?
        .then_some(())
        .ok_or_else(|| create_error!(InvalidOperation))
}

pub async fn create_voice_session_if_current(
    session: &VoiceSession,
    expected_current_operation_id: Option<&str>,
) -> Result<bool> {
    for _ in 0..VOICE_RESERVATION_MUTATION_RETRY_LIMIT {
        let authority = get_voice_authority_snapshot(&session.user_id).await?;
        let current_reservation = authority.reservation;
        let current_session = authority.session;
        let idempotent_reservation = match current_reservation.as_ref() {
            Some(current) if current.operation_id == session.operation_id => {
                if current.user_id != session.user_id
                    || current.channel != session.channel
                    || current.node != session.node
                    || current.expected_current_operation_id.as_deref()
                        != expected_current_operation_id
                {
                    return Ok(false);
                }
                Some(current)
            }
            _ => None,
        };
        let idempotent_reservation_raw = idempotent_reservation
            .map(serde_json::to_string)
            .transpose()
            .to_internal_error()?;
        let authoritative_operation_id = current_reservation
            .as_ref()
            .map(|reservation| reservation.operation_id.as_str())
            .or_else(|| {
                current_session
                    .as_ref()
                    .map(|session| session.operation_id.as_str())
            });

        if idempotent_reservation_raw.is_none()
            && authoritative_operation_id != expected_current_operation_id
        {
            return Ok(false);
        }

        let expected_finalized_operation_id = current_reservation
            .as_ref()
            .map(|current| current.expected_finalized_operation_id.clone())
            .unwrap_or_else(|| {
                current_session
                    .as_ref()
                    .map(|session| session.operation_id.clone())
            });
        let mut reservation = VoiceReservation::from_pending_session(
            session,
            expected_current_operation_id.map(ToString::to_string),
            expected_finalized_operation_id,
        );
        if let Some(current) = idempotent_reservation {
            reservation.created_at = current.created_at;
            reservation.screensharing = current.screensharing;
            reservation.camera = current.camera;
        }
        let raw_reservation = serde_json::to_string(&reservation).to_internal_error()?;
        let finalized_session_key = voice_session_key(
            reservation
                .expected_finalized_operation_id
                .as_deref()
                .unwrap_or(&reservation.operation_id),
        );
        let superseded_reservation = current_reservation
            .as_ref()
            .filter(|current| current.operation_id != reservation.operation_id);
        let superseded_reservation_raw = superseded_reservation
            .map(serde_json::to_string)
            .transpose()
            .to_internal_error()?;
        let superseded_cleanup_raw = superseded_reservation
            .map(VoiceTransportCleanup::from)
            .map(|cleanup| serde_json::to_string(&cleanup))
            .transpose()
            .to_internal_error()?;
        let superseded_reservation_key = voice_reservation_key(
            superseded_reservation
                .map(|current| current.operation_id.as_str())
                .unwrap_or(&reservation.operation_id),
        );
        let superseded_channel_id = superseded_reservation
            .map(|current| current.channel.id.as_str())
            .unwrap_or(&reservation.channel.id);
        let created: i64 = run_eval(PREPARE_VOICE_RESERVATION, 9, |command| {
            command
                .arg(voice_reservation_key(&reservation.operation_id))
                .arg(voice_reservation_current_key(&reservation.user_id))
                .arg(voice_current_key(&reservation.user_id))
                .arg(finalized_session_key)
                .arg(superseded_reservation_key)
                .arg(voice_transport_cleanups_key())
                .arg(voice_channel_reservations_key(&reservation.channel.id))
                .arg(voice_channel_reservations_key(superseded_channel_id))
                .arg(voice_transport_cleanup_key(
                    superseded_reservation
                        .map(|current| current.operation_id.as_str())
                        .unwrap_or(&reservation.operation_id),
                ))
                .arg(raw_reservation)
                .arg(VOICE_SESSION_TTL_SECONDS)
                .arg(&reservation.operation_id)
                .arg(expected_current_operation_id.unwrap_or_default())
                .arg(
                    reservation
                        .expected_finalized_operation_id
                        .as_deref()
                        .unwrap_or_default(),
                )
                .arg(idempotent_reservation_raw.as_deref().unwrap_or_default())
                .arg(superseded_reservation_raw.as_deref().unwrap_or_default())
                .arg(
                    superseded_reservation
                        .map(|_| superseded_channel_id)
                        .unwrap_or_default(),
                )
                .arg(VOICE_TRANSPORT_CLEANUP_TTL_SECONDS)
                .arg(&reservation.channel.id)
                .arg(&reservation.user_id)
                .arg(superseded_cleanup_raw.as_deref().unwrap_or_default());
        })
        .await?;

        if created == 1 {
            return Ok(true);
        }
    }

    Ok(false)
}

pub async fn delete_current_voice_reservation(reservation: &VoiceReservation) -> Result<bool> {
    let cleanup = VoiceTransportCleanup::from(reservation);
    let cleanup_raw = serde_json::to_string(&cleanup).to_internal_error()?;
    let deleted: i64 = run_eval(DELETE_VOICE_RESERVATION, 5, |command| {
        command
            .arg(voice_reservation_current_key(&reservation.user_id))
            .arg(voice_reservation_key(&reservation.operation_id))
            .arg(voice_transport_cleanups_key())
            .arg(voice_channel_reservations_key(&reservation.channel.id))
            .arg(voice_transport_cleanup_key(&reservation.operation_id))
            .arg(&reservation.operation_id)
            .arg(reservation)
            .arg(&reservation.channel.id)
            .arg(&reservation.user_id)
            .arg(VOICE_TRANSPORT_CLEANUP_TTL_SECONDS)
            .arg(cleanup_raw);
    })
    .await?;

    Ok(deleted == 1)
}

pub async fn save_current_voice_session(
    previous_session: &VoiceSession,
    session: &VoiceSession,
) -> Result<bool> {
    let previous_raw = serde_json::to_string(previous_session).to_internal_error()?;
    let saved: i64 = run_eval(SAVE_CURRENT_VOICE_SESSION, 2, |command| {
        command
            .arg(voice_current_key(&session.user_id))
            .arg(voice_session_key(&session.operation_id))
            .arg(&session.operation_id)
            .arg(session)
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(previous_raw);
    })
    .await?;

    Ok(saved == 1)
}

pub async fn save_current_voice_reservation(
    previous_reservation: &VoiceReservation,
    reservation: &VoiceReservation,
) -> Result<bool> {
    if previous_reservation.operation_id != reservation.operation_id
        || previous_reservation.user_id != reservation.user_id
    {
        return Ok(false);
    }

    let previous_raw = serde_json::to_string(previous_reservation).to_internal_error()?;
    let saved: i64 = run_eval(SAVE_CURRENT_VOICE_RESERVATION, 2, |command| {
        command
            .arg(voice_reservation_current_key(&reservation.user_id))
            .arg(voice_reservation_key(&reservation.operation_id))
            .arg(&reservation.operation_id)
            .arg(previous_raw)
            .arg(reservation)
            .arg(VOICE_SESSION_TTL_SECONDS);
    })
    .await?;

    Ok(saved == 1)
}

pub async fn retain_active_voice_session_from_reservation(
    reservation: &VoiceReservation,
    active_session: &VoiceSession,
) -> Result<bool> {
    if reservation.expected_finalized_operation_id.as_deref()
        != Some(active_session.operation_id.as_str())
    {
        return Ok(false);
    }

    let reservation_raw = serde_json::to_string(reservation).to_internal_error()?;
    let active_raw = serde_json::to_string(active_session).to_internal_error()?;
    let cleanup_raw =
        serde_json::to_string(&VoiceTransportCleanup::from(reservation)).to_internal_error()?;
    let retained: i64 = run_eval(RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION, 8, |command| {
        command
            .arg(voice_reservation_current_key(&reservation.user_id))
            .arg(voice_reservation_key(&reservation.operation_id))
            .arg(voice_current_key(&active_session.user_id))
            .arg(voice_session_key(&active_session.operation_id))
            .arg(voice_retain_receipt_key(
                &active_session.operation_id,
                &reservation.operation_id,
            ))
            .arg(voice_transport_cleanups_key())
            .arg(voice_channel_reservations_key(&reservation.channel.id))
            .arg(voice_transport_cleanup_key(&reservation.operation_id))
            .arg(&reservation.operation_id)
            .arg(reservation_raw)
            .arg(&active_session.operation_id)
            .arg(active_raw)
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(&reservation.channel.id)
            .arg(&reservation.user_id)
            .arg(VOICE_TRANSPORT_CLEANUP_TTL_SECONDS)
            .arg(cleanup_raw);
    })
    .await?;

    Ok(retained == 1)
}

pub async fn confirm_retained_voice_session(
    active_session: &VoiceSession,
    expected_canceled_operation_id: &str,
) -> Result<bool> {
    let active_raw = serde_json::to_string(active_session).to_internal_error()?;
    let retained: i64 = run_eval(CONFIRM_RETAINED_VOICE_SESSION, 4, |command| {
        command
            .arg(voice_reservation_current_key(&active_session.user_id))
            .arg(voice_current_key(&active_session.user_id))
            .arg(voice_session_key(&active_session.operation_id))
            .arg(voice_retain_receipt_key(
                &active_session.operation_id,
                expected_canceled_operation_id,
            ))
            .arg(&active_session.operation_id)
            .arg(active_raw)
            .arg(&active_session.operation_id);
    })
    .await?;

    Ok(retained == 1)
}

pub async fn get_voice_session(operation_id: &str) -> Result<Option<VoiceSession>> {
    super::get_connection()
        .await?
        .get(voice_session_key(operation_id))
        .await
        .to_internal_error()
}

pub async fn get_current_voice_session(user_id: &str) -> Result<Option<VoiceSession>> {
    run_eval(GET_CURRENT_VOICE_RECORD, 1, |command| {
        command
            .arg(voice_current_key(user_id))
            .arg("voice_session:");
    })
    .await
}

pub async fn get_voice_reservation(operation_id: &str) -> Result<Option<VoiceReservation>> {
    super::get_connection()
        .await?
        .get(voice_reservation_key(operation_id))
        .await
        .to_internal_error()
}

pub async fn get_current_voice_reservation(user_id: &str) -> Result<Option<VoiceReservation>> {
    run_eval(GET_CURRENT_VOICE_RECORD, 1, |command| {
        command
            .arg(voice_reservation_current_key(user_id))
            .arg("voice_reservation:");
    })
    .await
}

pub async fn get_voice_authority_snapshot(user_id: &str) -> Result<VoiceAuthoritySnapshot> {
    let (reservation_raw, session_raw): (String, String) =
        run_eval(GET_VOICE_AUTHORITY_SNAPSHOT, 2, |command| {
            command
                .arg(voice_reservation_current_key(user_id))
                .arg(voice_current_key(user_id))
                .arg("voice_reservation:")
                .arg("voice_session:");
        })
        .await?;

    Ok(VoiceAuthoritySnapshot {
        reservation: (!reservation_raw.is_empty())
            .then(|| serde_json::from_str(&reservation_raw).to_internal_error())
            .transpose()?,
        session: (!session_raw.is_empty())
            .then(|| serde_json::from_str(&session_raw).to_internal_error())
            .transpose()?,
    })
}

pub async fn get_current_voice_reservations_for_channel(
    channel: &UserVoiceChannel,
) -> Result<Vec<VoiceReservation>> {
    let user_ids: Vec<String> = super::get_connection()
        .await?
        .smembers(voice_channel_reservations_key(&channel.id))
        .await
        .to_internal_error()?;
    let mut reservations = Vec::new();
    for user_id in user_ids {
        let Some(reservation) = get_current_voice_reservation(&user_id).await? else {
            continue;
        };
        if reservation.channel.id == channel.id {
            reservations.push(reservation);
        }
    }
    Ok(reservations)
}

pub async fn list_voice_transport_cleanups() -> Result<Vec<VoiceTransportCleanup>> {
    let operation_ids: Vec<String> = super::get_connection()
        .await?
        .smembers(voice_transport_cleanups_key())
        .await
        .to_internal_error()?;
    let mut cleanups = Vec::new();
    for operation_id in operation_ids {
        let cleanup: Option<VoiceTransportCleanup> = super::get_connection()
            .await?
            .get(voice_transport_cleanup_key(&operation_id))
            .await
            .to_internal_error()?;
        if let Some(cleanup) = cleanup {
            cleanups.push(cleanup);
        } else {
            super::get_connection()
                .await?
                .srem::<_, _, ()>(voice_transport_cleanups_key(), operation_id)
                .await
                .to_internal_error()?;
        }
    }
    Ok(cleanups)
}

pub async fn complete_voice_transport_cleanup(cleanup: &VoiceTransportCleanup) -> Result<bool> {
    let cleanup_raw = serde_json::to_string(cleanup).to_internal_error()?;
    let completed: i64 = run_eval(COMPLETE_VOICE_TRANSPORT_CLEANUP, 2, |command| {
        command
            .arg(voice_transport_cleanups_key())
            .arg(voice_transport_cleanup_key(&cleanup.operation_id))
            .arg(&cleanup.operation_id)
            .arg(cleanup_raw);
    })
    .await?;
    Ok(completed == 1)
}

pub async fn get_active_voice_session_for_user(user_id: &str) -> Result<Option<VoiceSession>> {
    let Some(session) = get_current_voice_session(user_id).await? else {
        return Ok(None);
    };

    Ok(if session.state == VoiceSessionState::Active {
        Some(session)
    } else {
        None
    })
}

async fn persist_active_voice_session_from_reservation(
    reservation: &VoiceReservation,
    session: &VoiceSession,
    previous_session: Option<&VoiceSession>,
    retired_session: Option<&VoiceSession>,
) -> Result<bool> {
    let reservation_raw = serde_json::to_string(reservation).to_internal_error()?;
    let session_raw = serde_json::to_string(session).to_internal_error()?;
    let previous_raw = previous_session
        .map(serde_json::to_string)
        .transpose()
        .to_internal_error()?;
    let retired_raw = retired_session
        .map(serde_json::to_string)
        .transpose()
        .to_internal_error()?;
    let retired_cleanup_raw = retired_session
        .map(VoiceTransportCleanup::from)
        .map(|cleanup| serde_json::to_string(&cleanup))
        .transpose()
        .to_internal_error()?;
    let previous_channel_id = previous_session
        .map(|previous| previous.channel.id.as_str())
        .unwrap_or_default();
    let previous_user_id = previous_session
        .map(|previous| previous.user_id.as_str())
        .unwrap_or_default();
    let previous_session_key = previous_session
        .map(|previous| voice_session_key(&previous.operation_id))
        .unwrap_or_else(|| voice_session_key(&session.operation_id));
    let previous_members_key = previous_session
        .map(|previous| voice_channel_members_key(&previous.channel.id))
        .unwrap_or_else(|| voice_channel_members_key(&session.channel.id));
    let retired_cleanup_key = voice_transport_cleanup_key(
        retired_session
            .map(|retired| retired.operation_id.as_str())
            .unwrap_or(&session.operation_id),
    );
    let committed: i64 = run_eval(COMMIT_VOICE_RESERVATION_JOIN, 13, |command| {
        command
            .arg(voice_current_key(&session.user_id))
            .arg(voice_reservation_current_key(&session.user_id))
            .arg(voice_reservation_key(&session.operation_id))
            .arg(voice_session_key(&session.operation_id))
            .arg(voice_active_channels_key())
            .arg(voice_channel_members_key(&session.channel.id))
            .arg(voice_channel_node_key(&session.channel.id))
            .arg(voice_room_session_key(&session.channel.id))
            .arg(previous_session_key)
            .arg(previous_members_key)
            .arg(voice_channel_reservations_key(&session.channel.id))
            .arg(voice_transport_cleanups_key())
            .arg(retired_cleanup_key)
            .arg(&session.operation_id)
            .arg(reservation_raw)
            .arg(
                reservation
                    .expected_finalized_operation_id
                    .as_deref()
                    .unwrap_or_default(),
            )
            .arg(&session.node)
            .arg(session_raw)
            .arg(VOICE_SESSION_TTL_SECONDS)
            .arg(VOICE_MEMBERSHIP_TTL_SECONDS)
            .arg(&session.channel.id)
            .arg(&session.user_id)
            .arg(session.room_sid.as_deref().unwrap_or(""))
            .arg(previous_raw.as_deref().unwrap_or_default())
            .arg(retired_raw.as_deref().unwrap_or_default())
            .arg(previous_user_id)
            .arg(previous_channel_id)
            .arg(retired_cleanup_raw.as_deref().unwrap_or_default())
            .arg(VOICE_TRANSPORT_CLEANUP_TTL_SECONDS);
    })
    .await?;

    Ok(committed == 1)
}

pub async fn list_active_voice_channel_ids() -> Result<Vec<String>> {
    super::get_connection()
        .await?
        .smembers(voice_active_channels_key())
        .await
        .to_internal_error()
}

pub async fn delete_current_voice_session(session: &VoiceSession) -> Result<bool> {
    let cleanup_raw =
        serde_json::to_string(&VoiceTransportCleanup::from(session)).to_internal_error()?;
    let deleted: i64 = run_eval(DELETE_CURRENT_VOICE_SESSION, 6, |command| {
        command
            .arg(voice_current_key(&session.user_id))
            .arg(voice_session_key(&session.operation_id))
            .arg(voice_channel_members_key(&session.channel.id))
            .arg(voice_reservation_current_key(&session.user_id))
            .arg(voice_transport_cleanups_key())
            .arg(voice_transport_cleanup_key(&session.operation_id))
            .arg(&session.operation_id)
            .arg(&session.user_id)
            .arg(cleanup_raw)
            .arg(VOICE_TRANSPORT_CLEANUP_TTL_SECONDS);
    })
    .await?;

    Ok(deleted == 1)
}

pub async fn commit_voice_session_join(
    channel: &UserVoiceChannel,
    user_id: &str,
    operation_id: &str,
    joined_at: Timestamp,
    participant_sid: &str,
    room_sid: &str,
) -> Result<VoiceSessionCommitResult> {
    for _ in 0..VOICE_RESERVATION_COMMIT_RETRY_LIMIT {
        let Some(reservation) = get_voice_reservation(operation_id).await? else {
            let Some(session) = get_current_voice_session(user_id).await? else {
                return Ok(VoiceSessionCommitResult::Stale);
            };
            if session.operation_id != operation_id
                || session.channel.id != channel.id
                || session.state != VoiceSessionState::Active
                || session.participant_sid.as_deref() != Some(participant_sid)
                || session.room_sid.as_deref() != Some(room_sid)
            {
                return Ok(VoiceSessionCommitResult::Stale);
            }

            let mut retired_sessions = Vec::new();
            if let Some(retired_operation_id) = session.replaces_operation_id.as_deref() {
                if let Some(retired) = get_voice_session(retired_operation_id).await? {
                    if retired.user_id == session.user_id
                        && retired.operation_id != session.operation_id
                    {
                        retired_sessions.push(retired);
                    }
                }
            }

            return Ok(VoiceSessionCommitResult::Committed(VoiceSessionCommit {
                operation_id: session.operation_id.clone(),
                voice_state: session.voice_state(joined_at),
                retired_sessions,
                replayed: true,
            }));
        };

        if reservation.user_id != user_id || reservation.operation_id != operation_id {
            return Ok(VoiceSessionCommitResult::Stale);
        };

        let Some(current_reservation) = get_current_voice_reservation(user_id).await? else {
            return Ok(VoiceSessionCommitResult::Stale);
        };

        if current_reservation.operation_id != reservation.operation_id
            || reservation.channel.id != channel.id
        {
            return Ok(VoiceSessionCommitResult::Stale);
        }

        let mut session = reservation.awaiting_session();
        if session.mark_livekit_joined(room_sid, participant_sid, joined_at)
            != VoiceSessionTransition::Applied
        {
            return Ok(VoiceSessionCommitResult::Stale);
        }
        session.expires_at = joined_at
            .checked_add(Duration::seconds(VOICE_SESSION_TTL_SECONDS as i64))
            .ok_or_else(|| create_error!(InternalError))?;

        let previous_session =
            match reservation.expected_finalized_operation_id.as_deref() {
                Some(previous_operation_id) => get_voice_session(previous_operation_id)
                    .await?
                    .filter(|previous| {
                        previous.state == VoiceSessionState::Active
                            && previous.user_id == session.user_id
                            && previous.operation_id != session.operation_id
                    }),
                None => None,
            };
        let retired_session = previous_session.as_ref().map(|previous| {
            let mut retired = previous.clone();
            retired.state = VoiceSessionState::Ended;
            retired.updated_at = joined_at;
            retired
        });

        if !persist_active_voice_session_from_reservation(
            &reservation,
            &session,
            previous_session.as_ref(),
            retired_session.as_ref(),
        )
        .await?
        {
            continue;
        }

        let retired_sessions = retired_session.into_iter().collect();

        return Ok(VoiceSessionCommitResult::Committed(VoiceSessionCommit {
            operation_id: session.operation_id.clone(),
            voice_state: session.voice_state(joined_at),
            retired_sessions,
            replayed: false,
        }));
    }

    Ok(VoiceSessionCommitResult::Stale)
}

pub(super) async fn refresh_active_voice_session_projection_ttl(
    previous_session: &VoiceSession,
    session: &VoiceSession,
) -> Result<bool> {
    let previous_raw = serde_json::to_string(previous_session).to_internal_error()?;
    let refreshed: i64 = run_eval(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION, 6, |command| {
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
            .arg(previous_raw)
            .arg(session);
    })
    .await?;

    Ok(refreshed == 1)
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

pub async fn delete_voice_channel_projection_for_room(
    channel: &UserVoiceChannel,
    room_id: &str,
) -> Result<bool> {
    let deleted: i64 = run_eval(DELETE_VOICE_CHANNEL_PROJECTION_FOR_ROOM, 5, |command| {
        command
            .arg(voice_room_session_key(&channel.id))
            .arg(voice_channel_members_key(&channel.id))
            .arg(voice_active_channels_key())
            .arg(voice_channel_node_key(&channel.id))
            .arg(voice_channel_reservations_key(&channel.id))
            .arg(room_id)
            .arg(&channel.id);
    })
    .await?;

    Ok(deleted == 1)
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

    async fn cleanup_voice_keys(user_id: &str, operation_ids: &[&str]) {
        let mut conn = super::super::get_connection()
            .await
            .expect("redis connection")
            .into_inner();
        let mut pipeline = redis_kiss::redis::pipe();
        pipeline.del(voice_current_key(user_id));
        pipeline.del(voice_reservation_current_key(user_id));
        for operation_id in operation_ids {
            pipeline.del(voice_session_key(operation_id));
            pipeline.del(voice_reservation_key(operation_id));
            pipeline.del(voice_transport_cleanup_key(operation_id));
            pipeline.srem(voice_transport_cleanups_key(), operation_id);
        }
        pipeline.del(voice_channel_reservations_key("voice-a"));
        let _: () = pipeline
            .query_async(&mut conn)
            .await
            .expect("cleanup voice keys");
    }

    #[test]
    fn reservation_uses_distinct_keys() {
        assert_eq!(
            voice_reservation_current_key("user-a"),
            "voice_reservation_current:user-a"
        );
        assert_eq!(voice_reservation_key("op-a"), "voice_reservation:op-a");
        assert_eq!(voice_current_key("user-a"), "voice_current:user-a");
    }

    #[test]
    fn reservation_tracks_expected_finalized_operation() {
        let mut pending = awaiting_session();
        pending.screensharing = true;
        let reservation = VoiceReservation::from_pending_session(
            &pending,
            Some("op-pending".to_string()),
            Some("op-current".to_string()),
        );

        assert_eq!(
            reservation.expected_current_operation_id.as_deref(),
            Some("op-pending")
        );
        assert_eq!(
            reservation.expected_finalized_operation_id.as_deref(),
            Some("op-current")
        );
        assert_eq!(
            reservation
                .awaiting_session()
                .replaces_operation_id
                .as_deref(),
            Some("op-current")
        );
        assert_eq!(reservation.state, VoiceReservationState::Prepared);
        assert!(reservation.screensharing);
        assert!(reservation.awaiting_session().screensharing);
        assert!(!reservation.camera);
    }

    #[test]
    fn reservation_keeps_native_track_state_until_browser_join_commits() {
        let mut reservation =
            VoiceReservation::from_pending_session(&awaiting_session(), None, None);

        assert_eq!(
            reservation.set_track_state(true, livekit_protocol::TrackSource::ScreenShare as i32,),
            VoiceSessionTransition::Applied
        );
        assert!(reservation.awaiting_session().screensharing);
        assert_eq!(
            reservation.set_track_state(true, livekit_protocol::TrackSource::ScreenShare as i32,),
            VoiceSessionTransition::Noop
        );
    }

    #[test]
    fn prepare_script_fences_against_finalized_current() {
        assert!(PREPARE_VOICE_RESERVATION
            .contains("local reservation_current = redis.call('GET', KEYS[2])"));
        assert!(PREPARE_VOICE_RESERVATION
            .contains("local finalized_current = redis.call('GET', KEYS[3])"));
        assert!(PREPARE_VOICE_RESERVATION.contains("local expected_control = ARGV[4]"));
        assert!(PREPARE_VOICE_RESERVATION.contains("local expected_finalized = ARGV[5]"));
        assert!(PREPARE_VOICE_RESERVATION.contains("if reservation_current == ARGV[3] then"));
        assert!(PREPARE_VOICE_RESERVATION.contains("redis.call('GET', KEYS[1]) ~= ARGV[6]"));
        assert!(PREPARE_VOICE_RESERVATION.contains("redis.call('SET', KEYS[2], ARGV[3])"));
    }

    #[test]
    fn commit_script_consumes_reservation_and_sets_finalized_current() {
        assert!(COMMIT_VOICE_RESERVATION_JOIN.contains("redis.call('GET', KEYS[2]) ~= ARGV[1]"));
        assert!(COMMIT_VOICE_RESERVATION_JOIN.contains("redis.call('DEL', KEYS[2])"));
        assert!(COMMIT_VOICE_RESERVATION_JOIN.contains("redis.call('DEL', KEYS[3])"));
        assert!(COMMIT_VOICE_RESERVATION_JOIN.contains("redis.call('SET', KEYS[1], ARGV[1])"));
        assert!(!COMMIT_VOICE_RESERVATION_JOIN.contains("redis.call('GET', KEYS[4]) ~= ARGV[1]"));
        assert!(COMMIT_VOICE_RESERVATION_JOIN.contains("redis.call('GET', KEYS[9]) ~= ARGV[11]"));
        assert!(COMMIT_VOICE_RESERVATION_JOIN
            .contains("redis.call('SETEX', KEYS[9], tonumber(ARGV[6]), ARGV[12])"));
        assert!(COMMIT_VOICE_RESERVATION_JOIN.contains("redis.call('SADD', KEYS[12], ARGV[3])"));
        assert!(COMMIT_VOICE_RESERVATION_JOIN
            .contains("redis.call('SETEX', KEYS[13], tonumber(ARGV[16]), ARGV[15])"));
        assert!(COMMIT_VOICE_RESERVATION_JOIN.contains("redis.call('SREM', KEYS[10], ARGV[13])"));
    }

    #[test]
    fn commit_script_rejects_non_current_exact_operation() {
        assert!(
            COMMIT_VOICE_RESERVATION_JOIN.contains("if redis.call('GET', KEYS[2]) ~= ARGV[1] then")
        );
        assert!(
            COMMIT_VOICE_RESERVATION_JOIN.contains("if redis.call('GET', KEYS[3]) ~= ARGV[2] then")
        );
    }

    #[test]
    fn retain_script_requires_current_reservation_and_active_session() {
        assert!(RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION
            .contains("if redis.call('GET', KEYS[1]) ~= ARGV[1] then"));
        assert!(RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION
            .contains("if redis.call('GET', KEYS[2]) ~= ARGV[2] then"));
        assert!(RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION
            .contains("if redis.call('GET', KEYS[3]) ~= ARGV[3] then"));
        assert!(RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION
            .contains("if redis.call('GET', KEYS[4]) ~= ARGV[4] then"));
        assert!(RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION.contains("redis.call('DEL', KEYS[1])"));
        assert!(
            !RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION.contains("redis.call('DEL', KEYS[2])")
        );
        assert!(RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION
            .contains("redis.call('SETEX', KEYS[5], tonumber(ARGV[5]), ARGV[3])"));
        assert!(
            CONFIRM_RETAINED_VOICE_SESSION.contains("if redis.call('GET', KEYS[1]) ~= false then")
        );
        assert!(CONFIRM_RETAINED_VOICE_SESSION
            .contains("if redis.call('GET', KEYS[2]) ~= ARGV[1] then"));
        assert!(CONFIRM_RETAINED_VOICE_SESSION
            .contains("if redis.call('GET', KEYS[4]) ~= ARGV[3] then"));
    }

    #[test]
    fn every_terminal_authority_transition_enqueues_exact_transport_cleanup() {
        assert!(DELETE_VOICE_RESERVATION
            .contains("redis.call('SETEX', KEYS[5], tonumber(ARGV[5]), ARGV[6])"));
        assert!(DELETE_CURRENT_VOICE_SESSION
            .contains("redis.call('SETEX', KEYS[6], tonumber(ARGV[4]), ARGV[3])"));
        assert!(RETAIN_ACTIVE_VOICE_SESSION_FROM_RESERVATION
            .contains("redis.call('SETEX', KEYS[8], tonumber(ARGV[8]), ARGV[9])"));
    }

    #[test]
    fn mutation_scripts_compare_the_exact_previous_value() {
        assert!(
            SAVE_CURRENT_VOICE_SESSION.contains("if redis.call('GET', KEYS[2]) ~= ARGV[5] then")
        );
        assert!(SAVE_CURRENT_VOICE_RESERVATION
            .contains("if redis.call('GET', KEYS[2]) ~= ARGV[2] then"));
    }

    #[test]
    fn projection_maintenance_is_generation_fenced() {
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("if redis.call('GET', KEYS[1]) ~= ARGV[3] then"));
        assert!(REFRESH_ACTIVE_VOICE_SESSION_PROJECTION
            .contains("if redis.call('GET', KEYS[3]) ~= ARGV[8] then"));
        assert!(DELETE_VOICE_CHANNEL_PROJECTION_FOR_ROOM
            .contains("if redis.call('GET', KEYS[1]) ~= ARGV[1] then"));
        assert!(DELETE_VOICE_CHANNEL_PROJECTION_FOR_ROOM
            .contains("if redis.call('SCARD', KEYS[5]) ~= 0 then"));
        assert!(DELETE_VOICE_CHANNEL_PROJECTION_FOR_ROOM.contains("redis.call('DEL', KEYS[4])"));
        assert!(REMOVE_ORPHANED_ACTIVE_VOICE_CHANNEL
            .contains("if redis.call('SCARD', KEYS[4]) ~= 0 then"));
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
    }

    #[ignore]
    #[async_std::test]
    async fn newer_prepare_supersedes_older_without_touching_finalized_current() {
        let user_id = "user-a";
        cleanup_voice_keys(user_id, &["op-current", "op-next", "op-newer"]).await;

        let mut current = awaiting_session();
        current.operation_id = "op-current".to_string();
        current.state = VoiceSessionState::Active;
        current.room_sid = Some("room-a".to_string());
        current.participant_sid = Some("participant-a".to_string());
        create_voice_session_if_current(&current, None)
            .await
            .expect("prepare current");
        super::save_current_voice_session(&current, &current)
            .await
            .expect("save current");

        let mut next = awaiting_session();
        next.operation_id = "op-next".to_string();
        assert!(create_voice_session_if_current(&next, Some("op-current"))
            .await
            .expect("prepare next"));

        let mut newer = awaiting_session();
        newer.operation_id = "op-newer".to_string();
        assert!(create_voice_session_if_current(&newer, Some("op-next"))
            .await
            .expect("prepare newer"));

        assert_eq!(
            get_current_voice_session(user_id)
                .await
                .expect("current session")
                .map(|session| session.operation_id),
            Some("op-current".to_string())
        );
        assert_eq!(
            get_current_voice_reservation(user_id)
                .await
                .expect("current reservation")
                .map(|reservation| reservation.operation_id),
            Some("op-newer".to_string())
        );

        cleanup_voice_keys(user_id, &["op-current", "op-next", "op-newer"]).await;
    }

    #[ignore]
    #[async_std::test]
    async fn older_exact_finalize_cannot_commit_newer_reservation() {
        let user_id = "user-a";
        let channel = channel();
        cleanup_voice_keys(user_id, &["op-current", "op-next", "op-newer"]).await;

        let mut current = awaiting_session();
        current.operation_id = "op-current".to_string();
        current.state = VoiceSessionState::Active;
        current.room_sid = Some("room-a".to_string());
        current.participant_sid = Some("participant-a".to_string());
        create_voice_session_if_current(&current, None)
            .await
            .expect("prepare current");
        super::save_current_voice_session(&current, &current)
            .await
            .expect("save current");

        let mut next = awaiting_session();
        next.operation_id = "op-next".to_string();
        assert!(create_voice_session_if_current(&next, Some("op-current"))
            .await
            .expect("prepare next"));

        let mut newer = awaiting_session();
        newer.operation_id = "op-newer".to_string();
        assert!(create_voice_session_if_current(&newer, Some("op-next"))
            .await
            .expect("prepare newer"));

        assert_eq!(
            commit_voice_session_join(
                &channel,
                user_id,
                "op-next",
                Timestamp::UNIX_EPOCH
                    .checked_add(Duration::seconds(5))
                    .unwrap(),
                "participant-next",
                "room-a",
            )
            .await
            .expect("stale exact finalize"),
            VoiceSessionCommitResult::Stale
        );

        assert_eq!(
            get_current_voice_reservation(user_id)
                .await
                .expect("current reservation")
                .map(|reservation| reservation.operation_id),
            Some("op-newer".to_string())
        );
        assert_eq!(
            get_current_voice_session(user_id)
                .await
                .expect("current session")
                .map(|session| session.operation_id),
            Some("op-current".to_string())
        );

        cleanup_voice_keys(user_id, &["op-current", "op-next", "op-newer"]).await;
    }
}
