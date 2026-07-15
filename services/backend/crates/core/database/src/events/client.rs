use authifier::AuthifierEvent;
use iso8601_timestamp::Timestamp;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use syrnike_result::Error;

use syrnike_models::v0::{
    AppendMessage, Channel, ChannelSlowmode, ChannelUnread, ChannelVoiceState, Emoji,
    FieldsChannel, FieldsMember, FieldsMessage, FieldsRole, FieldsServer, FieldsUser,
    FieldsWebhook, Member, MemberCompositeKey, Message, PartialChannel, PartialEmoji,
    PartialMember, PartialMessage, PartialRole, PartialServer, PartialUser, PartialWebhook,
    PolicyChange, RemovalIntention, Report, Server, User, UserSettings, UserVoiceState, Webhook,
};

use crate::Database;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceRtcEngine {
    Web,
    WindowsNative,
}

impl std::fmt::Display for VoiceRtcEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Web => "web",
            Self::WindowsNative => "windows_native",
        })
    }
}

impl std::str::FromStr for VoiceRtcEngine {
    type Err = ();
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "web" => Ok(Self::Web),
            "windows_native" => Ok(Self::WindowsNative),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceRtcCredential {
    pub rtc_engine: VoiceRtcEngine,
    pub client_instance_id: String,
    pub connection_epoch: String,
    pub token: String,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceAuthorityMembershipClaim {
    pub operation_id: String,
    pub channel_id: String,
    pub rtc_engine: VoiceRtcEngine,
    pub client_instance_id: String,
    pub connection_epoch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceAuthorityLease {
    pub operation_id: String,
    pub authority_version: u64,
    pub channel_id: String,
    pub node: String,
    pub url: String,
    pub credential: VoiceRtcCredential,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoritative_operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoritative_channel_id: Option<String>,
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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationSnapshot {
    pub revision: u64,
    pub global: u64,
    pub servers: HashMap<String, u64>,
    pub channels: HashMap<String, u64>,
    pub users: HashMap<String, u64>,
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
    pub authorization: bool,
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
            authorization: true,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        authorization: Option<AuthorizationSnapshot>,
    },

    /// Ping response
    Pong {
        data: Ping,
    },
    AuthorizationSnapshot {
        snapshot: AuthorizationSnapshot,
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
        member: Member,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        operation_id: Option<String>,
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
        authority_version: u64,
        channel_id: String,
        node: String,
        url: String,
        credential: VoiceRtcCredential,
    },
    VoiceAuthoritySnapshot {
        version: u64,
        operation_id: Option<String>,
        channel_id: Option<String>,
        rtc_engine: Option<VoiceRtcEngine>,
        client_instance_id: Option<String>,
        connection_epoch: Option<String>,
        state: Option<UserVoiceState>,
    },
    VoiceAuthorityMove {
        from: VoiceAuthorityMembershipClaim,
        lease: VoiceAuthorityLease,
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
        match &self {
            Self::VoiceAuthorityMove { .. } => {
                info!("Publishing VoiceAuthorityMove to {channel} [credentials redacted]")
            }
            Self::VoiceServerUpdate { .. } => {
                info!("Publishing VoiceServerUpdate to {channel} [credentials redacted]")
            }
            _ => info!("Publishing event to {channel}: {self:?}"),
        }

        #[cfg(debug_assertions)]
        if let Err(error) = redis_kiss::publish(channel, self).await {
            info!("Failed to publish event: {error:?}");
        }
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
        EventV1, GatewayErrorRequest, GatewayErrorScope, GatewayRequestKind, VoiceAuthorityLease,
        VoiceAuthorityMembershipClaim, VoiceRtcCredential, VoiceRtcEngine,
    };
    use iso8601_timestamp::Timestamp;
    use serde_json::json;
    use syrnike_models::v0::UserVoiceState;
    use syrnike_result::{Error, ErrorType};

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

    #[async_std::test]
    async fn publish_helper_does_not_panic_when_redis_is_unavailable() {
        EventV1::VoiceCallEnd {
            channel_id: "channel-1".to_string(),
        }
        .p("test-channel".to_string())
        .await;
    }

    #[test]
    fn voice_server_update_serializes_operation_id() {
        let event = EventV1::VoiceServerUpdate {
            operation_id: "op-join".to_string(),
            authority_version: 7,
            channel_id: "channel-1".to_string(),
            node: "node-1".to_string(),
            url: "wss://livekit.example".to_string(),
            credential: VoiceRtcCredential {
                rtc_engine: VoiceRtcEngine::Web,
                client_instance_id: "client-1".to_string(),
                connection_epoch: "epoch-1".to_string(),
                token: "token".to_string(),
                identity: "identity".to_string(),
            },
        };

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["type"], json!("VoiceServerUpdate"));
        assert_eq!(value["operation_id"], json!("op-join"));
        assert_eq!(value["channel_id"], json!("channel-1"));
    }

    #[test]
    fn voice_authority_move_serializes_both_exact_claims() {
        let event = EventV1::VoiceAuthorityMove {
            from: VoiceAuthorityMembershipClaim {
                operation_id: "op-a".to_string(),
                channel_id: "channel-a".to_string(),
                rtc_engine: VoiceRtcEngine::WindowsNative,
                client_instance_id: "client-a".to_string(),
                connection_epoch: "epoch-a".to_string(),
            },
            lease: VoiceAuthorityLease {
                operation_id: "op-b".to_string(),
                authority_version: 12,
                channel_id: "channel-b".to_string(),
                node: "node-b".to_string(),
                url: "wss://livekit.example".to_string(),
                credential: VoiceRtcCredential {
                    rtc_engine: VoiceRtcEngine::WindowsNative,
                    client_instance_id: "client-a".to_string(),
                    connection_epoch: "epoch-b".to_string(),
                    token: "token-b".to_string(),
                    identity: "identity-b".to_string(),
                },
            },
        };

        let value = serde_json::to_value(event).expect("event serializes");
        assert_eq!(value["type"], json!("VoiceAuthorityMove"));
        assert_eq!(value["from"]["operation_id"], json!("op-a"));
        assert_eq!(value["from"]["connection_epoch"], json!("epoch-a"));
        assert_eq!(value["lease"]["operation_id"], json!("op-b"));
        assert_eq!(value["lease"]["authority_version"], json!(12));
        assert_eq!(
            value["lease"]["credential"]["connection_epoch"],
            json!("epoch-b")
        );
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
                authoritative_operation_id: Some("op-current".to_string()),
                authoritative_channel_id: Some("channel-current".to_string()),
            }),
        };

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["type"], json!("Error"));
        assert_eq!(value["fatal"], json!(false));
        assert_eq!(value["scope"], json!("VoiceStateUpdate"));
        assert_eq!(value["request"]["kind"], json!("VoiceStateUpdate"));
        assert_eq!(value["request"]["nonce"], json!("nonce-1"));
        assert_eq!(
            value["request"]["authoritative_operation_id"],
            json!("op-current")
        );
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
}
