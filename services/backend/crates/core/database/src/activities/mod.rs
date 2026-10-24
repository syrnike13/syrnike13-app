//! Channel Activities runtime (ADR-0011).
//!
//! Owns the Activity Instance lifecycle, participants, Activity Host, relayed
//! messages and the versioned shared state. Application payloads are never
//! interpreted.

use serde_json::Value;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{ErrorType, Result};

use crate::{
    events::client::{
        ActivityEndReason, ActivityErrorCode, ActivityInstance, ActivitySharedState, EventV1,
    },
    iso8601_timestamp::Timestamp,
    util::{permissions::perms, reference::Reference},
    voice::{get_active_voice_session_for_user, get_voice_channel_members, UserVoiceChannel},
    ActivityApplication, Database, User,
};

pub mod logic;
pub mod store;

use logic::Decision;
use store::{CasResult, InstanceMutation};

const MUTATION_RETRY_LIMIT: usize = 8;

/// Successful activity request result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActivityReply {
    pub instance: Option<ActivityInstance>,
    pub state: Option<ActivitySharedState>,
}

/// Failed activity request; `state` is set for `version_conflict`.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivityError {
    pub code: ActivityErrorCode,
    pub state: Option<ActivitySharedState>,
}

impl From<ActivityErrorCode> for ActivityError {
    fn from(code: ActivityErrorCode) -> Self {
        Self { code, state: None }
    }
}

pub type ActivityResult<T> = std::result::Result<T, ActivityError>;

fn internal(error: syrnike_result::Error) -> ActivityError {
    warn!("Activity runtime error: {error:?}");
    ActivityErrorCode::Internal.into()
}

fn require_identifiers(values: &[&str]) -> ActivityResult<()> {
    if values.iter().all(|value| logic::valid_identifier(value)) {
        Ok(())
    } else {
        Err(ActivityErrorCode::InvalidRequest.into())
    }
}

/// Start `application_id` in the caller's voice channel. Starting the
/// application that already runs joins it instead.
pub async fn start(
    db: &Database,
    user: &User,
    channel_id: &str,
    application_id: &str,
) -> ActivityResult<ActivityReply> {
    require_identifiers(&[channel_id, application_id])?;
    let voice_channel = require_voice_channel(&user.id, channel_id).await?;
    let channel = Reference::from_unchecked(channel_id)
        .as_channel(db)
        .await
        .map_err(|_| ActivityErrorCode::NotInVoiceChannel)?;
    let permissions = calculate_channel_permissions(&mut perms(db, user).channel(&channel)).await;
    if !permissions.has_channel_permission(ChannelPermission::UseActivities) {
        return Err(ActivityErrorCode::MissingPermission.into());
    }
    let application = available_application(db, application_id)
        .await
        .map_err(internal)?
        .ok_or(ActivityErrorCode::UnknownApplication)?;
    let max_participants = max_participants(&application);

    let now = Timestamp::now_utc();
    let decision = mutate(channel_id, |current| match current {
        None => {
            let (instance, state) = logic::new_instance(
                application_id,
                channel_id,
                voice_channel.server_id.clone(),
                &user.id,
                now,
            );
            Ok(Decision::Create(instance, state))
        }
        Some(existing) if existing.application_id != application_id => {
            Err(ActivityErrorCode::AlreadyRunning)
        }
        Some(existing) => logic::join_decision(existing, &user.id, max_participants, now),
    })
    .await?;

    reply_with_state(channel_id, decision).await
}

/// Join a running instance in the caller's voice channel.
pub async fn join(
    db: &Database,
    user: &User,
    channel_id: &str,
    instance_id: &str,
) -> ActivityResult<ActivityReply> {
    require_identifiers(&[channel_id, instance_id])?;
    require_voice_channel(&user.id, channel_id).await?;
    let Some(current) = store::get_instance(channel_id).await.map_err(internal)? else {
        return Err(ActivityErrorCode::InstanceNotFound.into());
    };
    let instance = logic::matching(Some(&current.value), instance_id)?;
    let application = available_application(db, &instance.application_id)
        .await
        .map_err(internal)?
        .ok_or(ActivityErrorCode::UnknownApplication)?;
    let max_participants = max_participants(&application);

    let now = Timestamp::now_utc();
    let decision = mutate(channel_id, |current| {
        let instance = logic::matching(current, instance_id)?;
        logic::join_decision(instance, &user.id, max_participants, now)
    })
    .await?;

    reply_with_state(channel_id, decision).await
}

