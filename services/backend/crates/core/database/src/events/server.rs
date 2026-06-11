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
        channel_id: Option<String>,
        self_mute: bool,
        self_deaf: bool,
        node: Option<String>,
        force_disconnect: Option<bool>,
        recipients: Option<Vec<String>>,
        refresh_credentials: Option<bool>,
    },
}
