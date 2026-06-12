use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    events::client::EventV1,
    iso8601_timestamp::Timestamp,
    util::reference::Reference,
    voice::{
        call_lifecycle::{
            get_channel_voice_call, mutate_channel_voice_call_if_current,
            voice_call_decline_effect, VoiceCallDeclineEffect, VoiceCallStateMutation,
            VoiceCallStateMutationResult, GROUP_UNANSWERED_ACTIVE_SECONDS,
        },
        VoiceClient,
    },
    Channel, Database, User, AMQP,
};
use syrnike_result::{create_error, Result};

const VOICE_CALL_MUTATION_RETRY_LIMIT: usize = 8;

/// # Decline Call
/// Declines an incoming one-to-one DM call without ending the call.
/// The declined call remains joinable while the caller stays connected.
#[openapi(tag = "Voice")]
#[put("/<target>/voice/decline")]
pub async fn decline_call(
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
        decline_voice_call_state(&channel_id, &user.id, &recipients).await?;

    EventV1::VoiceCallActive {
        channel_id: state.channel_id.clone(),
        initiator_id: state.initiator_id.clone(),
        started_at: state.started_at,
        expires_at: state.expires_at,
        declined_recipients: state.declined_recipients.clone(),
    }
    .p(channel_id.clone())
    .await;

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

    Ok(EmptyResponse)
}

async fn decline_voice_call_state(
    channel_id: &str,
    user_id: &str,
    recipients: &[String],
) -> Result<(
    syrnike_database::voice::call_lifecycle::VoiceCallState,
    Vec<String>,
)> {
    for _ in 0..VOICE_CALL_MUTATION_RETRY_LIMIT {
        let existing_call = get_channel_voice_call(channel_id).await?;
        let VoiceCallDeclineEffect::Decline {
            state,
            stop_ringing_recipients,
        } = voice_call_decline_effect(
            existing_call.as_ref(),
            user_id,
            recipients,
            Timestamp::now_utc(),
            GROUP_UNANSWERED_ACTIVE_SECONDS,
        )
        else {
            return Err(create_error!(NoEffect));
        };

        if let VoiceCallStateMutationResult::Conflict(_) = mutate_channel_voice_call_if_current(
            channel_id,
            existing_call.as_ref(),
            VoiceCallStateMutation::Set(state.clone()),
        )
        .await?
        {
            continue;
        }

        return Ok((state, stop_ringing_recipients));
    }

    Err(create_error!(InternalError))
}
