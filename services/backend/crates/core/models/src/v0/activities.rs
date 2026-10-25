use iso8601_timestamp::Timestamp;
use once_cell::sync::Lazy;
use regex::Regex;

use super::File;

#[cfg(feature = "validator")]
use validator::Validate;

#[cfg(feature = "rocket")]
use rocket::FromForm;

/// Application ids are DNS labels: they become the Activity Origin subdomain.
pub static RE_ACTIVITY_APPLICATION_ID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$").unwrap());

/// `url_mappings` prefixes, served at `/.proxy/{prefix}/` on the Activity Origin.
pub static RE_ACTIVITY_URL_MAPPING_PREFIX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,31}$").unwrap());

/// Score and leaderboard keys.
pub static RE_ACTIVITY_SCORE_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z0-9][a-z0-9_.-]{0,63}$").unwrap());

auto_derived!(
    /// Activity Application as visible to every client.
    pub struct ActivityApplication {
        /// Application id, also the Activity Origin subdomain
        #[cfg_attr(feature = "serde", serde(rename = "_id"))]
        pub id: String,
        /// Display name
        pub name: String,
        /// Short description
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub description: Option<String>,
        /// Icon
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub icon: Option<File>,
        /// Activity Origin the client loads in the Activity Frame
        pub activity_url: String,
        /// Maximum number of participants in one instance
        pub max_participants: u32,
        /// First-party applications skip the authorization consent dialog
        #[cfg_attr(
            feature = "serde",
            serde(skip_serializing_if = "crate::if_false", default)
        )]
        pub first_party: bool,
    }

    /// Route from `/.proxy/{prefix}/` on the Activity Origin to an upstream
    pub struct ActivityUrlMapping {
        /// Path prefix without slashes
        pub prefix: String,
        /// Absolute http(s) upstream URL
        pub target: String,
    }

    /// Activity Application with registry fields, visible to administrators.
    pub struct AdminActivityApplication {
        /// Public part
        #[cfg_attr(feature = "serde", serde(flatten))]
        pub application: ActivityApplication,
        /// Absolute http(s) upstream URL that serves the application root
        pub origin_url: String,
        /// Extra upstreams reachable through `/.proxy/{prefix}/`
        pub url_mappings: Vec<ActivityUrlMapping>,
        /// Disabled applications are hidden from clients and not proxied
        pub enabled: bool,
        /// Whether a client secret has been generated
        pub has_client_secret: bool,
        /// Creation timestamp
        pub created_at: Timestamp,
        /// Update timestamp
        pub updated_at: Timestamp,
    }

    /// New Activity Application
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataCreateActivityApplication {
        /// Application id (DNS label, immutable)
        #[cfg_attr(feature = "validator", validate(regex = "RE_ACTIVITY_APPLICATION_ID"))]
        pub id: String,
        /// Display name
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 64)))]
        pub name: String,
        /// Short description
        #[cfg_attr(feature = "validator", validate(length(min = 0, max = 256)))]
        pub description: Option<String>,
        /// Uploaded icon file id (`icons` tag)
        pub icon_file_id: Option<String>,
        /// Upstream URL of the application root
        #[cfg_attr(feature = "validator", validate(url))]
        pub origin_url: String,
        /// Extra upstreams
        #[cfg_attr(feature = "serde", serde(default))]
        pub url_mappings: Vec<ActivityUrlMapping>,
        /// Maximum number of participants (1..=99)
        #[cfg_attr(feature = "validator", validate(range(min = 1, max = 99)))]
        pub max_participants: u32,
        /// Skip authorization consent
        #[cfg_attr(feature = "serde", serde(default))]
        pub first_party: bool,
        /// Visible and proxied
        #[cfg_attr(feature = "serde", serde(default))]
        pub enabled: bool,
    }

    /// Activity Application changes; `None` keeps the value
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataEditActivityApplication {
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 64)))]
        pub name: Option<String>,
        #[cfg_attr(feature = "validator", validate(length(min = 0, max = 256)))]
        pub description: Option<String>,
        pub icon_file_id: Option<String>,
        #[cfg_attr(feature = "validator", validate(url))]
        pub origin_url: Option<String>,
        pub url_mappings: Option<Vec<ActivityUrlMapping>>,
        #[cfg_attr(feature = "validator", validate(range(min = 1, max = 99)))]
        pub max_participants: Option<u32>,
        pub first_party: Option<bool>,
        pub enabled: Option<bool>,
        /// Fields to clear
        #[cfg_attr(feature = "serde", serde(default))]
        pub remove: Vec<FieldsActivityApplication>,
    }

    /// Clearable Activity Application fields
    pub enum FieldsActivityApplication {
        Description,
        Icon,
    }

    /// Newly generated client secret, shown once
    pub struct ActivityClientSecret {
        pub client_secret: String,
    }

    /// Authorization scopes an application may request
    #[derive(Copy, Hash)]
    pub enum ActivityOAuthScope {
        /// Read the user's id, username, display name and avatar
        #[cfg_attr(feature = "serde", serde(rename = "identify"))]
        Identify,
        /// Read and write the user's player data and scores
        #[cfg_attr(feature = "serde", serde(rename = "storage"))]
        Storage,
    }

    /// Authorization request from the Activity Frame
    pub struct DataActivityAuthorize {
        pub scopes: Vec<ActivityOAuthScope>,
    }

    /// Single-use authorization code (valid for 5 minutes)
    pub struct ActivityAuthorizationCode {
        pub code: String,
    }

    /// Code exchange by the application backend
    pub struct DataActivityTokenExchange {
        pub client_id: String,
        pub client_secret: String,
        pub code: String,
    }

    /// Access token for the application backend
    pub struct ActivityAccessToken {
        pub access_token: String,
        /// Always `Bearer`
        pub token_type: String,
        /// Seconds until expiry
        pub expires_in: u64,
        pub scopes: Vec<ActivityOAuthScope>,
    }

    /// User identity exposed to an application (`identify` scope)
    pub struct ActivityUserIdentity {
        #[cfg_attr(feature = "serde", serde(rename = "_id"))]
        pub id: String,
        pub username: String,
        pub discriminator: String,
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub display_name: Option<String>,
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub avatar: Option<File>,
    }

    /// Private player data document for `(application, scope, user)`.
    ///
    /// The scope is a server id, or the channel id for DM and group calls.
    pub struct ActivityPlayerData {
        /// JSON object, at most 16 KiB serialized
        pub data: serde_json::Value,
        /// Whether the last write came from the application backend
        pub trusted: bool,
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub updated_at: Option<Timestamp>,
    }

    /// Player data replacement
    pub struct DataActivityPlayerData {
        pub data: serde_json::Value,
    }

    /// How a submitted score combines with the stored one
    #[derive(Copy, Default)]
    pub enum ActivityScoreMode {
        /// Keep the higher value
        #[default]
        #[cfg_attr(feature = "serde", serde(rename = "max"))]
        Max,
        /// Keep the lower value
        #[cfg_attr(feature = "serde", serde(rename = "min"))]
        Min,
        /// Replace the value
        #[cfg_attr(feature = "serde", serde(rename = "set"))]
        Set,
    }

    /// Score submission
    pub struct DataActivityScore {
        pub value: i64,
        #[cfg_attr(feature = "serde", serde(default))]
        pub mode: ActivityScoreMode,
    }

    /// Stored score of one user
    pub struct ActivityScore {
        pub user_id: String,
        pub value: i64,
        /// Whether the last accepted write came from the application backend
        pub trusted: bool,
        pub updated_at: Timestamp,
    }

    /// Leaderboard for `(application, scope, key)`, best first
    pub struct ActivityLeaderboard {
        pub key: String,
        pub entries: Vec<ActivityScore>,
        /// The caller's own entry, even when outside `entries`
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub own: Option<ActivityScore>,
    }

    /// Leaderboard query
    #[cfg_attr(feature = "rocket", derive(FromForm))]
    pub struct OptionsActivityLeaderboard {
        /// Number of entries (1..=100, default 10)
        pub limit: Option<i64>,
        /// Sort ascending (lower is better)
        pub ascending: Option<bool>,
    }
);
