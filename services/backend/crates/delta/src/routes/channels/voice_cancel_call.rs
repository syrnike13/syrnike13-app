use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    events::client::EventV1,
    iso8601_timestamp::Timestamp,
    util::reference::Reference,
    voice::{
        call_lifecycle::{
            get_channel_voice_call, mutate_channel_voice_call_if_current, voice_call_cancel_effect,
            VoiceCallCancelEffect, VoiceCallStateMutation, VoiceCallStateMutationResult,
        },
        delete_voice_channel, finish_voice_call_started_system_message, UserVoiceChannel,
        VoiceClient,
    },
    Channel, Database, User, VoiceCallEndReason, AMQP,
};
use syrnike_result::{create_error, Result};

const VOICE_CALL_MUTATION_RETRY_LIMIT: usize = 8;

/// # Cancel Call
/// Cancels a ringing one-to-one DM call.
/// The authenticated user must be one of the DM participants.
#[openapi(tag = "Voice")]
#[put("/<target>/voice/cancel")]
pub async fn cancel_call(
    db: &State<Database>,
    amqp: &State<AMQP>,
    voice: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
) -> Result<EmptyResponse> {
    if !voice.is_enabled() {
        return Err(create_error!(LiveKitUnavailable));
    }

    let channel = target.as_channel(db).await?;
    if channel.has_bot_recipient(db).await? {
        return Err(create_error!(NotFound));
    }

    let (channel_id, recipients) = match &channel {
        Channel::DirectMessage { id, recipients, .. } => (id.clone(), recipients.clone()),
        Channel::Group { recipients, .. } => {
            if recipients
                .iter()
                .any(|recipient_id| recipient_id == &user.id)
            {
                return Err(create_error!(NoEffect));
            }
            return Err(create_error!(NotFound));
        }
        _ => return Err(create_error!(NoEffect)),
    };

    if !recipients
        .iter()
        .any(|recipient_id| recipient_id == &user.id)
    {
        return Err(create_error!(NotFound));
    }

    let (state, stop_ringing_recipients) =
        cancel_voice_call_state(&channel_id, &user.id, &recipients).await?;

    EventV1::VoiceCallEnd {
        channel_id: channel_id.clone(),
    }
    .p(channel_id.clone())
    .await;

    if !stop_ringing_recipients.is_empty() {
        if let Err(error) = amqp
            .dm_call_updated(
                &state.initiator_id,
                &channel_id,
                None,
                true,
                Some(stop_ringing_recipients),
            )
            .await
        {
            syrnike_config::capture_internal_error!(&error);
        }
    }

    if let Err(error) = finish_voice_call_started_system_message(
        db,
        &channel_id,
        Timestamp::now_utc(),
        VoiceCallEndReason::Cancelled,
    )
    .await
    {
        syrnike_config::capture_internal_error!(&error);
    }

    delete_voice_channel(
        voice,
        &UserVoiceChannel {
            id: channel_id,
            server_id: None,
        },
    )
    .await?;

    Ok(EmptyResponse)
}

async fn cancel_voice_call_state(
    channel_id: &str,
    user_id: &str,
    recipients: &[String],
) -> Result<(
    syrnike_database::voice::call_lifecycle::VoiceCallState,
    Vec<String>,
)> {
    for _ in 0..VOICE_CALL_MUTATION_RETRY_LIMIT {
        let existing_call = get_channel_voice_call(channel_id).await?;
        let VoiceCallCancelEffect::Cancel {
            state,
            stop_ringing_recipients,
        } = voice_call_cancel_effect(existing_call.as_ref(), user_id, recipients)
        else {
            return Err(create_error!(NoEffect));
        };

        if let VoiceCallStateMutationResult::Conflict(_) = mutate_channel_voice_call_if_current(
            channel_id,
            existing_call.as_ref(),
            VoiceCallStateMutation::Delete,
        )
        .await?
        {
            continue;
        }

        return Ok((state, stop_ringing_recipients));
    }

    Err(create_error!(InternalError))
}
