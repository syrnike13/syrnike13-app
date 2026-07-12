use async_std::sync::Mutex;
use futures::SinkExt;
use syrnike_database::{
    AMQP, Database, User,
    events::client::{EventV1, GatewayErrorRequest, GatewayErrorScope},
    events::server::VoiceStateUpdateRequest,
    iso8601_timestamp::Timestamp,
    util::reference::Reference,
    voice::{
        VoiceClient, VoiceJoinOptions, VoiceRtcEngine, delete_current_voice_reservation,
        get_current_voice_authority, get_current_voice_operation_id, get_current_voice_session,
        get_user_voice_channels, get_voice_authority_snapshot, is_valid_voice_operation_id,
        join_voice_channel, publish_authoritative_voice_snapshot, publish_voice_state_snapshot,
        refresh_voice_credentials, remove_temporary_server_member_after_voice_disconnect,
        remove_user_from_voice_channel_with_call_cleanup, update_client_voice_flags,
    },
};
use syrnike_result::{Result, create_error};

use crate::{config::ProtocolConfiguration, websocket::WsWriter};

#[derive(Debug, Clone, PartialEq, Eq)]
enum SameChannelVoiceRequest {
    Join,
    RefreshCredentials {
        rtc_engine: VoiceRtcEngine,
        client_instance_id: String,
        connection_epoch: String,
    },
}

const MAX_VOICE_CLAIM_IDENTIFIER_BYTES: usize = 512;

fn valid_voice_claim_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_VOICE_CLAIM_IDENTIFIER_BYTES
        && !value.contains('|')
        && !value.chars().any(char::is_control)
}

fn validate_voice_operation_ids(request: &VoiceStateUpdateRequest) -> Result<()> {
    let valid = match request {
        VoiceStateUpdateRequest::RequestSnapshot => true,
        VoiceStateUpdateRequest::UpdateFlags {
            operation_id,
            rtc_engine,
            client_instance_id,
            connection_epoch,
        }
        | VoiceStateUpdateRequest::Disconnect {
            operation_id,
            rtc_engine,
            client_instance_id,
            connection_epoch,
        }
        | VoiceStateUpdateRequest::Join {
            operation_id,
            rtc_engine,
            client_instance_id,
            connection_epoch,
        }
        | VoiceStateUpdateRequest::RefreshCredentials {
            operation_id,
            rtc_engine,
            client_instance_id,
            connection_epoch,
        } => {
            is_valid_voice_operation_id(operation_id)
                && rtc_engine.parse::<VoiceRtcEngine>().is_ok()
                && valid_voice_claim_identifier(client_instance_id)
                && valid_voice_claim_identifier(connection_epoch)
        }
    };

    valid
        .then_some(())
        .ok_or_else(|| create_error!(InvalidOperation))
}

fn validate_same_channel_request(
    request: VoiceStateUpdateRequest,
    target_operation_id: &str,
) -> Result<SameChannelVoiceRequest> {
    match request {
        VoiceStateUpdateRequest::RequestSnapshot
        | VoiceStateUpdateRequest::UpdateFlags { .. }
        | VoiceStateUpdateRequest::Disconnect { .. } => Err(create_error!(InvalidOperation)),
        VoiceStateUpdateRequest::Join { operation_id, .. } => {
            if operation_id != target_operation_id {
                return Err(create_error!(InvalidOperation));
            }

            Ok(SameChannelVoiceRequest::Join)
        }
        VoiceStateUpdateRequest::RefreshCredentials {
            operation_id,
            rtc_engine,
            client_instance_id,
            connection_epoch,
        } => {
            if operation_id != target_operation_id {
                return Err(create_error!(InvalidOperation));
            }

            Ok(SameChannelVoiceRequest::RefreshCredentials {
                rtc_engine: rtc_engine
                    .parse()
                    .map_err(|_| create_error!(InvalidOperation))?,
                client_instance_id,
                connection_epoch,
            })
        }
    }
}