/// Leave an instance; the last participant ends it.
pub async fn leave(
    user_id: &str,
    channel_id: &str,
    instance_id: &str,
) -> ActivityResult<ActivityReply> {
    require_identifiers(&[channel_id, instance_id])?;
    mutate(channel_id, |current| {
        let instance = logic::matching(current, instance_id)?;
        Ok(logic::leave_decision(instance, user_id))
    })
    .await?;
    Ok(ActivityReply::default())
}

/// End an instance for everyone. Allowed for the host and for members with
/// `ManageChannel`.
pub async fn end(
    db: &Database,
    user: &User,
    channel_id: &str,
    instance_id: &str,
) -> ActivityResult<ActivityReply> {
    require_identifiers(&[channel_id, instance_id])?;
    let current = store::get_instance(channel_id).await.map_err(internal)?;
    let instance = logic::matching(current.as_ref().map(|stored| &stored.value), instance_id)?;
    if instance.host_id != user.id {
        let channel = Reference::from_unchecked(channel_id)
            .as_channel(db)
            .await
            .map_err(|_| ActivityErrorCode::InstanceNotFound)?;
        let permissions =
            calculate_channel_permissions(&mut perms(db, user).channel(&channel)).await;
        if !permissions.has_channel_permission(ChannelPermission::ManageChannel) {
            return Err(ActivityErrorCode::NotAllowed.into());
        }
    }

    mutate(channel_id, |current| {
        let instance = logic::matching(current, instance_id)?;
        Ok(Decision::End(instance.clone(), ActivityEndReason::Ended))
    })
    .await?;
    Ok(ActivityReply::default())
}

/// Relay `payload` to `to` or to every other participant.
pub async fn send(
    user_id: &str,
    channel_id: &str,
    instance_id: &str,
    payload: Value,
    to: Option<Vec<String>>,
) -> ActivityResult<ActivityReply> {
    require_identifiers(&[channel_id, instance_id])?;
    if let Some(to) = &to {
        if to.len() > logic::MAX_MESSAGE_RECIPIENTS
            || !to.iter().all(|target| logic::valid_identifier(target))
        {
            return Err(ActivityErrorCode::InvalidRequest.into());
        }
    }
    if logic::serialized_len(&payload) > logic::MAX_MESSAGE_BYTES {
        return Err(ActivityErrorCode::PayloadTooLarge.into());
    }

    let instance = participant_instance(user_id, channel_id, instance_id).await?;
    let recipients = logic::message_recipients(&instance, user_id, to.as_deref());
    let event = EventV1::ActivityMessage {
        instance_id: instance.id.clone(),
        from: user_id.to_string(),
        payload,
    };
    for recipient in recipients {
        event.clone().private(recipient).await;
    }
    Ok(ActivityReply::default())
}

/// Compare-and-set the shared state.
pub async fn set_state(
    user_id: &str,
    channel_id: &str,
    instance_id: &str,
    expected_version: u64,
    data: Value,
) -> ActivityResult<ActivityReply> {
    require_identifiers(&[channel_id, instance_id])?;
    if logic::serialized_len(&data) > logic::MAX_STATE_BYTES {
        return Err(ActivityErrorCode::PayloadTooLarge.into());
    }

    let instance = participant_instance(user_id, channel_id, instance_id).await?;
    let mut current = store::get_state(channel_id).await.map_err(internal)?;
    for _ in 0..MUTATION_RETRY_LIMIT {
        let Some(stored) = current else {
            return Err(ActivityErrorCode::InstanceNotFound.into());
        };
        let next = logic::next_state(
            &stored.value,
            instance_id,
            expected_version,
            data.clone(),
            user_id,
        )
        .map_err(|code| ActivityError {
            code,
            state: (code == ActivityErrorCode::VersionConflict).then(|| stored.value.clone()),
        })?;

        match store::set_state_if_current(channel_id, &stored, &next)
            .await
            .map_err(internal)?
        {
            CasResult::Applied => {
                publish_state(&instance, &next).await;
                return Ok(ActivityReply {
                    instance: None,
                    state: Some(next),
                });
            }
            CasResult::Conflict(conflict) => current = conflict,
        }
    }
    Err(ActivityErrorCode::Internal.into())
}

