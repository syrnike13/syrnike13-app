use async_std::sync::Mutex;
use futures::SinkExt;
use syrnike_database::{
    events::client::EventV1,
    util::reference::Reference,
    voice::{
        get_user_voice_channels, join_voice_channel, publish_voice_state_snapshot,
        refresh_voice_credentials, remove_user_from_voice_channel_with_call_cleanup,
        set_user_voice_join_intent, update_client_voice_flags, VoiceClient, VoiceJoinOptions,
    },
    Database, User, AMQP,
};
use syrnike_result::{create_error, Result};

use crate::{config::ProtocolConfiguration, websocket::WsWriter};

pub async fn handle_voice_state_update(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    user: &User,
    channel_id: Option<String>,
    self_mute: bool,
    self_deaf: bool,
    node: Option<String>,
    force_disconnect: Option<bool>,
    recipients: Option<Vec<String>>,
    suppress_call_notifications: bool,
    refresh_credentials: bool,
) -> Result<Option<EventV1>> {
    if channel_id.is_none() {
        for channel in get_user_voice_channels(&user.id).await? {
            remove_user_from_voice_channel_with_call_cleanup(
                db,
                voice_client,
                amqp,
                &channel,
                &user.id,
            )
            .await?;
        }

        return Ok(None);
    }

    let channel_id = channel_id.expect("channel_id checked above");
    let channel = Reference::from_unchecked(&channel_id)
        .as_channel(db)
        .await?;

    if channel.voice().is_none() {
        return Err(create_error!(NotAVoiceChannel));
    }

    let user_voice_channel = syrnike_database::voice::UserVoiceChannel::from_channel(&channel);
    let current_channels = get_user_voice_channels(&user.id).await?;
    let already_in_target = current_channels
        .iter()
        .any(|existing| existing == &user_voice_channel);

    if already_in_target {
        set_user_voice_join_intent(&user.id, &user_voice_channel, self_mute, self_deaf).await?;

        let state =
            update_client_voice_flags(&user_voice_channel, &user.id, self_mute, self_deaf).await?;
        publish_voice_state_snapshot(&channel_id, &state).await;

        if !refresh_credentials {
            return Ok(None);
        }

        let credentials = refresh_voice_credentials(db, voice_client, user, &channel_id).await?;
        return Ok(Some(EventV1::VoiceServerUpdate {
            channel_id: credentials.channel_id,
            node: credentials.node,
            url: credentials.url,
            token: credentials.token,
            native_microphone: credentials.native_microphone,
            native_screen: credentials.native_screen,
            native_camera: credentials.native_camera,
        }));
    }

    let credentials = join_voice_channel(
        db,
        voice_client,
        amqp,
        user,
        &channel_id,
        VoiceJoinOptions {
            node,
            force_disconnect,
            recipients,
            suppress_call_notifications,
            self_mute,
            self_deaf,
        },
    )
    .await?;

    Ok(Some(EventV1::VoiceServerUpdate {
        channel_id: credentials.channel_id,
        node: credentials.node,
        url: credentials.url,
        token: credentials.token,
        native_microphone: credentials.native_microphone,
        native_screen: credentials.native_screen,
        native_camera: credentials.native_camera,
    }))
}

pub async fn send_voice_server_update(
    write: &Mutex<WsWriter>,
    config: &ProtocolConfiguration,
    event: EventV1,
) {
    write.lock().await.send(config.encode(&event)).await.ok();
}

pub async fn send_voice_state_ack(
    write: &Mutex<WsWriter>,
    config: &ProtocolConfiguration,
    nonce: Option<String>,
    channel_id: Option<String>,
    ok: bool,
) {
    let Some(nonce) = nonce else {
        return;
    };

    write
        .lock()
        .await
        .send(config.encode(&EventV1::VoiceStateAck {
            nonce,
            channel_id,
            ok,
        }))
        .await
        .ok();
}

pub async fn send_voice_error(
    write: &Mutex<WsWriter>,
    config: &ProtocolConfiguration,
    error: syrnike_result::Error,
) {
    write
        .lock()
        .await
        .send(config.encode(&EventV1::Error { data: error }))
        .await
        .ok();
}