pub async fn handle_voice_state_update(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    user: &User,
    request: VoiceStateUpdateRequest,
    channel_id: Option<String>,
    self_mute: bool,
    self_deaf: bool,
    node: Option<String>,
    recipients: Option<Vec<String>>,
    suppress_call_notifications: bool,
) -> Result<Option<EventV1>> {
    validate_voice_operation_ids(&request)?;
    if matches!(request, VoiceStateUpdateRequest::RequestSnapshot) {
        publish_authoritative_voice_snapshot(&user.id).await?;
        return Ok(None);
    }
    if let VoiceStateUpdateRequest::Disconnect {
        operation_id,
        rtc_engine,
        client_instance_id,
        connection_epoch,
    } = &request
    {
        let disconnected_at = Timestamp::now_utc();
        let engine: VoiceRtcEngine = rtc_engine
            .parse()
            .map_err(|_| create_error!(InvalidOperation))?;
        let authority = get_voice_authority_snapshot(&user.id).await?;
        if let Some(reservation) = authority.reservation {
            if reservation.operation_id != *operation_id
                || reservation.rtc_engine != engine
                || reservation.client_instance_id != *client_instance_id
                || reservation.connection_epoch != *connection_epoch
                || !delete_current_voice_reservation(&reservation).await?
            {
                return Err(create_error!(InvalidOperation));
            }
            remove_temporary_server_member_after_voice_disconnect(
                db,
                &reservation.channel,
                &user.id,
                disconnected_at,
            )
            .await?;
        } else if let Some(session) = authority.session {
            if session.operation_id != *operation_id
                || session.rtc_engine != engine
                || session.client_instance_id != *client_instance_id
                || session.connection_epoch != *connection_epoch
            {
                return Err(create_error!(InvalidOperation));
            }
            remove_user_from_voice_channel_with_call_cleanup(db, amqp, &session.channel, &user.id)
                .await?;
        } else {
            return Err(create_error!(InvalidOperation));
        }
        publish_authoritative_voice_snapshot(&user.id).await?;
        return Ok(None);
    }

    let channel_id = channel_id.ok_or_else(|| create_error!(InvalidOperation))?;
    let channel = Reference::from_unchecked(&channel_id)
        .as_channel(db)
        .await?;

    if channel.voice().is_none() {
        return Err(create_error!(NotAVoiceChannel));
    }

    let user_voice_channel = syrnike_database::voice::UserVoiceChannel::from_channel(&channel);

    if let VoiceStateUpdateRequest::UpdateFlags {
        operation_id,
        rtc_engine,
        client_instance_id,
        connection_epoch,
    } = &request
    {
        let session = get_current_voice_session(&user.id)
            .await?
            .ok_or_else(|| create_error!(NotConnected))?;
        let engine: VoiceRtcEngine = rtc_engine
            .parse()
            .map_err(|_| create_error!(InvalidOperation))?;
        if session.operation_id != *operation_id
            || session.rtc_engine != engine
            || session.client_instance_id != *client_instance_id
            || session.connection_epoch != *connection_epoch
            || session.channel != user_voice_channel
        {
            return Err(create_error!(InvalidOperation));
        }
        let state = update_client_voice_flags(
            &user_voice_channel,
            &user.id,
            operation_id,
            self_mute,
            self_deaf,
        )
        .await?;
        publish_voice_state_snapshot(&channel_id, &state).await;
        publish_authoritative_voice_snapshot(&user.id).await?;
        return Ok(None);
    }

    let current_channels = get_user_voice_channels(&user.id).await?;
    let already_in_target = current_channels
        .iter()
        .any(|existing| existing == &user_voice_channel);

    if already_in_target && matches!(&request, VoiceStateUpdateRequest::RefreshCredentials { .. }) {
        let target_operation_id = get_current_voice_operation_id(&user_voice_channel, &user.id)
            .await?
            .ok_or_else(|| create_error!(InvalidOperation))?;

        let request = validate_same_channel_request(request, &target_operation_id)?;
        let operation_id = target_operation_id.as_str();
        let state = update_client_voice_flags(
            &user_voice_channel,
            &user.id,
            operation_id,
            self_mute,
            self_deaf,
        )
        .await?;
        publish_voice_state_snapshot(&channel_id, &state).await;

        return match request {
            SameChannelVoiceRequest::Join => Ok(None),
            SameChannelVoiceRequest::RefreshCredentials {
                rtc_engine,
                client_instance_id,
                connection_epoch,
            } => {
                let credentials = refresh_voice_credentials(
                    db,
                    voice_client,
                    user,
                    &channel_id,
                    operation_id,
                    rtc_engine,
                    &client_instance_id,
                    &connection_epoch,
                )
                .await?;
                Ok(Some(EventV1::VoiceServerUpdate {
                    operation_id: operation_id.to_string(),
                    authority_version: get_voice_authority_snapshot(&user.id).await?.version,
                    channel_id: credentials.channel_id,
                    node: credentials.node,
                    url: credentials.url,
                    credential: credentials.credential,
                }))
            }
        };
    }

    let (operation_id, rtc_engine, client_instance_id, connection_epoch) = match request {
        VoiceStateUpdateRequest::Join {
            operation_id,
            rtc_engine,
            client_instance_id,
            connection_epoch,
        } => (
            operation_id,
            rtc_engine
                .parse()
                .map_err(|_| create_error!(InvalidOperation))?,
            client_instance_id,
            connection_epoch,
        ),
        VoiceStateUpdateRequest::RequestSnapshot
        | VoiceStateUpdateRequest::UpdateFlags { .. }
        | VoiceStateUpdateRequest::Disconnect { .. }
        | VoiceStateUpdateRequest::RefreshCredentials { .. } => {
            return Err(create_error!(InvalidOperation));
        }
    };
    let credentials = join_voice_channel(
        db,
        voice_client,
        amqp,
        user,
        &channel_id,
        VoiceJoinOptions {
            node,
            operation_id: Some(operation_id.clone()),
            expected_current_operation_id: get_current_voice_authority(&user.id)
                .await?
                .map(|(operation_id, _)| operation_id),
            rtc_engine: Some(rtc_engine),
            client_instance_id: Some(client_instance_id),
            connection_epoch: Some(connection_epoch),
            recipients,
            suppress_call_notifications,
            self_mute,
            self_deaf,
        },
    )
    .await?;
    let authority_version = publish_authoritative_voice_snapshot(&user.id).await?;

    Ok(Some(EventV1::VoiceServerUpdate {
        operation_id,
        authority_version,
        channel_id: credentials.channel_id,
        node: credentials.node,
        url: credentials.url,
        credential: credentials.credential,
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
    request: GatewayErrorRequest,
) {
    write
        .lock()
        .await
        .send(config.encode(&EventV1::Error {
            data: error,
            fatal: false,
            scope: GatewayErrorScope::VoiceStateUpdate,
            request: Some(request),
        }))
        .await
        .ok();
}

#[cfg(test)]
mod tests {
    use super::validate_voice_operation_ids;
    use syrnike_database::events::server::VoiceStateUpdateRequest;

    #[test]
    fn authority_claims_are_required_on_join() {
        let request = VoiceStateUpdateRequest::Join {
            operation_id: "voice-op-550e8400-e29b-41d4-a716-446655440000".to_string(),
            rtc_engine: "windows_native".to_string(),
            client_instance_id: "client-a".to_string(),
            connection_epoch: "epoch-a".to_string(),
        };
        assert!(validate_voice_operation_ids(&request).is_ok());
    }

    #[test]
    fn oversized_authority_claims_are_rejected_before_redis_or_livekit() {
        let oversized = "x".repeat(513);
        for (client_instance_id, connection_epoch) in [
            (oversized.clone(), "epoch-a".to_string()),
            ("client-a".to_string(), oversized.clone()),
        ] {
            let request = VoiceStateUpdateRequest::Join {
                operation_id: "voice-op-550e8400-e29b-41d4-a716-446655440000".to_string(),
                rtc_engine: "windows_native".to_string(),
                client_instance_id,
                connection_epoch,
            };
            assert!(validate_voice_operation_ids(&request).is_err());
        }
    }

    #[test]
    fn identity_delimiters_are_rejected_in_authority_claims() {
        let request = VoiceStateUpdateRequest::Join {
            operation_id: "voice-op-550e8400-e29b-41d4-a716-446655440000".to_string(),
            rtc_engine: "web".to_string(),
            client_instance_id: "client|forged".to_string(),
            connection_epoch: "epoch-a".to_string(),
        };
        assert!(validate_voice_operation_ids(&request).is_err());
    }
}