/// Instance and shared state for a participant (reconnect, frame reload).
pub async fn sync(
    user_id: &str,
    channel_id: &str,
    instance_id: &str,
) -> ActivityResult<ActivityReply> {
    require_identifiers(&[channel_id, instance_id])?;
    let instance = participant_instance(user_id, channel_id, instance_id).await?;
    let state = current_state(channel_id, &instance.id).await?;
    Ok(ActivityReply {
        instance: Some(instance),
        state,
    })
}

/// Remove a user who left voice from the channel's instance.
///
/// Failures are logged; the reconciler repairs anything missed here.
pub async fn remove_voice_member(channel_id: &str, user_id: &str) {
    let result = mutate(channel_id, |current| {
        Ok(match current {
            Some(instance) => logic::leave_decision(instance, user_id),
            None => Decision::Keep(None),
        })
    })
    .await;
    if let Err(error) = result {
        warn!(
            "Failed to remove voice member {user_id} from activity in {channel_id}: {:?}",
            error.code
        );
    }
}

/// Reconcile every running instance with voice membership and the registry.
pub async fn reconcile(db: &Database) -> Result<()> {
    for channel_id in store::running_channel_ids().await? {
        if let Err(error) = reconcile_channel(db, &channel_id).await {
            warn!(
                "Failed to reconcile activity in {channel_id}: {:?}",
                error.code
            );
        }
    }
    Ok(())
}

async fn reconcile_channel(db: &Database, channel_id: &str) -> ActivityResult<()> {
    let Some(current) = store::get_instance(channel_id).await.map_err(internal)? else {
        return store::forget_channel(channel_id).await.map_err(internal);
    };
    let instance = current.value;
    let available = available_application(db, &instance.application_id)
        .await
        .map_err(internal)?
        .is_some();
    let voice_members = if available {
        get_voice_channel_members(&UserVoiceChannel {
            id: instance.channel_id.clone(),
            server_id: instance.server_id.clone(),
        })
        .await
        .map_err(internal)?
        .unwrap_or_default()
    } else {
        Vec::new()
    };

    mutate(channel_id, |current| {
        Ok(logic::reconcile_decision(
            current,
            &instance.id,
            available,
            &voice_members,
        ))
    })
    .await?;
    Ok(())
}

/// Running instances in the given channels (Ready payload).
pub async fn instances_for_channels(channel_ids: &[String]) -> Result<Vec<ActivityInstance>> {
    store::get_instances(channel_ids).await
}

/// Instance of `application_id` the user currently participates in, found
/// through the user's voice channel.
pub async fn participating_instance(
    user_id: &str,
    application_id: &str,
) -> Result<Option<ActivityInstance>> {
    let Some(session) = get_active_voice_session_for_user(user_id).await? else {
        return Ok(None);
    };
    Ok(store::get_instance(&session.channel.id)
        .await?
        .map(|stored| stored.value)
        .filter(|instance| {
            instance.application_id == application_id && logic::is_participant(instance, user_id)
        }))
}

