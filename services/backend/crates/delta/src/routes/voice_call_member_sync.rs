use syrnike_database::{
    events::client::EventV1,
    voice::{
        call_lifecycle::{get_channel_voice_call, VoiceCallPhase},
        get_channel_voice_state, UserVoiceChannel,
    },
    Channel,
};
use syrnike_result::Result;

pub(crate) async fn send_group_voice_call_to_new_member(
    member_id: &str,
    channel: &Channel,
) -> Result<()> {
    let Some(call) = get_channel_voice_call(channel.id()).await? else {
        return Ok(());
    };

    if call.phase == VoiceCallPhase::Ringing {
        let mut recipients = call.ringing_recipients;
        if !recipients.iter().any(|recipient| recipient == member_id) {
            recipients.push(member_id.to_string());
        }

        EventV1::VoiceCallRinging {
            channel_id: call.channel_id,
            initiator_id: call.initiator_id,
            started_at: call.started_at,
            expires_at: call.expires_at.unwrap_or(call.started_at),
            recipients,
            declined_recipients: call.declined_recipients,
        }
        .private(member_id.to_string())
        .await;

        return Ok(());
    }

    if let Some(voice_state) =
        get_channel_voice_state(&UserVoiceChannel::from_channel(channel)).await?
    {
        for participant in voice_state.participants {
            EventV1::VoiceStateUpdate {
                channel_id: call.channel_id.clone(),
                state: participant,
            }
            .private(member_id.to_string())
            .await;
        }
    }

    EventV1::VoiceCallActive {
        channel_id: call.channel_id,
        initiator_id: call.initiator_id,
        started_at: call.started_at,
        expires_at: call.expires_at,
        declined_recipients: call.declined_recipients,
    }
    .private(member_id.to_string())
    .await;

    Ok(())
}
