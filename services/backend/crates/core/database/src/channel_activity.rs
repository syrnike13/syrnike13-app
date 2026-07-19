use redis_kiss::{
    get_connection,
    redis::{cmd, FromRedisValue, RedisError, RedisWrite, ToRedisArgs, Value},
    AsyncCommands, Conn,
};
use syrnike_result::{create_error, Result, ToSyrnikeError};

use crate::events::client::ChannelActivityInstance;

const CHANNEL_ACTIVITY_TTL_SECONDS: usize = 2 * 60 * 60;
const CHANNEL_ACTIVITY_MAX_BYTES: usize = 64 * 1024;

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
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
elseif action == 'delete' then
  redis.call('DEL', KEYS[1])
else
  error('unknown channel activity mutation action')
end

return {1, current}
"#;

impl ToRedisArgs for ChannelActivityInstance {
    fn write_redis_args<W: ?Sized + RedisWrite>(&self, out: &mut W) {
        out.write_arg(
            serde_json::to_string(self)
                .expect("ChannelActivityInstance serializes to JSON")
                .as_bytes(),
        );
    }
}

impl FromRedisValue for ChannelActivityInstance {
    fn from_redis_value(value: &Value) -> std::result::Result<Self, RedisError> {
        let raw = String::from_redis_value(value)?;
        serde_json::from_str(&raw).map_err(|error| {
            RedisError::from((
                redis_kiss::redis::ErrorKind::TypeError,
                "ChannelActivityInstance",
                error.to_string(),
            ))
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChannelActivityMutation {
    Set(ChannelActivityInstance),
    Delete,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChannelActivityMutationResult {
    Applied,
    Conflict(Option<ChannelActivityInstance>),
}

pub async fn get_channel_activity(channel_id: &str) -> Result<Option<ChannelActivityInstance>> {
    connection()
        .await?
        .get(channel_activity_key(channel_id))
        .await
        .to_internal_error()
}

pub async fn mutate_channel_activity_if_current(
    channel_id: &str,
    expected: Option<&ChannelActivityInstance>,
    mutation: ChannelActivityMutation,
) -> Result<ChannelActivityMutationResult> {
    let expected_raw = expected
        .map(serialize_instance)
        .transpose()?
        .unwrap_or_default();
    let (action, next_raw) = match mutation {
        ChannelActivityMutation::Set(instance) => ("set", serialize_instance(&instance)?),
        ChannelActivityMutation::Delete => ("delete", String::new()),
    };

    let mut connection = connection().await?.into_inner();
    let (applied, current): (i64, Option<String>) = cmd("EVAL")
        .arg(APPLY_CHANNEL_ACTIVITY_MUTATION_IF_CURRENT)
        .arg(1)
        .arg(channel_activity_key(channel_id))
        .arg(expected_raw)
        .arg(action)
        .arg(next_raw)
        .arg(CHANNEL_ACTIVITY_TTL_SECONDS)
        .query_async(&mut connection)
        .await
        .to_internal_error()?;

    if applied == 1 {
        return Ok(ChannelActivityMutationResult::Applied);
    }

    Ok(ChannelActivityMutationResult::Conflict(
        current.as_deref().map(deserialize_instance).transpose()?,
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

fn serialize_instance(instance: &ChannelActivityInstance) -> Result<String> {
    let raw = serde_json::to_string(instance).to_internal_error()?;
    if raw.len() > CHANNEL_ACTIVITY_MAX_BYTES {
        return Err(create_error!(InvalidOperation));
    }
    Ok(raw)
}

fn deserialize_instance(raw: &str) -> Result<ChannelActivityInstance> {
    serde_json::from_str(raw).to_internal_error()
}

#[cfg(test)]
mod tests {
    use iso8601_timestamp::Timestamp;

    use super::{deserialize_instance, serialize_instance};
    use crate::events::client::ChannelActivityInstance;

    #[test]
    fn channel_activity_instance_round_trips_through_redis_json() {
        let instance = ChannelActivityInstance {
            id: "activity-1".to_string(),
            application_id: "syrnike13.shared-counter".to_string(),
            channel_id: "channel-1".to_string(),
            server_id: Some("server-1".to_string()),
            owner_id: "user-1".to_string(),
            participant_ids: vec!["user-1".to_string()],
            revision: 1,
            state: serde_json::json!({ "count": 0 }),
            created_at: Timestamp::UNIX_EPOCH,
        };

        let raw = serialize_instance(&instance).expect("instance serializes");
        assert_eq!(
            deserialize_instance(&raw).expect("instance deserializes"),
            instance
        );
    }
}
