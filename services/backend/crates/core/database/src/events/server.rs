use serde::{Deserialize, Serialize};

use super::client::Ping;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum VoiceStateUpdateRequest {
    Disconnect,
    Join {
        operation_id: String,
    },
    RefreshCredentials {
        operation_id: String,
    },
    ReplaceOperation {
        operation_id: String,
        expected_current_operation_id: String,
    },
    RetainFinalized {
        operation_id: String,
        expected_current_operation_id: String,
    },
}

impl VoiceStateUpdateRequest {
    pub fn operation_id(&self) -> Option<&str> {
        match self {
            Self::Disconnect => None,
            Self::Join { operation_id }
            | Self::RefreshCredentials { operation_id }
            | Self::ReplaceOperation { operation_id, .. }
            | Self::RetainFinalized { operation_id, .. } => Some(operation_id.as_str()),
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ClientMessage {
    Authenticate {
        token: String,
    },
    BeginTyping {
        channel: String,
    },
    EndTyping {
        channel: String,
    },
    UserActivity,
    Subscribe {
        server_id: String,
    },
    Ping {
        data: Ping,
        responded: Option<()>,
    },
    VoiceStateUpdate {
        nonce: Option<String>,
        channel_id: Option<String>,
        self_mute: bool,
        self_deaf: bool,
        node: Option<String>,
        recipients: Option<Vec<String>>,
        suppress_call_notifications: Option<bool>,
        request: VoiceStateUpdateRequest,
    },
}

#[cfg(test)]
mod tests {
    use super::{ClientMessage, VoiceStateUpdateRequest};

    #[test]
    fn voice_state_update_deserializes_refresh_request() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "VoiceStateUpdate",
            "nonce": "nonce-1",
            "channel_id": "channel-1",
            "self_mute": false,
            "self_deaf": false,
            "node": "node-1",
            "request": {
                "mode": "refresh_credentials",
                "operation_id": "op-join"
            }
        }))
        .expect("voice state update deserializes");

        let ClientMessage::VoiceStateUpdate { request, .. } = message else {
            panic!("expected VoiceStateUpdate");
        };

        assert_eq!(
            request,
            VoiceStateUpdateRequest::RefreshCredentials {
                operation_id: "op-join".to_string()
            }
        );
    }

    #[test]
    fn voice_state_update_deserializes_replace_request_with_expected_current_operation() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "VoiceStateUpdate",
            "nonce": "nonce-2",
            "channel_id": "channel-1",
            "self_mute": true,
            "self_deaf": false,
            "request": {
                "mode": "replace_operation",
                "operation_id": "op-next",
                "expected_current_operation_id": "op-current"
            }
        }))
        .expect("voice state update deserializes");

        let ClientMessage::VoiceStateUpdate { request, .. } = message else {
            panic!("expected VoiceStateUpdate");
        };

        assert_eq!(
            request,
            VoiceStateUpdateRequest::ReplaceOperation {
                operation_id: "op-next".to_string(),
                expected_current_operation_id: "op-current".to_string()
            }
        );
    }

    #[test]
    fn voice_state_update_deserializes_retain_finalized_request() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "VoiceStateUpdate",
            "nonce": "nonce-3",
            "channel_id": "channel-a",
            "self_mute": false,
            "self_deaf": false,
            "request": {
                "mode": "retain_finalized",
                "operation_id": "op-a",
                "expected_current_operation_id": "op-b"
            }
        }))
        .expect("retain finalized request deserializes");

        let ClientMessage::VoiceStateUpdate { request, .. } = message else {
            panic!("expected VoiceStateUpdate");
        };
        assert_eq!(
            request,
            VoiceStateUpdateRequest::RetainFinalized {
                operation_id: "op-a".to_string(),
                expected_current_operation_id: "op-b".to_string(),
            }
        );
    }
}
