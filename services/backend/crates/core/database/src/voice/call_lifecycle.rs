use iso8601_timestamp::{Duration, Timestamp};
use redis_kiss::redis::{cmd, FromRedisValue, RedisError, RedisWrite, ToRedisArgs, Value};
use redis_kiss::AsyncCommands;
use serde::{Deserialize, Serialize};
use syrnike_result::{Result, ToSyrnikeError};

use super::get_connection;
use crate::VoiceCallEndReason;

const VOICE_CALL_TTL_SECONDS: usize = 24 * 60 * 60;
pub const GROUP_UNANSWERED_ACTIVE_SECONDS: i64 = 10 * 60;

const APPLY_VOICE_CALL_MUTATION_IF_CURRENT: &str = r#"
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
elseif action ~= 'noop' then
  error('unknown voice call mutation action')
end

return {1, current}
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VoiceCallPhase {
    Ringing,
    Active,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceCallState {
    pub channel_id: String,
    pub initiator_id: String,
    pub phase: VoiceCallPhase,
    pub started_at: Timestamp,
    pub expires_at: Option<Timestamp>,
    #[serde(default)]
    pub declined_recipients: Vec<String>,
    pub ringing_recipients: Vec<String>,
}

impl ToRedisArgs for VoiceCallState {
    fn write_redis_args<W: ?Sized + RedisWrite>(&self, out: &mut W) {
        out.write_arg(
            serde_json::to_string(self)
                .expect("VoiceCallState serializes to JSON")
                .as_bytes(),
        );
    }
}

impl FromRedisValue for VoiceCallState {
    fn from_redis_value(v: &Value) -> Result<Self, RedisError> {
        let raw = String::from_redis_value(v)?;
        serde_json::from_str(&raw).map_err(|error| {
            RedisError::from((
                redis_kiss::redis::ErrorKind::TypeError,
                "VoiceCallState",
                error.to_string(),
            ))
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceCallJoinEffect {
    NoChange,
    StartRinging {
        state: VoiceCallState,
        notify_recipients: Vec<String>,
        stop_previous_ringing_recipients: Vec<String>,
    },
    MarkActive {
        state: VoiceCallState,
        stop_ringing_recipients: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceCallLeaveEffect {
    NoChange,
    End {
        state: VoiceCallState,
        stop_ringing_recipients: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceCallLeavePolicy {
    EndWhenEmpty,
    EndWhenAnyParticipantLeaves,
}

#[derive(Debug, Clone, Copy)]
pub enum VoiceCallLeaveReason<'a> {
    ParticipantLeft {
        remaining_members_after_leave: &'a [String],
        leave_policy: VoiceCallLeavePolicy,
    },
    RoomFinished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceCallExpireEffect {
    NoChange,
    StopRinging {
        state: VoiceCallState,
        stop_ringing_recipients: Vec<String>,
    },
    ClearActiveDeadline(VoiceCallState),
    End {
        state: VoiceCallState,
        ended_reason: VoiceCallEndReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceCallCancelEffect {
    NoChange,
    Cancel {
        state: VoiceCallState,
        stop_ringing_recipients: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceCallDeclineEffect {
    NoChange,
    Decline {
        state: VoiceCallState,
        stop_ringing_recipients: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceCallStateMutation {
    Noop,
    Set(VoiceCallState),
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceCallStateMutationResult {
    Applied,
    Conflict(Option<VoiceCallState>),
}

pub fn voice_call_join_effect(
    existing_call: Option<&VoiceCallState>,
    channel_id: &str,
    user_id: &str,
    channel_recipients: &[String],
    connected_members_before_join: &[String],
    requested_recipients: Option<&[String]>,
    started_at: Timestamp,
    ring_duration_seconds: i64,
) -> VoiceCallJoinEffect {
    let mut stop_previous_ringing_recipients = Vec::new();

    if let Some(existing_call) = existing_call {
        if existing_call.phase == VoiceCallPhase::Active {
            if existing_call.expires_at.is_some()
                && existing_call.initiator_id != user_id
                && connected_members_before_join.contains(&existing_call.initiator_id)
            {
                let mut state = existing_call.clone();
                state.expires_at = None;
                state
                    .declined_recipients
                    .retain(|recipient_id| recipient_id != user_id);
                return VoiceCallJoinEffect::MarkActive {
                    state,
                    stop_ringing_recipients: Vec::new(),
                };
            }

            return VoiceCallJoinEffect::NoChange;
        }

        if existing_call.phase == VoiceCallPhase::Ringing
            && existing_call.initiator_id != user_id
            && connected_members_before_join.contains(&existing_call.initiator_id)
        {
            let mut state = existing_call.clone();
            let stop_ringing_recipients = state.ringing_recipients.clone();
            state.phase = VoiceCallPhase::Active;
            state.expires_at = None;
            state
                .declined_recipients
                .retain(|recipient_id| recipient_id != user_id);
            state.ringing_recipients.clear();
            return VoiceCallJoinEffect::MarkActive {
                state,
                stop_ringing_recipients,
            };
        }

        if !voice_call_is_expired(existing_call, started_at) {
            return VoiceCallJoinEffect::NoChange;
        }

        stop_previous_ringing_recipients = ringing_recipients_to_stop(existing_call);
    }

    if !connected_members_before_join.is_empty() {
        return VoiceCallJoinEffect::NoChange;
    }

    let notify_recipients = call_notification_recipients(
        user_id,
        channel_recipients,
        connected_members_before_join,
        requested_recipients,
    );

    if notify_recipients.is_empty() {
        return VoiceCallJoinEffect::NoChange;
    }

    VoiceCallJoinEffect::StartRinging {
        state: VoiceCallState {
            channel_id: channel_id.to_string(),
            initiator_id: user_id.to_string(),
            phase: VoiceCallPhase::Ringing,
            started_at,
            expires_at: Some(started_at + Duration::seconds(ring_duration_seconds)),
            declined_recipients: Vec::new(),
            ringing_recipients: notify_recipients.clone(),
        },
        notify_recipients,
        stop_previous_ringing_recipients,
    }
}

pub fn voice_call_leave_effect(
    existing_call: Option<&VoiceCallState>,
    reason: VoiceCallLeaveReason<'_>,
) -> VoiceCallLeaveEffect {
    let Some(existing_call) = existing_call else {
        return VoiceCallLeaveEffect::NoChange;
    };

    match reason {
        VoiceCallLeaveReason::ParticipantLeft {
            remaining_members_after_leave,
            leave_policy,
        } => {
            if leave_policy == VoiceCallLeavePolicy::EndWhenAnyParticipantLeaves
                || remaining_members_after_leave.is_empty()
            {
                VoiceCallLeaveEffect::End {
                    state: existing_call.clone(),
                    stop_ringing_recipients: ringing_recipients_to_stop(existing_call),
                }
            } else {
                VoiceCallLeaveEffect::NoChange
            }
        }
        VoiceCallLeaveReason::RoomFinished => VoiceCallLeaveEffect::End {
            state: existing_call.clone(),
            stop_ringing_recipients: ringing_recipients_to_stop(existing_call),
        },
    }
}

pub fn voice_call_expire_effect(
    existing_call: Option<&VoiceCallState>,
    now: Timestamp,
    keep_group_call_joinable_after_ringing: bool,
    unanswered_active_seconds: i64,
    connected_members: &[String],
) -> VoiceCallExpireEffect {
    let Some(existing_call) = existing_call else {
        return VoiceCallExpireEffect::NoChange;
    };

    if connected_members.is_empty() {
        return VoiceCallExpireEffect::End {
            state: existing_call.clone(),
            ended_reason: voice_call_empty_channel_end_reason(existing_call),
        };
    }

    if active_no_answer_deadline_is_expired(existing_call, now) {
        if connected_members
            .iter()
            .any(|member_id| member_id != &existing_call.initiator_id)
        {
            let mut state = existing_call.clone();
            state.expires_at = None;
            return VoiceCallExpireEffect::ClearActiveDeadline(state);
        }

        return VoiceCallExpireEffect::End {
            state: existing_call.clone(),
            ended_reason: VoiceCallEndReason::Missed,
        };
    }

    if voice_call_is_expired(existing_call, now) {
        if keep_group_call_joinable_after_ringing {
            let mut state = existing_call.clone();
            let stop_ringing_recipients = state.ringing_recipients.clone();
            state.phase = VoiceCallPhase::Active;
            state.expires_at = Some(
                existing_call.expires_at.unwrap_or(now)
                    + Duration::seconds(unanswered_active_seconds),
            );
            state.ringing_recipients.clear();
            return VoiceCallExpireEffect::StopRinging {
                state,
                stop_ringing_recipients,
            };
        }

        return VoiceCallExpireEffect::End {
            state: existing_call.clone(),
            ended_reason: VoiceCallEndReason::Missed,
        };
    }

    VoiceCallExpireEffect::NoChange
}

pub fn voice_call_cancel_effect(
    existing_call: Option<&VoiceCallState>,
    user_id: &str,
    channel_recipients: &[String],
) -> VoiceCallCancelEffect {
    let Some(existing_call) = existing_call else {
        return VoiceCallCancelEffect::NoChange;
    };

    let is_channel_recipient = channel_recipients
        .iter()
        .any(|recipient_id| recipient_id == user_id);
    let is_initiator = existing_call.initiator_id == user_id;

    if existing_call.phase != VoiceCallPhase::Ringing
        || channel_recipients.len() != 2
        || !is_channel_recipient
        || !is_initiator
    {
        return VoiceCallCancelEffect::NoChange;
    }

    VoiceCallCancelEffect::Cancel {
        state: existing_call.clone(),
        stop_ringing_recipients: existing_call.ringing_recipients.clone(),
    }
}

pub fn voice_call_decline_effect(
    existing_call: Option<&VoiceCallState>,
    user_id: &str,
    channel_recipients: &[String],
    declined_at: Timestamp,
    unanswered_active_seconds: i64,
) -> VoiceCallDeclineEffect {
    let Some(existing_call) = existing_call else {
        return VoiceCallDeclineEffect::NoChange;
    };

    let is_channel_recipient = channel_recipients
        .iter()
        .any(|recipient_id| recipient_id == user_id);
    let is_initiator = existing_call.initiator_id == user_id;
    let is_ringing_recipient = existing_call
        .ringing_recipients
        .iter()
        .any(|recipient_id| recipient_id == user_id);

    if existing_call.phase != VoiceCallPhase::Ringing
        || channel_recipients.len() != 2
        || !is_channel_recipient
        || is_initiator
        || !is_ringing_recipient
    {
        return VoiceCallDeclineEffect::NoChange;
    }

    let mut state = existing_call.clone();
    state.phase = VoiceCallPhase::Active;
    state.expires_at = Some(declined_at + Duration::seconds(unanswered_active_seconds));
    state
        .ringing_recipients
        .retain(|recipient_id| recipient_id != user_id);
    if !state
        .declined_recipients
        .iter()
        .any(|recipient_id| recipient_id == user_id)
    {
        state.declined_recipients.push(user_id.to_string());
    }

    VoiceCallDeclineEffect::Decline {
        state,
        stop_ringing_recipients: vec![user_id.to_string()],
    }
}

pub async fn get_channel_voice_call(channel_id: &str) -> Result<Option<VoiceCallState>> {
    get_connection()
        .await?
        .get(voice_call_key(channel_id))
        .await
        .to_internal_error()
}

pub async fn list_channel_voice_calls() -> Result<Vec<VoiceCallState>> {
    let mut conn = get_connection().await?;
    let keys: Vec<String> = conn.keys("voice_call:*").await.to_internal_error()?;
    let mut calls = Vec::new();

    for key in keys {
        let call: Result<Option<VoiceCallState>> = conn.get(&key).await.to_internal_error();
        match call {
            Ok(Some(call)) => calls.push(call),
            Ok(None) => {}
            Err(error) => {
                syrnike_config::capture_internal_error!(&error);
            }
        }
    }

    Ok(calls)
}

pub async fn mutate_channel_voice_call_if_current(
    channel_id: &str,
    expected_call: Option<&VoiceCallState>,
    mutation: VoiceCallStateMutation,
) -> Result<VoiceCallStateMutationResult> {
    let key = voice_call_key(channel_id);
    let expected = expected_call
        .map(serialize_voice_call_state)
        .transpose()?
        .unwrap_or_default();
    let (action, next_state) = match mutation {
        VoiceCallStateMutation::Noop => ("noop", String::new()),
        VoiceCallStateMutation::Set(state) => ("set", serialize_voice_call_state(&state)?),
        VoiceCallStateMutation::Delete => ("delete", String::new()),
    };

    let mut conn = get_connection().await?.into_inner();
    let (applied, current): (i64, Option<String>) = cmd("EVAL")
        .arg(APPLY_VOICE_CALL_MUTATION_IF_CURRENT)
        .arg(1)
        .arg(key)
        .arg(expected)
        .arg(action)
        .arg(next_state)
        .arg(VOICE_CALL_TTL_SECONDS)
        .query_async(&mut conn)
        .await
        .to_internal_error()?;

    if applied == 1 {
        return Ok(VoiceCallStateMutationResult::Applied);
    }

    Ok(VoiceCallStateMutationResult::Conflict(
        current
            .as_deref()
            .map(deserialize_voice_call_state)
            .transpose()?,
    ))
}

fn voice_call_key(channel_id: &str) -> String {
    format!("voice_call:{channel_id}")
}

fn serialize_voice_call_state(state: &VoiceCallState) -> Result<String> {
    serde_json::to_string(state).to_internal_error()
}

fn deserialize_voice_call_state(raw: &str) -> Result<VoiceCallState> {
    serde_json::from_str(raw).to_internal_error()
}

fn voice_call_is_expired(call: &VoiceCallState, now: Timestamp) -> bool {
    call.phase == VoiceCallPhase::Ringing
        && call.expires_at.is_some_and(|expires_at| expires_at <= now)
}

fn active_no_answer_deadline_is_expired(call: &VoiceCallState, now: Timestamp) -> bool {
    call.phase == VoiceCallPhase::Active
        && call.expires_at.is_some_and(|expires_at| expires_at <= now)
}

fn ringing_recipients_to_stop(call: &VoiceCallState) -> Vec<String> {
    if call.phase != VoiceCallPhase::Ringing {
        return Vec::new();
    }

    call.ringing_recipients.clone()
}

fn voice_call_empty_channel_end_reason(call: &VoiceCallState) -> VoiceCallEndReason {
    if call.phase == VoiceCallPhase::Active && call.expires_at.is_none() {
        VoiceCallEndReason::Completed
    } else {
        VoiceCallEndReason::Cancelled
    }
}

fn call_notification_recipients(
    user_id: &str,
    channel_recipients: &[String],
    connected_members_before_join: &[String],
    requested_recipients: Option<&[String]>,
) -> Vec<String> {
    let candidate_recipients = requested_recipients.unwrap_or(channel_recipients);
    let mut recipients = Vec::new();

    for recipient_id in candidate_recipients {
        if recipient_id.as_str() == user_id
            || !channel_recipients.contains(recipient_id)
            || connected_members_before_join.contains(recipient_id)
            || recipients.contains(recipient_id)
        {
            continue;
        }

        recipients.push(recipient_id.clone());
    }

    recipients
}

#[cfg(test)]
mod tests {
    use iso8601_timestamp::{Duration, Timestamp};

    use super::{
        voice_call_cancel_effect, voice_call_decline_effect, voice_call_join_effect,
        VoiceCallCancelEffect, VoiceCallDeclineEffect, VoiceCallJoinEffect, VoiceCallPhase,
        VoiceCallState, GROUP_UNANSWERED_ACTIVE_SECONDS,
    };

    fn recipients(recipients: &[&str]) -> Vec<String> {
        recipients
            .iter()
            .map(|recipient| recipient.to_string())
            .collect()
    }

    fn ringing_call(channel_recipients: &[&str]) -> VoiceCallState {
        VoiceCallState {
            channel_id: "channel".to_string(),
            initiator_id: channel_recipients[0].to_string(),
            phase: VoiceCallPhase::Ringing,
            started_at: Timestamp::UNIX_EPOCH,
            expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(30)),
            declined_recipients: Vec::new(),
            ringing_recipients: channel_recipients[1..]
                .iter()
                .map(|recipient| recipient.to_string())
                .collect(),
        }
    }

    #[test]
    fn direct_call_initiator_can_cancel_ringing_call() {
        let call = ringing_call(&["user-a", "user-b"]);

        assert!(matches!(
            voice_call_cancel_effect(
                Some(&call),
                "user-a",
                &["user-a".to_string(), "user-b".to_string()],
            ),
            VoiceCallCancelEffect::Cancel { .. }
        ));
    }

    #[test]
    fn group_call_cannot_be_cancelled_through_dm_cancel() {
        let call = ringing_call(&["user-a", "user-b", "user-c"]);

        assert_eq!(
            voice_call_cancel_effect(
                Some(&call),
                "user-b",
                &recipients(&["user-a", "user-b", "user-c"]),
            ),
            VoiceCallCancelEffect::NoChange,
        );
    }

    #[test]
    fn direct_call_callee_decline_keeps_call_active_and_joinable() {
        let call = ringing_call(&["user-a", "user-b"]);

        assert_eq!(
            voice_call_decline_effect(
                Some(&call),
                "user-b",
                &recipients(&["user-a", "user-b"]),
                Timestamp::UNIX_EPOCH + Duration::seconds(5),
                GROUP_UNANSWERED_ACTIVE_SECONDS,
            ),
            VoiceCallDeclineEffect::Decline {
                state: VoiceCallState {
                    channel_id: "channel".to_string(),
                    initiator_id: "user-a".to_string(),
                    phase: VoiceCallPhase::Active,
                    started_at: Timestamp::UNIX_EPOCH,
                    expires_at: Some(
                        Timestamp::UNIX_EPOCH
                            + Duration::seconds(5 + GROUP_UNANSWERED_ACTIVE_SECONDS)
                    ),
                    declined_recipients: recipients(&["user-b"]),
                    ringing_recipients: Vec::new(),
                },
                stop_ringing_recipients: recipients(&["user-b"]),
            },
        );
    }

    #[test]
    fn empty_requested_recipients_suppresses_new_call_notifications() {
        let requested = Vec::new();
        let effect = voice_call_join_effect(
            None,
            "channel",
            "user-a",
            &recipients(&["user-a", "user-b"]),
            &[],
            Some(&requested),
            Timestamp::UNIX_EPOCH,
            30,
        );

        assert_eq!(effect, VoiceCallJoinEffect::NoChange);
    }

    #[test]
    fn requested_recipients_start_ringing_only_for_requested_members() {
        let requested = recipients(&["user-b"]);
        let effect = voice_call_join_effect(
            None,
            "channel",
            "user-a",
            &recipients(&["user-a", "user-b", "user-c"]),
            &[],
            Some(&requested),
            Timestamp::UNIX_EPOCH,
            30,
        );

        let VoiceCallJoinEffect::StartRinging {
            state,
            notify_recipients,
            stop_previous_ringing_recipients,
        } = effect
        else {
            panic!("expected call to start ringing");
        };

        assert_eq!(notify_recipients, recipients(&["user-b"]));
        assert_eq!(state.ringing_recipients, recipients(&["user-b"]));
        assert!(stop_previous_ringing_recipients.is_empty());
    }

    #[test]
    fn answering_existing_ringing_call_marks_it_active_without_new_recipients() {
        let call = ringing_call(&["user-a", "user-b"]);
        let connected_members = recipients(&["user-a"]);
        let requested = Vec::new();
        let effect = voice_call_join_effect(
            Some(&call),
            "channel",
            "user-b",
            &recipients(&["user-a", "user-b"]),
            &connected_members,
            Some(&requested),
            Timestamp::UNIX_EPOCH + Duration::seconds(5),
            30,
        );

        let VoiceCallJoinEffect::MarkActive {
            state,
            stop_ringing_recipients,
        } = effect
        else {
            panic!("expected call to become active");
        };

        assert_eq!(state.phase, VoiceCallPhase::Active);
        assert_eq!(stop_ringing_recipients, recipients(&["user-b"]));
    }
}
