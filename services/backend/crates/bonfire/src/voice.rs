use async_std::sync::Mutex;
use futures::SinkExt;
use syrnike_database::{
    events::client::{EventV1, GatewayErrorRequest, GatewayErrorScope},
    events::server::VoiceStateUpdateRequest,
    util::reference::Reference,
    voice::{
        cancel_current_pending_voice_join, get_current_voice_operation_id, get_user_voice_channels,
        is_valid_voice_operation_id, join_voice_channel, publish_voice_state_snapshot,
        refresh_voice_credentials, remove_user_from_voice_channel_with_call_cleanup,
        retain_current_voice_operation_id, update_client_voice_flags, VoiceClient,
        VoiceJoinOptions,
    },
    Database, User, AMQP,
};
use syrnike_models::v0::UserVoiceState;
use syrnike_result::{create_error, Result};

use crate::{config::ProtocolConfiguration, websocket::WsWriter};

#[derive(Debug, Clone, PartialEq, Eq)]
enum SameChannelVoiceRequest {
    Join { operation_id: String },
    RefreshCredentials { operation_id: String },
}

fn validate_voice_operation_ids(request: &VoiceStateUpdateRequest) -> Result<()> {
    let valid = match request {
        VoiceStateUpdateRequest::Disconnect => true,
        VoiceStateUpdateRequest::Join { operation_id }
        | VoiceStateUpdateRequest::RefreshCredentials { operation_id } => {
            is_valid_voice_operation_id(operation_id)
        }
        VoiceStateUpdateRequest::ReplaceOperation {
            operation_id,
            expected_current_operation_id,
        }
        | VoiceStateUpdateRequest::RetainFinalized {
            operation_id,
            expected_current_operation_id,
        } => {
            is_valid_voice_operation_id(operation_id)
                && is_valid_voice_operation_id(expected_current_operation_id)
                && operation_id != expected_current_operation_id
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
        VoiceStateUpdateRequest::Disconnect => Err(create_error!(InvalidOperation)),
        VoiceStateUpdateRequest::Join { operation_id } => {
            if operation_id != target_operation_id {
                return Err(create_error!(InvalidOperation));
            }

            Ok(SameChannelVoiceRequest::Join { operation_id })
        }
        VoiceStateUpdateRequest::RefreshCredentials { operation_id } => {
            if operation_id != target_operation_id {
                return Err(create_error!(InvalidOperation));
            }

            Ok(SameChannelVoiceRequest::RefreshCredentials { operation_id })
        }
        VoiceStateUpdateRequest::ReplaceOperation { .. }
        | VoiceStateUpdateRequest::RetainFinalized { .. } => Err(create_error!(InvalidOperation)),
    }
}

async fn publish_authoritative_voice_commit(
    channel_id: &str,
    operation_id: &str,
    state: &UserVoiceState,
) {
    EventV1::VoiceChannelJoin {
        id: channel_id.to_string(),
        operation_id: Some(operation_id.to_string()),
        state: state.clone(),
    }
    .p(channel_id.to_string())
    .await;
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
    if matches!(request, VoiceStateUpdateRequest::Disconnect) {
        cancel_current_pending_voice_join(&user.id).await?;
        for channel in get_user_voice_channels(&user.id).await? {
            remove_user_from_voice_channel_with_call_cleanup(db, amqp, &channel, &user.id).await?;
        }
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

    if let VoiceStateUpdateRequest::RetainFinalized {
        operation_id,
        expected_current_operation_id,
    } = &request
    {
        retain_current_voice_operation_id(
            voice_client,
            &user_voice_channel,
            &user.id,
            expected_current_operation_id,
            operation_id,
        )
        .await?;
        let state = update_client_voice_flags(
            &user_voice_channel,
            &user.id,
            operation_id,
            self_mute,
            self_deaf,
        )
        .await?;
        publish_voice_state_snapshot(&channel_id, &state).await;
        publish_authoritative_voice_commit(&channel_id, operation_id, &state).await;
        let credentials =
            refresh_voice_credentials(db, voice_client, user, &channel_id, operation_id).await?;
        return Ok(Some(EventV1::VoiceServerUpdate {
            operation_id: operation_id.clone(),
            channel_id: credentials.channel_id,
            node: credentials.node,
            url: credentials.url,
            token: credentials.token,
            native_microphone: credentials.native_microphone,
            native_screen: credentials.native_screen,
            native_camera: credentials.native_camera,
        }));
    }

    let current_channels = get_user_voice_channels(&user.id).await?;
    let already_in_target = current_channels
        .iter()
        .any(|existing| existing == &user_voice_channel);

    if already_in_target && !matches!(&request, VoiceStateUpdateRequest::ReplaceOperation { .. }) {
        let target_operation_id = get_current_voice_operation_id(&user_voice_channel, &user.id)
            .await?
            .ok_or_else(|| create_error!(InvalidOperation))?;

        let request = validate_same_channel_request(request, &target_operation_id)?;
        let operation_id = match &request {
            SameChannelVoiceRequest::Join { operation_id }
            | SameChannelVoiceRequest::RefreshCredentials { operation_id } => operation_id,
        };
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
            SameChannelVoiceRequest::Join { .. } => Ok(None),
            SameChannelVoiceRequest::RefreshCredentials { operation_id } => {
                let credentials =
                    refresh_voice_credentials(db, voice_client, user, &channel_id, &operation_id)
                        .await?;
                Ok(Some(EventV1::VoiceServerUpdate {
                    operation_id,
                    channel_id: credentials.channel_id,
                    node: credentials.node,
                    url: credentials.url,
                    token: credentials.token,
                    native_microphone: credentials.native_microphone,
                    native_screen: credentials.native_screen,
                    native_camera: credentials.native_camera,
                }))
            }
        };
    }

    let (operation_id, expected_current_operation_id) = match request {
        VoiceStateUpdateRequest::Join { operation_id } => (operation_id, None),
        VoiceStateUpdateRequest::ReplaceOperation {
            operation_id,
            expected_current_operation_id,
        } => (operation_id, Some(expected_current_operation_id)),
        VoiceStateUpdateRequest::Disconnect
        | VoiceStateUpdateRequest::RefreshCredentials { .. }
        | VoiceStateUpdateRequest::RetainFinalized { .. } => {
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
            expected_current_operation_id,
            recipients,
            suppress_call_notifications,
            self_mute,
            self_deaf,
        },
    )
    .await?;

    Ok(Some(EventV1::VoiceServerUpdate {
        operation_id,
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
    use super::{
        validate_same_channel_request, validate_voice_operation_ids, SameChannelVoiceRequest,
    };
    use syrnike_database::events::server::VoiceStateUpdateRequest;
    use syrnike_result::ErrorType;

    #[test]
    fn wire_operation_ids_use_the_voice_prefixed_uuid_contract() {
        assert!(
            validate_voice_operation_ids(&VoiceStateUpdateRequest::Join {
                operation_id: "voice-op-550e8400-e29b-41d4-a716-446655440000".to_string(),
            })
            .is_ok()
        );

        for operation_id in [
            "550e8400-e29b-41d4-a716-446655440000",
            "voice-op-not-a-uuid",
            "op-a",
        ] {
            assert!(
                validate_voice_operation_ids(&VoiceStateUpdateRequest::Join {
                    operation_id: operation_id.to_string(),
                })
                .is_err()
            );
        }
    }

    #[test]
    fn stale_same_channel_requests_are_rejected_before_side_effects() {
        for request in [
            VoiceStateUpdateRequest::Join {
                operation_id: "op-stale".to_string(),
            },
            VoiceStateUpdateRequest::RefreshCredentials {
                operation_id: "op-stale".to_string(),
            },
            VoiceStateUpdateRequest::ReplaceOperation {
                operation_id: "op-next".to_string(),
                expected_current_operation_id: "op-stale".to_string(),
            },
        ] {
            let error = validate_same_channel_request(request, "op-target")
                .expect_err("stale request must fail validation before effects");
            assert!(matches!(error.error_type, ErrorType::InvalidOperation));
        }
    }

    #[test]
    fn replace_same_channel_request_is_rejected_in_favor_of_typed_retain() {
        let error = validate_same_channel_request(
            VoiceStateUpdateRequest::ReplaceOperation {
                operation_id: "op-next".to_string(),
                expected_current_operation_id: "op-current".to_string(),
            },
            "op-retained",
        )
        .expect_err("same-channel replacement must use retain_finalized");

        assert!(matches!(error.error_type, ErrorType::InvalidOperation));
    }

    #[test]
    fn refresh_same_channel_request_uses_target_channel_operation() {
        let request = validate_same_channel_request(
            VoiceStateUpdateRequest::RefreshCredentials {
                operation_id: "op-retained".to_string(),
            },
            "op-retained",
        )
        .expect("refresh request validates against retained target operation");

        assert_eq!(
            request,
            SameChannelVoiceRequest::RefreshCredentials {
                operation_id: "op-retained".to_string()
            }
        );
    }

    #[test]
    fn retained_restore_has_a_distinct_validated_wire_mode() {
        let request = VoiceStateUpdateRequest::RetainFinalized {
            operation_id: "voice-op-550e8400-e29b-41d4-a716-446655440000".to_string(),
            expected_current_operation_id: "voice-op-550e8400-e29b-41d4-a716-446655440001"
                .to_string(),
        };

        assert!(validate_voice_operation_ids(&request).is_ok());
        assert!(validate_same_channel_request(request, "unused").is_err());
    }

    #[test]
    fn retained_restore_rejects_stale_expected_reservation_operation() {
        let error = validate_same_channel_request(
            VoiceStateUpdateRequest::RetainFinalized {
                operation_id: "op-retained".to_string(),
                expected_current_operation_id: "op-stale".to_string(),
            },
            "op-retained",
        )
        .expect_err("stale retained restore must fail before side effects");

        assert!(matches!(error.error_type, ErrorType::InvalidOperation));
    }
}
