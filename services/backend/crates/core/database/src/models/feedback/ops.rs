use syrnike_models::v0;
use syrnike_result::Result;

use crate::{
    FeedbackSuggestion, FeedbackSuggestionPage, FeedbackSuggestionQuery, FeedbackSuggestionView,
};

#[cfg(feature = "mongodb")]
mod mongodb;
mod reference;

#[async_trait]
pub trait AbstractFeedback: Sync + Send {
    async fn insert_feedback_suggestion(&self, suggestion: &FeedbackSuggestion) -> Result<()>;

    async fn fetch_feedback_suggestion(&self, id: &str) -> Result<FeedbackSuggestion>;

    async fn fetch_feedback_suggestion_view(
        &self,
        id: &str,
        viewer_id: &str,
    ) -> Result<FeedbackSuggestionView>;

    async fn fetch_feedback_suggestions(
        &self,
        viewer_id: &str,
        query: FeedbackSuggestionQuery,
    ) -> Result<FeedbackSuggestionPage>;

    /// Mark a pending suggestion approved and ensure its author has exactly one vote.
    async fn approve_feedback_suggestion(&self, id: &str) -> Result<FeedbackSuggestion>;

    async fn reject_feedback_suggestion(&self, id: &str, reason: String) -> Result<()>;

    /// Transfer all source votes to target, excluding duplicate users, then mark source merged.
    async fn merge_feedback_suggestion(
        &self,
        source_id: &str,
        target_id: &str,
        reason: Option<String>,
    ) -> Result<()>;

    async fn hide_feedback_suggestion(&self, id: &str) -> Result<()>;

    /// Atomically replace the public status and official response.
    async fn update_feedback_publication(
        &self,
        id: &str,
        status: v0::FeedbackProductStatus,
        response: Option<String>,
    ) -> Result<()>;

    /// Idempotently activate a vote. Only approved suggestions may be voted on.
    async fn add_feedback_vote(&self, suggestion_id: &str, user_id: &str) -> Result<()>;

    /// Idempotently remove a vote.
    async fn remove_feedback_vote(&self, suggestion_id: &str, user_id: &str) -> Result<()>;
}
