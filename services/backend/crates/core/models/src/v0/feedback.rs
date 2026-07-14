use iso8601_timestamp::Timestamp;
use once_cell::sync::Lazy;
use regex::Regex;

#[cfg(feature = "validator")]
use validator::Validate;

pub static RE_FEEDBACK_CATEGORY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,31}$").unwrap());

auto_derived!(
    /// Moderation visibility of a feedback suggestion.
    #[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
    pub enum FeedbackModerationStatus {
        Pending,
        Approved,
        Rejected,
        Merged,
        Hidden,
    }

    /// Delivery state of an approved feedback suggestion.
    #[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
    pub enum FeedbackProductStatus {
        Collecting,
        UnderConsideration,
        Planned,
        InProgress,
        Released,
        NotPlanned,
    }

    /// Sort order for the feedback catalogue.
    #[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
    pub enum FeedbackSort {
        Popular,
        New,
    }

    /// A product feedback suggestion visible to the requesting user.
    pub struct FeedbackSuggestion {
        /// Unique suggestion id.
        #[cfg_attr(feature = "serde", serde(rename = "_id"))]
        pub id: String,
        /// Author user id.
        pub author: String,
        /// Short user-facing title.
        pub title: String,
        /// Full proposal text.
        pub description: String,
        /// Stable category slug.
        pub category: String,
        /// Moderation visibility state.
        pub moderation_status: FeedbackModerationStatus,
        /// Product delivery state.
        pub status: FeedbackProductStatus,
        /// Official response from the team.
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub team_response: Option<String>,
        /// Reason supplied when the suggestion was rejected.
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub rejection_reason: Option<String>,
        /// Canonical suggestion when this is a merged duplicate.
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub merged_into: Option<String>,
        /// Optional moderator note explaining a duplicate merge.
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub merge_reason: Option<String>,
        /// Number of active votes.
        pub vote_count: u64,
        /// Whether the requesting user has voted.
        pub voted: bool,
        /// Creation time.
        pub created_at: Timestamp,
        /// Last update time.
        pub updated_at: Timestamp,
    }

    /// Paginated feedback catalogue response.
    pub struct FeedbackSuggestionPage {
        pub suggestions: Vec<FeedbackSuggestion>,
        pub total: u64,
        pub offset: usize,
        pub limit: usize,
    }

    /// Data for a new feedback suggestion.
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataCreateFeedbackSuggestion {
        #[cfg_attr(feature = "validator", validate(length(min = 3, max = 140)))]
        pub title: String,
        #[cfg_attr(feature = "validator", validate(length(min = 10, max = 5000)))]
        pub description: String,
        #[cfg_attr(
            feature = "validator",
            validate(length(min = 1, max = 32), regex = "RE_FEEDBACK_CATEGORY")
        )]
        pub category: String,
    }

    /// Rejection reason supplied by a moderator.
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataRejectFeedbackSuggestion {
        #[cfg_attr(feature = "validator", validate(length(min = 3, max = 1000)))]
        pub reason: String,
    }

    /// Destination suggestion when merging a duplicate.
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataMergeFeedbackSuggestion {
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 128)))]
        pub target_id: String,
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 1000)))]
        pub reason: Option<String>,
    }

    /// Product delivery status update.
    pub struct DataSetFeedbackProductStatus {
        pub status: FeedbackProductStatus,
    }

    /// Official team response update. Send `null` to clear it.
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataSetFeedbackTeamResponse {
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 4000)))]
        pub response: Option<String>,
    }
);

#[cfg(test)]
mod tests {
    use super::RE_FEEDBACK_CATEGORY;

    #[test]
    fn feedback_category_accepts_stable_slugs() {
        assert!(RE_FEEDBACK_CATEGORY.is_match("desktop_app"));
        assert!(RE_FEEDBACK_CATEGORY.is_match("api-v2"));
        assert!(!RE_FEEDBACK_CATEGORY.is_match("Desktop"));
        assert!(!RE_FEEDBACK_CATEGORY.is_match(""));
        assert!(!RE_FEEDBACK_CATEGORY.is_match("has spaces"));
    }
}
