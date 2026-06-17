use serde::{Deserialize, Serialize};

use super::client::{Activity, Ping};

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
    UserActivityUpdate {
        activity: Option<Activity>,
        #[serde(rename = "activitySourceId")]
        #[serde(skip_serializing_if = "Option::is_none")]
        activity_source_id: Option<String>,
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
    fn user_activity_update_deserializes_discord_like_payload() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "UserActivityUpdate",
            "activity": {
                "activitySourceId": "desktop:game",
                "type": "playing",
                "name": "Counter-Strike 2",
                "details": "Premier",
                "state": "Mirage",
                "timestamps": {
                    "start": 1781517900000u64
                },
                "assets": {
                    "largeImageUrl": "https://cdn.example.test/cs2.jpg",
                    "largeText": "Counter-Strike 2"
                },
                "secrets": {
                    "join": "must-not-be-modeled"
                },
                "observedAt": 1781518000000u64
            }
        }))
        .expect("activity update deserializes");

        let ClientMessage::UserActivityUpdate { activity, .. } = message else {
            panic!("expected UserActivityUpdate");
        };

        let activity = activity.expect("activity payload");
        assert_eq!(activity.activity_source_id, "desktop:game");
        assert_eq!(activity.name, "Counter-Strike 2");
        assert_eq!(activity.details.as_deref(), Some("Premier"));
        assert_eq!(activity.timestamps.unwrap().start, Some(1781517900000));
    }

    #[test]
    fn user_activity_update_accepts_null_clear_signal() {
        let message = serde_json::from_value::<ClientMessage>(serde_json::json!({
            "type": "UserActivityUpdate",
            "activitySourceId": "desktop:game",
            "activity": null
        }))
        .expect("activity clear deserializes");

        let ClientMessage::UserActivityUpdate {
            activity,
            activity_source_id,
        } = message
        else {
            panic!("expected UserActivityUpdate");
        };

        assert!(activity.is_none());
        assert_eq!(activity_source_id.as_deref(), Some("desktop:game"));
    }
}
