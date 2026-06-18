use super::{Channel, File, Server, User};

#[cfg(feature = "validator")]
use validator::Validate;

auto_derived!(
    /// Invite
    #[serde(tag = "type")]
    pub enum Invite {
        /// Invite to a specific server channel
        Server {
            /// Invite code
            #[cfg_attr(feature = "serde", serde(rename = "_id"))]
            code: String,
            /// Id of the server this invite points to
            server: String,
            /// Id of user who created this invite
            creator: String,
            /// Id of the server channel this invite points to
            channel: String,
            /// Invite creation time in milliseconds since Unix epoch
            created_at: u64,
            /// Invite expiry time in milliseconds since Unix epoch
            expires_at: Option<u64>,
            /// Maximum number of successful joins
            max_uses: Option<u64>,
            /// Number of successful joins through this invite
            uses: u64,
            /// Invite revocation time in milliseconds since Unix epoch
            revoked_at: Option<u64>,
            /// Id of user who revoked this invite
            revoked_by: Option<String>,
            /// Whether membership should be temporary
            temporary: bool,
        },
        /// Invite to a group channel
        Group {
            /// Invite code
            #[cfg_attr(feature = "serde", serde(rename = "_id"))]
            code: String,
            /// Id of user who created this invite
            creator: String,
            /// Id of the group channel this invite points to
            channel: String,
            /// Invite creation time in milliseconds since Unix epoch
            created_at: u64,
            /// Invite expiry time in milliseconds since Unix epoch
            expires_at: Option<u64>,
            /// Maximum number of successful joins
            max_uses: Option<u64>,
            /// Number of successful joins through this invite
            uses: u64,
            /// Invite revocation time in milliseconds since Unix epoch
            revoked_at: Option<u64>,
            /// Id of user who revoked this invite
            revoked_by: Option<String>,
            /// Whether membership should be temporary
            temporary: bool,
        },
    }

    /// Information for new channel invite
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataCreateInvite {
        /// Invite lifetime in seconds. Zero means no expiry.
        #[cfg_attr(feature = "validator", validate(range(min = 0, max = 604800)))]
        pub max_age_seconds: Option<u64>,
        /// Maximum number of successful joins. Zero means unlimited.
        #[cfg_attr(feature = "validator", validate(range(min = 0, max = 100)))]
        pub max_uses: Option<u64>,
        /// Whether membership should be temporary
        pub temporary: Option<bool>,
        /// Audit log reason
        #[cfg_attr(feature = "validator", validate(length(max = 512)))]
        pub reason: Option<String>,
    }

    /// Public invite response
    #[allow(clippy::large_enum_variant)]
    #[serde(tag = "type")]
    pub enum InviteResponse {
        /// Server channel invite
        Server {
            /// Invite code
            code: String,
            /// Id of the server
            server_id: String,
            /// Name of the server
            server_name: String,
            /// Attachment for server icon
            #[serde(skip_serializing_if = "Option::is_none")]
            server_icon: Option<File>,
            /// Attachment for server banner
            #[serde(skip_serializing_if = "Option::is_none")]
            server_banner: Option<File>,
            /// Enum of server flags
            #[serde(skip_serializing_if = "Option::is_none")]
            server_flags: Option<i32>,
            /// Id of server channel
            channel_id: String,
            /// Name of server channel
            channel_name: String,
            /// Description of server channel
            #[serde(skip_serializing_if = "Option::is_none")]
            channel_description: Option<String>,
            /// Name of user who created the invite
            user_name: String,
            /// Avatar of the user who created the invite
            #[serde(skip_serializing_if = "Option::is_none")]
            user_avatar: Option<File>,
            /// Number of members in this server
            member_count: i64,
        },
        /// Group channel invite
        Group {
            /// Invite code
            code: String,
            /// Id of group channel
            channel_id: String,
            /// Name of group channel
            channel_name: String,
            /// Description of group channel
            #[serde(skip_serializing_if = "Option::is_none")]
            channel_description: Option<String>,
            /// Name of user who created the invite
            user_name: String,
            /// Avatar of the user who created the invite
            #[serde(skip_serializing_if = "Option::is_none")]
            user_avatar: Option<File>,
        },
    }

    /// Invite join response
    #[serde(tag = "type")]
    #[allow(clippy::large_enum_variant)]
    pub enum InviteJoinResponse {
        Server {
            /// Channels in the server
            channels: Vec<Channel>,
            /// Server we are joining
            server: Server,
        },
        Group {
            /// Group channel we are joining
            channel: Channel,
            /// Members of this group
            users: Vec<User>,
        },
    }
);
