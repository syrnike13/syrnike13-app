use serde::{Deserialize, Serialize};

use super::client::Ping;

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
        operation_id: Option<String>,
        channel_id: Option<String>,
        self_mute: bool,
        self_deaf: bool,
        node: Option<String>,
        recipients: Option<Vec<String>>,
        suppress_call_notifications: Option<bool>,
        refresh_credentials: Option<bool>,
    },
}

#[cfg(test)]
mod tests {
    use super::ClientMessage;

    #[test]
    fn voice_state_update_deserializes_operation_id() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "VoiceStateUpdate",
            "nonce": "nonce-1",
            "operation_id": "op-join",
            "channel_id": "channel-1",
            "self_mute": false,
            "self_deaf": false,
            "node": "node-1",
            "refresh_credentials": true
        }))
        .expect("voice state update deserializes");

        let ClientMessage::VoiceStateUpdate { operation_id, .. } = message else {
            panic!("expected VoiceStateUpdate");
        };

        assert_eq!(operation_id, Some("op-join".to_string()));
    }
}
