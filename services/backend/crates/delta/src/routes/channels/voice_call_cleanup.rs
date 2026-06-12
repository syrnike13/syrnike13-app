use syrnike_database::{
    events::client::EventV1,
    iso8601_timestamp::{Duration, Timestamp},
    voice::{
        call_lifecycle::{
            get_channel_voice_call, mutate_channel_voice_call_if_current, VoiceCallPhase,
            VoiceCallStateMutation, VoiceCallStateMutationResult, GROUP_UNANSWERED_ACTIVE_SECONDS,
        },
        delete_voice_channel, finish_voice_call_started_system_message,
        remove_user_from_voice_channel_with_call_cleanup, UserVoiceChannel, VoiceClient,
    },
    Channel, Database, VoiceCallEndReason, AMQP,
};
use syrnike_result::{create_error, Result};

const VOICE_CALL_MUTATION_RETRY_LIMIT: usize = 8;

pub(crate) async fn stop_ringing_for_removed_group_member(
    amqp: &AMQP,
    channel_id: &str,
    member_id: &str,
) -> Result<()> {
    for _ in 0..VOICE_CALL_MUTATION_RETRY_LIMIT {
        let Some(call) = get_channel_voice_call(channel_id).await? else {
            return Ok(());
        };

        if call.phase != VoiceCallPhase::Ringing
            || !call
                .ringing_recipients
                .iter()
                .any(|recipient_id| recipient_id == member_id)
        {
            return Ok(());
        }

        let mut next_call = call.clone();
        next_call
            .ringing_recipients
            .retain(|recipient_id| recipient_id != member_id);
        if next_call.ringing_recipients.is_empty() {
            next_call.phase = VoiceCallPhase::Active;
            next_call.expires_at = Some(
                next_call.expires_at.unwrap_or_else(Timestamp::now_utc)
                    + Duration::seconds(GROUP_UNANSWERED_ACTIVE_SECONDS),
            );
        }

        if let VoiceCallStateMutationResult::Conflict(_) = mutate_channel_voice_call_if_current(
            channel_id,
            Some(&call),
            VoiceCallStateMutation::Set(next_call.clone()),
        )
        .await?
        {
            continue;
        }

        if let Err(error) = amqp
            .dm_call_updated(
                &next_call.initiator_id,
                channel_id,
                None,
                true,
                Some(vec![member_id.to_string()]),
            )
            .await
        {
            syrnike_config::capture_internal_error!(&error);
        }

        if next_call.phase == VoiceCallPhase::Active {
            EventV1::VoiceCallActive {
                channel_id: next_call.channel_id.clone(),
                initiator_id: next_call.initiator_id.clone(),
                started_at: next_call.started_at,
                expires_at: next_call.expires_at,
                declined_recipients: next_call.declined_recipients.clone(),
            }
            .p(next_call.channel_id.clone())
            .await;
        }

        return Ok(());
    }

    Err(create_error!(InternalError))
}

pub(crate) async fn remove_group_member_from_voice_call(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    channel: &Channel,
    member_id: &str,
) -> Result<()> {
    let user_voice_channel = UserVoiceChannel::from_channel(channel);
    remove_user_from_voice_channel_with_call_cleanup(
        db,
        voice_client,
        amqp,
        &user_voice_channel,
        member_id,
    )
    .await
}

pub(crate) async fn delete_group_voice_call(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    channel: &Channel,
) -> Result<()> {
    let user_voice_channel = UserVoiceChannel::from_channel(channel);

    delete_voice_channel(voice_client, &user_voice_channel).await?;

    for _ in 0..VOICE_CALL_MUTATION_RETRY_LIMIT {
        let Some(call) = get_channel_voice_call(channel.id()).await? else {
            return Ok(());
        };

        if let VoiceCallStateMutationResult::Conflict(_) = mutate_channel_voice_call_if_current(
            channel.id(),
            Some(&call),
            VoiceCallStateMutation::Delete,
        )
        .await?
        {
            continue;
        }

        EventV1::VoiceCallEnd {
            channel_id: call.channel_id.clone(),
        }
        .p(call.channel_id.clone())
        .await;

        if let Err(error) = amqp
            .dm_call_updated(
                &call.initiator_id,
                &call.channel_id,
                None,
                true,
                (!call.ringing_recipients.is_empty()).then_some(call.ringing_recipients.clone()),
            )
            .await
        {
            syrnike_config::capture_internal_error!(&error);
        }

        let ended_reason = if call.phase == VoiceCallPhase::Active && call.expires_at.is_none() {
            VoiceCallEndReason::Completed
        } else {
            VoiceCallEndReason::Cancelled
        };

        if let Err(error) = finish_voice_call_started_system_message(
            db,
            &call.channel_id,
            Timestamp::now_utc(),
            ended_reason,
        )
        .await
        {
            syrnike_config::capture_internal_error!(&error);
        }

        return Ok(());
    }

    Err(create_error!(InternalError))
}
