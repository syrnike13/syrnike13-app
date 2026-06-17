use authifier::AuthifierEvent;
use iso8601_timestamp::Timestamp;
use serde::{Deserialize, Serialize};
use syrnike_result::Error;

use syrnike_models::v0::{
    AppendMessage, Channel, ChannelSlowmode, ChannelUnread, ChannelVoiceState, Emoji,
    FieldsChannel, FieldsMember, FieldsMessage, FieldsRole, FieldsServer, FieldsUser,
    FieldsWebhook, Member, MemberCompositeKey, Message, NativeVoiceCredentials, PartialChannel,
    PartialEmoji, PartialMember, PartialMessage, PartialRole, PartialServer, PartialUser,
    PartialWebhook, PolicyChange, RemovalIntention, Report, Server, User, UserSettings,
    UserVoiceState, Webhook,
};

use crate::Database;

/// Ping Packet
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum Ping {
    Binary(Vec<u8>),
    Number(usize),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum VoiceCallPhase {
    Ringing,
    Active,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum GatewayErrorScope {
    Session,
    VoiceStateUpdate,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum GatewayRequestKind {
    VoiceStateUpdate,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GatewayErrorRequest {
    pub kind: GatewayRequestKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VoiceCall {
    pub channel_id: String,
    pub initiator_id: String,
    pub phase: VoiceCallPhase,
    pub started_at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    pub recipients: Vec<String>,
    #[serde(default)]
    pub declined_recipients: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MusicProviderId {
    Spotify,
    AppleMusic,
    YandexMusic,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MusicPresenceSource {
    SpotifyApi,
    DesktopNowPlaying,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicPresence {
    pub provider: MusicProviderId,
    pub source: MusicPresenceSource,
    pub title: String,
    pub artists: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_ms: Option<u64>,
    pub is_playing: bool,
    pub observed_at: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityType {
    Playing,
    Streaming,
    Listening,
    Watching,
    Custom,
    Competing,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatusDisplayType {
    Name,
    State,
    Details,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTimestamps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAssets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_cover_image_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPartySize {
    pub current: u64,
    pub max: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityParty {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<ActivityPartySize>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityButton {
    pub label: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub activity_source_id: String,
    #[serde(rename = "type")]
    pub activity_type: ActivityType,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    pub observed_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamps: Option<ActivityTimestamps>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_display_type: Option<ActivityStatusDisplayType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets: Option<ActivityAssets>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party: Option<ActivityParty>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buttons: Option<Vec<ActivityButton>>,
}

/// Fields provided in Ready payload
#[derive(PartialEq, Debug, Clone, Deserialize)]
pub struct ReadyPayloadFields {
    pub users: bool,
    pub servers: bool,
    pub channels: bool,
    pub members: bool,
    pub emojis: bool,
    pub voice_states: bool,
    pub voice_calls: bool,
    pub user_settings: Vec<String>,
    pub channel_unreads: bool,
    pub policy_changes: bool,
}

impl Default for ReadyPayloadFields {
    fn default() -> Self {
        Self {
            users: true,
            servers: true,
            channels: true,
            members: true,
            emojis: true,
            voice_states: true,
            voice_calls: true,
            user_settings: Vec::new(),
            channel_unreads: false,
            policy_changes: true,
        }
    }
}

/// Protocol Events
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum EventV1 {
    /// Multiple events
    Bulk {
        v: Vec<EventV1>,
    },
    /// Error event
    Error {
        data: Error,
        fatal: bool,
        scope: GatewayErrorScope,
        #[serde(skip_serializing_if = "Option::is_none")]
        request: Option<GatewayErrorRequest>,
    },

    /// Successfully authenticated
    Authenticated,
    /// Logged out
    Logout,
    /// Basic data to cache
    Ready {
        #[serde(skip_serializing_if = "Option::is_none")]
        users: Option<Vec<User>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        servers: Option<Vec<Server>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        channels: Option<Vec<Channel>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        members: Option<Vec<Member>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        emojis: Option<Vec<Emoji>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        voice_states: Option<Vec<ChannelVoiceState>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        voice_calls: Option<Vec<VoiceCall>>,

        #[serde(skip_serializing_if = "Option::is_none")]
        user_settings: Option<UserSettings>,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel_unreads: Option<Vec<ChannelUnread>>,

        #[serde(skip_serializing_if = "Option::is_none")]
        policy_changes: Option<Vec<PolicyChange>>,
    },

    /// Ping response
    Pong {
        data: Ping,
    },
    /// New message
    Message(Message),

    /// Update existing message
    MessageUpdate {
        id: String,
        channel: String,
        data: PartialMessage,
        #[serde(default)]
        clear: Vec<FieldsMessage>,
    },

    /// Append information to existing message
    MessageAppend {
        id: String,
        channel: String,
        append: AppendMessage,
    },

    /// Delete message
    MessageDelete {
        id: String,
        channel: String,
    },

    /// New reaction to a message
    MessageReact {
        id: String,
        channel_id: String,
        user_id: String,
        emoji_id: String,
    },

    /// Remove user's reaction from message
    MessageUnreact {
        id: String,
        channel_id: String,
        user_id: String,
        emoji_id: String,
    },

    /// Remove a reaction from message
    MessageRemoveReaction {
        id: String,
        channel_id: String,
        emoji_id: String,
    },

    /// Bulk delete messages
    BulkMessageDelete {
        channel: String,
        ids: Vec<String>,
    },

    /// New server
    ServerCreate {
        id: String,
        server: Server,
        channels: Vec<Channel>,
        emojis: Vec<Emoji>,
        voice_states: Vec<ChannelVoiceState>,
    },

    /// Update existing server
    ServerUpdate {
        id: String,
        data: PartialServer,
        #[serde(default)]
        clear: Vec<FieldsServer>,
    },

    /// Delete server
    ServerDelete {
        id: String,
    },

    /// Update existing server member
    ServerMemberUpdate {
        id: MemberCompositeKey,
        data: PartialMember,
        #[serde(default)]
        clear: Vec<FieldsMember>,
    },

    /// User joins server
    ServerMemberJoin {
        id: String,
        // Deprecated: use member.id.user
        #[deprecated = "Use member.id.user instead"]
        user: String,
        member: Member,
    },

    /// User left server
    ServerMemberLeave {
        id: String,
        user: String,
        reason: RemovalIntention,
    },

    /// Server role created or updated
    ServerRoleUpdate {
        id: String,
        role_id: String,
        data: PartialRole,
        #[serde(default)]
        clear: Vec<FieldsRole>,
    },

    /// Server role deleted
    ServerRoleDelete {
        id: String,
        role_id: String,
    },

    /// Server roles ranks updated
    ServerRoleRanksUpdate {
        id: String,
        ranks: Vec<String>,
    },

    /// Update existing user
    UserUpdate {
        id: String,
        data: PartialUser,
        #[serde(default)]
        clear: Vec<FieldsUser>,
        event_id: Option<String>,
    },

    /// Relationship with another user changed
    UserRelationship {
        id: String,
        user: User,
    },
    /// User started, changed, or cleared an activity slot.
    UserActivity {
        id: String,
        #[serde(rename = "activitySourceId")]
        #[serde(skip_serializing_if = "Option::is_none")]
        activity_source_id: Option<String>,
        activity: Option<Activity>,
    },
    /// Settings updated remotely
    UserSettingsUpdate {
        id: String,
        update: UserSettings,
    },

    /// User has been platform banned or deleted their account
    ///
    /// Clients should remove the following associated data:
    /// - Messages
    /// - DM Channels
    /// - Relationships
    /// - Server Memberships
    ///
    /// User flags are specified to explain why a wipe is occurring though not all reasons will necessarily ever appear.
    UserPlatformWipe {
        user_id: String,
        flags: i32,
    },
    /// New emoji
    EmojiCreate(Emoji),

    /// Update existing emoji
    EmojiUpdate {
        id: String,
        data: PartialEmoji,
    },

    /// Delete emoji
    EmojiDelete {
        id: String,
    },

    /// New report
    ReportCreate(Report),
    /// New channel
    ChannelCreate(Channel),

    /// Update existing channel
    ChannelUpdate {
        id: String,
        data: PartialChannel,
        #[serde(default)]
        clear: Vec<FieldsChannel>,
    },

    /// Delete channel
    ChannelDelete {
        id: String,
    },

    /// User joins a group
    ChannelGroupJoin {
        id: String,
        user: String,
    },

    /// User leaves a group
    ChannelGroupLeave {
        id: String,
        user: String,
    },

    /// User started typing in a channel
    ChannelStartTyping {
        id: String,
        user: String,
    },

    /// User stopped typing in a channel
    ChannelStopTyping {
        id: String,
        user: String,
    },

    /// User acknowledged message in channel
    ChannelAck {
        id: String,
        user: String,
        message_id: String,
    },

    /// New webhook
    WebhookCreate(Webhook),

    /// Update existing webhook
    WebhookUpdate {
        id: String,
        data: PartialWebhook,
        remove: Vec<FieldsWebhook>,
    },

    /// Delete webhook
    WebhookDelete {
        id: String,
    },

    /// Auth events
    Auth(AuthifierEvent),

    /// Voice events
    VoiceChannelJoin {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        operation_id: Option<String>,
        state: UserVoiceState,
    },
    VoiceChannelLeave {
        id: String,
        user: String,
    },
    VoiceChannelMove {
        user: String,
        from: String,
        to: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        operation_id: Option<String>,
        state: UserVoiceState,
    },
    VoiceStateUpdate {
        channel_id: String,
        state: UserVoiceState,
    },
    VoiceCallRinging {
        channel_id: String,
        initiator_id: String,
        started_at: Timestamp,
        expires_at: Timestamp,
        recipients: Vec<String>,
        declined_recipients: Vec<String>,
    },
    VoiceCallActive {
        channel_id: String,
        initiator_id: String,
        started_at: Timestamp,
        #[serde(skip_serializing_if = "Option::is_none")]
        expires_at: Option<Timestamp>,
        declined_recipients: Vec<String>,
    },
    VoiceCallEnd {
        channel_id: String,
    },
    VoiceStateAck {
        nonce: String,
        channel_id: Option<String>,
        ok: bool,
    },
    VoiceServerUpdate {
        operation_id: String,
        channel_id: String,
        node: String,
        url: String,
        token: String,
        native_microphone: NativeVoiceCredentials,
        native_screen: NativeVoiceCredentials,
        native_camera: NativeVoiceCredentials,
    },
    UserMoveVoiceChannel {
        node: String,
        from: String,
        to: String,
        token: String,
    },
    /// User's active slowmodes
    UserSlowmodes {
        slowmodes: Vec<ChannelSlowmode>,
    },
}

impl EventV1 {
    /// Publish helper wrapper
    pub async fn p(self, channel: String) {
        #[cfg(not(debug_assertions))]
        redis_kiss::p(channel, self).await;

        #[cfg(debug_assertions)]
        info!("Publishing event to {channel}: {self:?}");

        #[cfg(debug_assertions)]
        redis_kiss::publish(channel, self).await.unwrap();
    }

    /// Publish user event
    pub async fn p_user(self, id: String, db: &Database) {
        self.clone().p(id.clone()).await;

        // TODO: this should be captured by member list in the future and not immediately fanned out to users
        if let Ok(members) = db.fetch_all_memberships(&id).await {
            for member in members {
                self.clone().server(member.id.server).await;
            }
        }
    }

    /// Publish private event
    pub async fn private(self, id: String) {
        self.p(format!("{id}!")).await;
    }

    /// Publish server member event
    pub async fn server(self, id: String) {
        self.p(format!("{id}u")).await;
    }

    /// Publish internal global event
    pub async fn global(self) {
        self.p("global".to_string()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Activity, ActivityType, EventV1, GatewayErrorRequest, GatewayErrorScope, GatewayRequestKind,
    };
    use iso8601_timestamp::Timestamp;
    use serde_json::json;
    use syrnike_models::v0::{NativeVoiceCredentials, UserVoiceState};
    use syrnike_result::{Error, ErrorType};

    fn native_credentials(kind: &str) -> NativeVoiceCredentials {
        NativeVoiceCredentials {
            token: format!("{kind}-token"),
            identity: format!("user-1:desktop-native:{kind}"),
        }
    }

    fn voice_state() -> UserVoiceState {
        UserVoiceState {
            id: "user-1".to_string(),
            joined_at: Timestamp::UNIX_EPOCH,
            self_mute: false,
            self_deaf: false,
            server_muted: false,
            server_deafened: false,
            screensharing: false,
            camera: false,
            version: 1,
        }
    }

    #[test]
    fn voice_server_update_serializes_operation_id() {
        let event = EventV1::VoiceServerUpdate {
            operation_id: "op-join".to_string(),
            channel_id: "channel-1".to_string(),
            node: "node-1".to_string(),
            url: "wss://livekit.example".to_string(),
            token: "browser-token".to_string(),
            native_microphone: native_credentials("microphone"),
            native_screen: native_credentials("screen"),
            native_camera: native_credentials("camera"),
        };

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["type"], json!("VoiceServerUpdate"));
        assert_eq!(value["operation_id"], json!("op-join"));
        assert_eq!(value["channel_id"], json!("channel-1"));
    }

    #[test]
    fn request_scoped_error_serializes_gateway_disposition() {
        let event = EventV1::Error {
            data: Error {
                error_type: ErrorType::InvalidOperation,
                location: "voice.rs:1:1".to_string(),
            },
            fatal: false,
            scope: GatewayErrorScope::VoiceStateUpdate,
            request: Some(GatewayErrorRequest {
                kind: GatewayRequestKind::VoiceStateUpdate,
                nonce: Some("nonce-1".to_string()),
                operation_id: Some("op-join".to_string()),
                channel_id: Some("channel-1".to_string()),
            }),
        };

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["type"], json!("Error"));
        assert_eq!(value["fatal"], json!(false));
        assert_eq!(value["scope"], json!("VoiceStateUpdate"));
        assert_eq!(value["request"]["kind"], json!("VoiceStateUpdate"));
        assert_eq!(value["request"]["nonce"], json!("nonce-1"));
        assert_eq!(value["request"]["operation_id"], json!("op-join"));
        assert_eq!(value["request"]["channel_id"], json!("channel-1"));
    }

    #[test]
    fn voice_channel_join_serializes_operation_id() {
        let event = EventV1::VoiceChannelJoin {
            id: "channel-1".to_string(),
            operation_id: Some("op-join".to_string()),
            state: voice_state(),
        };

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["type"], json!("VoiceChannelJoin"));
        assert_eq!(value["id"], json!("channel-1"));
        assert_eq!(value["operation_id"], json!("op-join"));
    }

    #[test]
    fn voice_channel_move_serializes_operation_id() {
        let event = EventV1::VoiceChannelMove {
            user: "user-1".to_string(),
            from: "channel-1".to_string(),
            to: "channel-2".to_string(),
            operation_id: Some("op-move".to_string()),
            state: voice_state(),
        };

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["type"], json!("VoiceChannelMove"));
        assert_eq!(value["to"], json!("channel-2"));
        assert_eq!(value["operation_id"], json!("op-move"));
    }

    #[test]
    fn user_activity_serializes_camel_case_payload() {
        let event = EventV1::UserActivity {
            id: "user-1".to_string(),
            activity_source_id: None,
            activity: Some(Activity {
                activity_source_id: "desktop:game".to_string(),
                activity_type: ActivityType::Playing,
                name: "Counter-Strike 2".to_string(),
                url: None,
                created_at: None,
                observed_at: 1781518000000,
                timestamps: None,
                application_id: None,
                status_display_type: None,
                details: Some("Premier".to_string()),
                details_url: None,
                state: Some("Mirage".to_string()),
                state_url: None,
                assets: None,
                party: None,
                instance: None,
                flags: None,
                buttons: None,
            }),
        };

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["type"], json!("UserActivity"));
        assert_eq!(value["id"], json!("user-1"));
        assert_eq!(value["activity"]["activitySourceId"], json!("desktop:game"));
        assert_eq!(value["activity"]["type"], json!("playing"));
        assert_eq!(value["activity"]["name"], json!("Counter-Strike 2"));
        assert_eq!(value["activity"]["details"], json!("Premier"));
    }

    #[test]
    fn user_activity_clear_serializes_source_id_as_camel_case() {
        let event = EventV1::UserActivity {
            id: "user-1".to_string(),
            activity_source_id: Some("desktop:game".to_string()),
            activity: None,
        };

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["type"], json!("UserActivity"));
        assert_eq!(value["id"], json!("user-1"));
        assert_eq!(value["activitySourceId"], json!("desktop:game"));
        assert!(value["activity"].is_null());
    }
}
