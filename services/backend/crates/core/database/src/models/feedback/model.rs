use std::collections::HashMap;

use iso8601_timestamp::Timestamp;
use syrnike_models::v0;
use ulid::Ulid;

auto_derived!(
    /// Product feedback suggestion persisted by the platform.
    pub struct FeedbackSuggestion {
        #[serde(rename = "_id")]
        pub id: String,
        pub author_id: String,
        pub title: String,
        pub description: String,
        pub category: v0::FeedbackCategory,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub area: Option<v0::FeedbackArea>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub platform: Option<v0::FeedbackPlatform>,
        pub moderation_status: v0::FeedbackModerationStatus,
        pub product_status: v0::FeedbackProductStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub team_response: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub rejection_reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub merged_into: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub merge_reason: Option<String>,
        pub created_at: Timestamp,
        pub updated_at: Timestamp,
    }

    /// A user's active vote for a feedback suggestion.
    pub struct FeedbackVote {
        #[serde(rename = "_id")]
        pub id: String,
        pub suggestion_id: String,
        pub user_id: String,
        pub created_at: Timestamp,
    }
);

/// Query accepted by feedback list storage operations. Visibility is deliberately
/// selected by the route before it reaches this layer.
#[derive(Clone, Debug)]
pub struct FeedbackSuggestionQuery {
    pub author_id: Option<String>,
    pub moderation_statuses: Vec<v0::FeedbackModerationStatus>,
    pub category: Option<v0::FeedbackCategory>,
    pub area: Option<v0::FeedbackArea>,
    pub platform: Option<v0::FeedbackPlatform>,
    pub product_status: Option<v0::FeedbackProductStatus>,
    pub search: Option<String>,
    pub sort: v0::FeedbackSort,
    pub offset: usize,
    pub limit: usize,
}

impl Default for FeedbackSuggestionQuery {
    fn default() -> Self {
        Self {
            author_id: None,
            moderation_statuses: Vec::new(),
            category: None,
            area: None,
            platform: None,
            product_status: None,
            search: None,
            sort: v0::FeedbackSort::New,
            offset: 0,
            limit: 20,
        }
    }
}

/// Suggestion together with request-specific vote state.
#[derive(Clone, Debug)]
pub struct FeedbackSuggestionView {
    pub suggestion: FeedbackSuggestion,
    pub vote_count: u64,
    pub voted: bool,
}

/// Result of a paginated feedback list query.
#[derive(Clone, Debug)]
pub struct FeedbackSuggestionPage {
    pub suggestions: Vec<FeedbackSuggestionView>,
    pub total: u64,
    pub offset: usize,
    pub limit: usize,
}

/// In-memory state used by the reference database. A single lock protects
/// cross-collection operations such as vote toggling and vote-preserving merges.
#[derive(Debug, Default)]
pub(crate) struct FeedbackStore {
    pub suggestions: HashMap<String, FeedbackSuggestion>,
    pub votes: HashMap<String, FeedbackVote>,
}

impl FeedbackSuggestion {
    pub fn new(
        author_id: String,
        title: String,
        description: String,
        category: v0::FeedbackCategory,
        area: Option<v0::FeedbackArea>,
        platform: v0::FeedbackPlatform,
    ) -> Self {
        Self {
            id: Ulid::new().to_string(),
            author_id,
            title,
            description,
            category,
            area,
            platform: Some(platform),
            moderation_status: v0::FeedbackModerationStatus::Pending,
            product_status: v0::FeedbackProductStatus::Collecting,
            team_response: None,
            rejection_reason: None,
            merged_into: None,
            merge_reason: None,
            created_at: Timestamp::now_utc(),
            updated_at: Timestamp::now_utc(),
        }
    }

    pub fn is_visible_to(&self, user_id: &str, is_privileged: bool) -> bool {
        if is_privileged {
            return true;
        }

        match self.moderation_status {
            v0::FeedbackModerationStatus::Approved => true,
            v0::FeedbackModerationStatus::Pending
            | v0::FeedbackModerationStatus::Rejected
            | v0::FeedbackModerationStatus::Merged => self.author_id == user_id,
            v0::FeedbackModerationStatus::Hidden => false,
        }
    }

    pub fn into_api(self, vote_count: u64, voted: bool) -> v0::FeedbackSuggestion {
        v0::FeedbackSuggestion {
            id: self.id,
            author: self.author_id,
            title: self.title,
            description: self.description,
            category: self.category,
            area: self.area,
            platform: self.platform,
            moderation_status: self.moderation_status,
            status: self.product_status,
            team_response: self.team_response,
            rejection_reason: self.rejection_reason,
            merged_into: self.merged_into,
            merge_reason: self.merge_reason,
            vote_count,
            voted,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

impl FeedbackVote {
    pub fn key(suggestion_id: &str, user_id: &str) -> String {
        format!("{suggestion_id}:{user_id}")
    }

    pub fn new(suggestion_id: String, user_id: String) -> Self {
        Self {
            id: Self::key(&suggestion_id, &user_id),
            suggestion_id,
            user_id,
            created_at: Timestamp::now_utc(),
        }
    }
}