/// Application if registered and enabled.
pub async fn available_application(
    db: &Database,
    application_id: &str,
) -> Result<Option<ActivityApplication>> {
    match db.fetch_activity_application(application_id).await {
        Ok(application) => Ok(application.enabled.then_some(application)),
        Err(error) if matches!(error.error_type, ErrorType::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}

fn max_participants(application: &ActivityApplication) -> usize {
    usize::try_from(application.max_participants.max(1)).unwrap_or(1)
}

async fn require_voice_channel(
    user_id: &str,
    channel_id: &str,
) -> ActivityResult<UserVoiceChannel> {
    let session = get_active_voice_session_for_user(user_id)
        .await
        .map_err(internal)?
        .ok_or(ActivityErrorCode::NotInVoiceChannel)?;
    if session.channel.id != channel_id {
        return Err(ActivityErrorCode::NotInVoiceChannel.into());
    }
    Ok(session.channel)
}

async fn participant_instance(
    user_id: &str,
    channel_id: &str,
    instance_id: &str,
) -> ActivityResult<ActivityInstance> {
    let current = store::get_instance(channel_id).await.map_err(internal)?;
    let instance = logic::matching(current.as_ref().map(|stored| &stored.value), instance_id)?;
    if !logic::is_participant(instance, user_id) {
        return Err(ActivityErrorCode::NotParticipant.into());
    }
    Ok(instance.clone())
}

async fn current_state(
    channel_id: &str,
    instance_id: &str,
) -> ActivityResult<Option<ActivitySharedState>> {
    Ok(store::get_state(channel_id)
        .await
        .map_err(internal)?
        .map(|stored| stored.value)
        .filter(|state| state.instance_id == instance_id))
}

async fn reply_with_state(channel_id: &str, decision: Decision) -> ActivityResult<ActivityReply> {
    match decision {
        Decision::Create(instance, state) => Ok(ActivityReply {
            instance: Some(instance),
            state: Some(state),
        }),
        Decision::Update(instance) | Decision::Keep(Some(instance)) => {
            let state = current_state(channel_id, &instance.id).await?;
            Ok(ActivityReply {
                instance: Some(instance),
                state,
            })
        }
        Decision::Keep(None) | Decision::End(..) => Ok(ActivityReply::default()),
    }
}

/// Read, decide and compare-and-set the channel's instance, then publish the
/// applied change. Returns the applied decision.
async fn mutate(
    channel_id: &str,
    decide: impl Fn(Option<&ActivityInstance>) -> std::result::Result<Decision, ActivityErrorCode>,
) -> ActivityResult<Decision> {
    let mut current = store::get_instance(channel_id).await.map_err(internal)?;
    for _ in 0..MUTATION_RETRY_LIMIT {
        let decision = decide(current.as_ref().map(|stored| &stored.value))?;
        let mutation = match &decision {
            Decision::Keep(_) => return Ok(decision),
            Decision::Create(instance, state) => InstanceMutation::Create(instance, state),
            Decision::Update(instance) => InstanceMutation::Set(instance),
            Decision::End(..) => InstanceMutation::Delete,
        };
        match store::mutate_instance_if_current(channel_id, current.as_ref(), mutation)
            .await
            .map_err(internal)?
        {
            CasResult::Applied => {
                publish(&decision).await;
                return Ok(decision);
            }
            CasResult::Conflict(conflict) => current = conflict,
        }
    }
    Err(ActivityErrorCode::Internal.into())
}

async fn publish(decision: &Decision) {
    match decision {
        Decision::Keep(_) => {}
        Decision::Create(instance, _) | Decision::Update(instance) => {
            EventV1::ActivityInstanceUpdate {
                instance: instance.clone(),
            }
            .p(instance.channel_id.clone())
            .await;
        }
        Decision::End(instance, reason) => {
            EventV1::ActivityInstanceEnd {
                channel_id: instance.channel_id.clone(),
                instance_id: instance.id.clone(),
                reason: *reason,
            }
            .p(instance.channel_id.clone())
            .await;
        }
    }
}

async fn publish_state(instance: &ActivityInstance, state: &ActivitySharedState) {
    let event = EventV1::ActivityState {
        state: state.clone(),
    };
    for participant in &instance.participants {
        event.clone().private(participant.user_id.clone()).await;
    }
}
