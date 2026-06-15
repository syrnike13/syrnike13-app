use serde::{Deserialize, Serialize};

use super::client::{MusicPresence, Ping};

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
    UserMusicPresenceUpdate {
        presence: Option<MusicPresence>,
    },
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

    #[test]
    fn music_presence_update_deserializes_camel_case_payload() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "UserMusicPresenceUpdate",
            "presence": {
                "provider": "spotify",
                "source": "desktop_now_playing",
                "title": "PRAXX",
                "artists": ["DK"],
                "durationMs": 225000,
                "progressMs": 15000,
                "isPlaying": true,
                "observedAt": 1781518000000u64
            }
        }))
        .expect("music presence update deserializes");

        let ClientMessage::UserMusicPresenceUpdate { presence } = message else {
            panic!("expected UserMusicPresenceUpdate");
        };

        let presence = presence.expect("presence payload");
        assert_eq!(presence.title, "PRAXX");
        assert_eq!(presence.duration_ms, Some(225000));
        assert!(presence.is_playing);
    }

    #[test]
    fn music_presence_update_accepts_null_clear_signal() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "UserMusicPresenceUpdate",
            "presence": null
        }))
        .expect("music presence clear deserializes");

        let ClientMessage::UserMusicPresenceUpdate { presence } = message else {
            panic!("expected UserMusicPresenceUpdate");
        };

        assert!(presence.is_none());
    }
}
