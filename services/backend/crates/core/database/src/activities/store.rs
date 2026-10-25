//! Redis storage of running Activity Instances (ADR-0011).
//!
//! - `activity:channel:{channel_id}` — `ActivityInstance` JSON
//! - `activity:state:{channel_id}` — `ActivitySharedState` JSON
//! - `activity:channels` — set of channels with a running instance
//!
//! Writes compare the raw JSON read before the change, so concurrent gateways
//! never overwrite each other. Nothing expires: instances end through the
//! lifecycle or the reconciler.

use redis_kiss::{get_connection, redis::cmd, AsyncCommands, Conn};
use serde::{de::DeserializeOwned, Serialize};
use syrnike_result::{create_error, Result, ToSyrnikeError};

use crate::events::client::{ActivityInstance, ActivitySharedState};

const CHANNELS_KEY: &str = "activity:channels";

const MUTATE_INSTANCE_IF_CURRENT: &str = r#"
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '' then
  if current then
    return {0, current}
  end
elseif current ~= ARGV[1] then
  return {0, current}
end

local action = ARGV[2]
if action == 'create' then
  redis.call('SET', KEYS[1], ARGV[3])
  redis.call('SET', KEYS[2], ARGV[4])
  redis.call('SADD', KEYS[3], ARGV[5])
elseif action == 'set' then
  redis.call('SET', KEYS[1], ARGV[3])
elseif action == 'delete' then
  redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('SREM', KEYS[3], ARGV[5])
else
  error('unknown activity mutation')
end

return {1, current}
"#;

const SET_IF_CURRENT: &str = r#"
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then
  return {0, current}
end
redis.call('SET', KEYS[1], ARGV[2])
return {1, current}
"#;

const FORGET_CHANNEL_IF_EMPTY: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[1])
end
return 1
"#;

/// Value together with the exact JSON it was read from.
#[derive(Debug, Clone, PartialEq)]
pub struct Stored<T> {
    pub value: T,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InstanceMutation<'a> {
    Create(&'a ActivityInstance, &'a ActivitySharedState),
    Set(&'a ActivityInstance),
    Delete,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CasResult<T> {
    Applied,
    Conflict(Option<Stored<T>>),
}

pub fn instance_key(channel_id: &str) -> String {
    format!("activity:channel:{channel_id}")
}

pub fn state_key(channel_id: &str) -> String {
    format!("activity:state:{channel_id}")
}

pub async fn get_instance(channel_id: &str) -> Result<Option<Stored<ActivityInstance>>> {
    get_stored(&instance_key(channel_id)).await
}

pub async fn get_state(channel_id: &str) -> Result<Option<Stored<ActivitySharedState>>> {
    get_stored(&state_key(channel_id)).await
}

/// Running instances of the given channels.
pub async fn get_instances(channel_ids: &[String]) -> Result<Vec<ActivityInstance>> {
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    let keys = channel_ids
        .iter()
        .map(|channel_id| instance_key(channel_id))
        .collect::<Vec<_>>();
    let mut connection = connection().await?.into_inner();
    let raws: Vec<Option<String>> = cmd("MGET")
        .arg(keys)
        .query_async(&mut connection)
        .await
        .to_internal_error()?;
    raws.into_iter()
        .flatten()
        .map(|raw| serde_json::from_str(&raw).to_internal_error())
        .collect()
}

/// Channels that have (or recently had) a running instance.
pub async fn running_channel_ids() -> Result<Vec<String>> {
    connection()
        .await?
        .smembers(CHANNELS_KEY)
        .await
        .to_internal_error()
}

/// Drop a channel from the running set if it no longer has an instance.
pub async fn forget_channel(channel_id: &str) -> Result<()> {
    let mut connection = connection().await?.into_inner();
    let _: i64 = cmd("EVAL")
        .arg(FORGET_CHANNEL_IF_EMPTY)
        .arg(2)
        .arg(instance_key(channel_id))
        .arg(CHANNELS_KEY)
        .arg(channel_id)
        .query_async(&mut connection)
        .await
        .to_internal_error()?;
    Ok(())
}

/// Apply `mutation` if the instance key still holds `expected` (absent for `None`).
pub async fn mutate_instance_if_current(
    channel_id: &str,
    expected: Option<&Stored<ActivityInstance>>,
    mutation: InstanceMutation<'_>,
) -> Result<CasResult<ActivityInstance>> {
    let (action, instance_raw, state_raw) = match mutation {
        InstanceMutation::Create(instance, state) => {
            ("create", serialize(instance)?, serialize(state)?)
        }
        InstanceMutation::Set(instance) => ("set", serialize(instance)?, String::new()),
        InstanceMutation::Delete => ("delete", String::new(), String::new()),
    };

    let mut connection = connection().await?.into_inner();
    let (applied, current): (i64, Option<String>) = cmd("EVAL")
        .arg(MUTATE_INSTANCE_IF_CURRENT)
        .arg(3)
        .arg(instance_key(channel_id))
        .arg(state_key(channel_id))
        .arg(CHANNELS_KEY)
        .arg(
            expected
                .map(|stored| stored.raw.as_str())
                .unwrap_or_default(),
        )
        .arg(action)
        .arg(instance_raw)
        .arg(state_raw)
        .arg(channel_id)
        .query_async(&mut connection)
        .await
        .to_internal_error()?;

    cas_result(applied, current)
}

/// Replace the shared state if it still holds `expected`.
pub async fn set_state_if_current(
    channel_id: &str,
    expected: &Stored<ActivitySharedState>,
    next: &ActivitySharedState,
) -> Result<CasResult<ActivitySharedState>> {
    let mut connection = connection().await?.into_inner();
    let (applied, current): (i64, Option<String>) = cmd("EVAL")
        .arg(SET_IF_CURRENT)
        .arg(1)
        .arg(state_key(channel_id))
        .arg(&expected.raw)
        .arg(serialize(next)?)
        .query_async(&mut connection)
        .await
        .to_internal_error()?;

    cas_result(applied, current)
}

fn cas_result<T: DeserializeOwned>(applied: i64, current: Option<String>) -> Result<CasResult<T>> {
    if applied == 1 {
        return Ok(CasResult::Applied);
    }
    Ok(CasResult::Conflict(current.map(parse).transpose()?))
}

async fn get_stored<T: DeserializeOwned>(key: &str) -> Result<Option<Stored<T>>> {
    let raw: Option<String> = connection().await?.get(key).await.to_internal_error()?;
    raw.map(parse).transpose()
}

fn parse<T: DeserializeOwned>(raw: String) -> Result<Stored<T>> {
    Ok(Stored {
        value: serde_json::from_str(&raw).to_internal_error()?,
        raw,
    })
}

fn serialize<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).to_internal_error()
}

async fn connection() -> Result<Conn> {
    get_connection()
        .await
        .map_err(|_| create_error!(InternalError))
}

#[cfg(test)]
mod tests {
    use iso8601_timestamp::Timestamp;

    use super::{parse, serialize, Stored};
    use crate::activities::logic::new_instance;
    use crate::events::client::ActivityInstance;

    #[test]
    fn stored_values_keep_their_raw_json() {
        let (instance, _) = new_instance("lab", "channel", None, "a", Timestamp::UNIX_EPOCH);
        let raw = serialize(&instance).unwrap();
        let stored: Stored<ActivityInstance> = parse(raw.clone()).unwrap();
        assert_eq!(stored.value, instance);
        assert_eq!(stored.raw, raw);
    }
}
