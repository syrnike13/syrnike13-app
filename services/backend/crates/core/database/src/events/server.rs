use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::Ping;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum VoiceStateUpdateRequest {
    RequestSnapshot,
    UpdateFlags {
        operation_id: String,
        rtc_engine: String,
        client_instance_id: String,
        connection_epoch: String,
    },
    Disconnect {
        operation_id: String,
        rtc_engine: String,
        client_instance_id: String,
        connection_epoch: String,
    },
    Join {
        operation_id: String,
        rtc_engine: String,
        client_instance_id: String,
        connection_epoch: String,
    },
    RefreshCredentials {
        operation_id: String,
        rtc_engine: String,
        client_instance_id: String,
        connection_epoch: String,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ChannelActivityRequest {
    Sync,
    Start { application_id: String },
    Join { instance_id: String },
    Leave { instance_id: String },
    Command { instance_id: String, command: Value },
    Close { instance_id: String },
}

impl VoiceStateUpdateRequest {
    pub fn operation_id(&self) -> Option<&str> {
        match self {
            Self::RequestSnapshot => None,
            Self::UpdateFlags { operation_id, .. }
            | Self::Disconnect { operation_id, .. }
            | Self::Join { operation_id, .. }
            | Self::RefreshCredentials { operation_id, .. } => Some(operation_id.as_str()),
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
    ChannelActivity {
        request_id: String,
        channel_id: String,
        request: ChannelActivityRequest,
    },
}

#[cfg(test)]
mod tests {
    use super::{ChannelActivityRequest, ClientMessage, VoiceStateUpdateRequest};

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
                "operation_id": "op-join",
                "rtc_engine": "web",
                "client_instance_id": "client-1",
                "connection_epoch": "epoch-1"
            }
        }))
        .expect("voice state update deserializes");

        let ClientMessage::VoiceStateUpdate { request, .. } = message else {
            panic!("expected VoiceStateUpdate");
        };

        assert_eq!(
            request,
            VoiceStateUpdateRequest::RefreshCredentials {
                operation_id: "op-join".to_string(),
                rtc_engine: "web".to_string(),
                client_instance_id: "client-1".to_string(),
                connection_epoch: "epoch-1".to_string(),
            }
        );
    }

    #[test]
    fn channel_activity_command_deserializes_typed_request() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "ChannelActivity",
            "request_id": "request-1",
            "channel_id": "channel-1",
            "request": {
                "action": "command",
                "instance_id": "activity-1",
                "command": { "type": "increment" }
            }
        }))
        .expect("channel activity command deserializes");

        let ClientMessage::ChannelActivity { request, .. } = message else {
            panic!("expected ChannelActivity");
        };

        assert_eq!(
            request,
            ChannelActivityRequest::Command {
                instance_id: "activity-1".to_string(),
                command: serde_json::json!({ "type": "increment" }),
            }
        );
    }
}
