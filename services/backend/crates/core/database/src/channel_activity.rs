use redis_kiss::{get_connection, redis::cmd, AsyncCommands, Conn};
use serde::{Deserialize, Serialize};
use syrnike_result::{create_error, Result, ToSyrnikeError};

use crate::events::client::ChannelActivityInstance;

pub const CHANNEL_ACTIVITY_TTL_MILLISECONDS: u64 = 2 * 60 * 60 * 1_000;
const CHANNEL_ACTIVITY_TOMBSTONE_TTL_SECONDS: usize = 7 * 24 * 60 * 60;
const CHANNEL_ACTIVITY_MAX_BYTES: usize = 64 * 1024;
const CHANNEL_ACTIVITY_ACTIVE_INDEX: &str = "channel_activity:active";

const APPLY_CHANNEL_ACTIVITY_MUTATION_IF_CURRENT: &str = r#"
local current = redis.call('GET', KEYS[1])
local expected = ARGV[1]

if expected == '' then
  if current ~= false then
    return {0, current}
  end
elseif current ~= expected then
  return {0, current}
end

local action = ARGV[2]
if action == 'set' then
  redis.call('SET', KEYS[1], ARGV[3])
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[6])
elseif action == 'close' then
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[5])
  redis.call('ZREM', KEYS[2], ARGV[6])
else
  error('unknown channel activity mutation action')
end

return {1, current}
"#;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ChannelActivityRecord {
    Active { instance: ChannelActivityInstance },
    Closed { tombstone: ChannelActivityTombstone },
}

impl ChannelActivityRecord {
    pub fn active(&self) -> Option<&ChannelActivityInstance> {
        match self {
            Self::Active { instance } => Some(instance),
            Self::Closed { .. } => None,
        }
    }

    pub fn generation(&self) -> u64 {
        match self {
            Self::Active { instance } => instance.generation,
            Self::Closed { tombstone } => tombstone.generation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelActivityTombstone {
    pub channel_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub closed_at: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChannelActivityMutation {
    Set(ChannelActivityInstance),
    Close(ChannelActivityTombstone),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChannelActivityMutationResult {
    Applied,
    Conflict(Option<ChannelActivityRecord>),
}

pub async fn get_channel_activity(channel_id: &str) -> Result<Option<ChannelActivityRecord>> {
    Ok(get_channel_activity_snapshot(channel_id).await?.0)
}

pub async fn get_channel_activity_snapshot(
    channel_id: &str,
) -> Result<(Option<ChannelActivityRecord>, u64)> {
    let mut connection = connection().await?.into_inner();
    let (raw, generation): (Option<String>, Option<u64>) = cmd("MGET")
        .arg(channel_activity_key(channel_id))
        .arg(channel_activity_generation_key(channel_id))
        .query_async(&mut connection)
        .await
        .to_internal_error()?;
    Ok((
        raw.as_deref().map(deserialize_record).transpose()?,
        generation.unwrap_or_default(),
    ))
}

pub async fn next_channel_activity_generation(channel_id: &str) -> Result<u64> {
    connection()
        .await?
        .incr(channel_activity_generation_key(channel_id), 1_u64)
        .await
        .to_internal_error()
}

pub async fn get_expired_channel_activity_ids(
    timestamp_ms: u64,
    limit: usize,
) -> Result<Vec<String>> {
    let mut connection = connection().await?.into_inner();
    cmd("ZRANGEBYSCORE")
        .arg(CHANNEL_ACTIVITY_ACTIVE_INDEX)
        .arg("-inf")
        .arg(timestamp_ms)
        .arg("LIMIT")
        .arg(0)
        .arg(limit)
        .query_async(&mut connection)
        .await
        .to_internal_error()
}

pub async fn mutate_channel_activity_if_current(
    channel_id: &str,
    expected: Option<&ChannelActivityRecord>,
    mutation: ChannelActivityMutation,
) -> Result<ChannelActivityMutationResult> {
    let expected_raw = expected
        .map(serialize_record)
        .transpose()?
        .unwrap_or_default();
    let (action, next, expires_at) = match mutation {
        ChannelActivityMutation::Set(instance) => {
            let expires_at = instance.expires_at;
            (
                "set",
                ChannelActivityRecord::Active { instance },
                expires_at,
            )
        }
        ChannelActivityMutation::Close(tombstone) => {
            ("close", ChannelActivityRecord::Closed { tombstone }, 0)
        }
    };
    let next_raw = serialize_record(&next)?;

    let mut connection = connection().await?.into_inner();
    let (applied, current): (i64, Option<String>) = cmd("EVAL")
        .arg(APPLY_CHANNEL_ACTIVITY_MUTATION_IF_CURRENT)
        .arg(2)
        .arg(channel_activity_key(channel_id))
        .arg(CHANNEL_ACTIVITY_ACTIVE_INDEX)
        .arg(expected_raw)
        .arg(action)
        .arg(next_raw)
        .arg(expires_at)
        .arg(CHANNEL_ACTIVITY_TOMBSTONE_TTL_SECONDS)
        .arg(channel_id)
        .query_async(&mut connection)
        .await
        .to_internal_error()?;

    if applied == 1 {
        return Ok(ChannelActivityMutationResult::Applied);
    }

    Ok(ChannelActivityMutationResult::Conflict(
        current.as_deref().map(deserialize_record).transpose()?,
    ))
}

async fn connection() -> Result<Conn> {
    get_connection()
        .await
        .map_err(|_| create_error!(InternalError))
}

fn channel_activity_key(channel_id: &str) -> String {
    format!("channel_activity:{channel_id}")
}

fn channel_activity_generation_key(channel_id: &str) -> String {
    format!("channel_activity_generation:{channel_id}")
}

fn serialize_record(record: &ChannelActivityRecord) -> Result<String> {
    let raw = serde_json::to_string(record).to_internal_error()?;
    if raw.len() > CHANNEL_ACTIVITY_MAX_BYTES {
        return Err(create_error!(InvalidOperation));
    }
    Ok(raw)
}

fn deserialize_record(raw: &str) -> Result<ChannelActivityRecord> {
    serde_json::from_str(raw).to_internal_error()
}

#[cfg(test)]
mod tests {
    use iso8601_timestamp::Timestamp;

    use super::{
        deserialize_record, serialize_record, ChannelActivityRecord, ChannelActivityTombstone,
    };
    use crate::events::client::ChannelActivityInstance;

    #[test]
    fn channel_activity_records_round_trip_through_redis_json() {
        let active = ChannelActivityRecord::Active {
            instance: ChannelActivityInstance {
                id: "activity-1".to_string(),
                generation: 4,
                application_id: "syrnike13.shared-counter".to_string(),
                channel_id: "channel-1".to_string(),
                server_id: Some("server-1".to_string()),
                owner_id: "user-1".to_string(),
                participant_ids: vec!["user-1".to_string()],
                revision: 1,
                state: serde_json::json!({ "count": 0 }),
                created_at: Timestamp::UNIX_EPOCH,
                expires_at: 7_200_000,
            },
        };
        let closed = ChannelActivityRecord::Closed {
            tombstone: ChannelActivityTombstone {
                channel_id: "channel-1".to_string(),
                instance_id: "activity-1".to_string(),
                generation: 4,
                closed_at: 10,
            },
        };

        for record in [active, closed] {
            let raw = serialize_record(&record).expect("record serializes");
            assert_eq!(
                deserialize_record(&raw).expect("record deserializes"),
                record
            );
        }
    }
}
