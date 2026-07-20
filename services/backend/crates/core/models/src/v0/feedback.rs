use iso8601_timestamp::Timestamp;
#[cfg(feature = "validator")]
use validator::Validate;

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

    /// User-selected kind of feedback.
    #[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
    pub enum FeedbackCategory {
        Bug,
        Idea,
    }

    /// Optional product area affected by the feedback.
    #[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
    pub enum FeedbackArea {
        Navigation,
        VoiceVideo,
        Community,
        Messages,
        Moderation,
        Desktop,
        Activities,
        Other,
    }

    /// Optional client platform where the feedback applies.
    #[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
    pub enum FeedbackPlatform {
        Windows,
        Macos,
        Linux,
        Web,
        Android,
        Ios,
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
        /// Author user id. Hidden from other users for anonymous suggestions.
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub author: Option<String>,
        /// Author username snapshot. Hidden from other users for anonymous suggestions.
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub author_username: Option<String>,
        /// Whether the author is hidden from other users.
        pub anonymous: bool,
        /// Short user-facing title.
        pub title: String,
        /// Full proposal text.
        pub description: String,
        /// Whether this reports a bug or proposes an idea.
        pub category: FeedbackCategory,
        /// Optional product area affected by the feedback.
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub area: Option<FeedbackArea>,
        /// Optional client platform where the feedback applies.
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub platform: Option<FeedbackPlatform>,
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
        pub category: FeedbackCategory,
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub area: Option<FeedbackArea>,
        pub platform: FeedbackPlatform,
        /// Publish without exposing the author to other users. Moderators still see the author.
        #[cfg_attr(feature = "serde", serde(default))]
        pub anonymous: bool,
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

    /// Complete public presentation update for an approved suggestion.
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataUpdateFeedbackPublication {
        /// Last observed suggestion update time. The write is rejected if the
        /// suggestion changed after the moderator loaded it.
        pub expected_updated_at: Timestamp,
        pub status: FeedbackProductStatus,
        /// Official team response. Send `null` to clear it.
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 4000)))]
        pub response: Option<String>,
    }
);
