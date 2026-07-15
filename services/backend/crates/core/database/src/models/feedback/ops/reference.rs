use std::cmp::Reverse;

use iso8601_timestamp::Timestamp;
use syrnike_models::v0;
use syrnike_result::Result;

use crate::{
    FeedbackSuggestion, FeedbackSuggestionPage, FeedbackSuggestionQuery, FeedbackSuggestionView,
    FeedbackVote, ReferenceDb,
};

use super::AbstractFeedback;

#[async_trait]
impl AbstractFeedback for ReferenceDb {
    async fn insert_feedback_suggestion(&self, suggestion: &FeedbackSuggestion) -> Result<()> {
        let mut feedback = self.feedback.lock().await;
        if feedback.suggestions.contains_key(&suggestion.id) {
            return Err(create_database_error!("insert", "feedback_suggestions"));
        }

        feedback
            .suggestions
            .insert(suggestion.id.clone(), suggestion.clone());
        Ok(())
    }

    async fn fetch_feedback_suggestion(&self, id: &str) -> Result<FeedbackSuggestion> {
        self.feedback
            .lock()
            .await
            .suggestions
            .get(id)
            .cloned()
            .ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_feedback_suggestion_view(
        &self,
        id: &str,
        viewer_id: &str,
    ) -> Result<FeedbackSuggestionView> {
        let feedback = self.feedback.lock().await;
        let suggestion = feedback
            .suggestions
            .get(id)
            .cloned()
            .ok_or_else(|| create_error!(NotFound))?;
        Ok(view_for(&feedback, suggestion, viewer_id))
    }

    async fn fetch_feedback_suggestions(
        &self,
        viewer_id: &str,
        query: FeedbackSuggestionQuery,
    ) -> Result<FeedbackSuggestionPage> {
        let feedback = self.feedback.lock().await;
        let mut suggestions = feedback
            .suggestions
            .values()
            .filter(|suggestion| query_matches(suggestion, &query))
            .cloned()
            .collect::<Vec<_>>();

        match query.sort {
            v0::FeedbackSort::Popular => suggestions.sort_by_key(|suggestion| {
                (
                    Reverse(vote_count(&feedback, &suggestion.id)),
                    Reverse(suggestion.created_at.clone()),
                    Reverse(suggestion.id.clone()),
                )
            }),
            v0::FeedbackSort::New => suggestions.sort_by_key(|suggestion| {
                (
                    Reverse(suggestion.created_at.clone()),
                    Reverse(suggestion.id.clone()),
                )
            }),
        }

        let total = suggestions.len() as u64;
        let limit = query.limit.clamp(1, 100);
        let suggestions = suggestions
            .into_iter()
            .skip(query.offset)
            .take(limit)
            .map(|suggestion| view_for(&feedback, suggestion, viewer_id))
            .collect();

        Ok(FeedbackSuggestionPage {
            suggestions,
            total,
            offset: query.offset,
            limit,
        })
    }

    async fn approve_feedback_suggestion(&self, id: &str) -> Result<FeedbackSuggestion> {
        let mut feedback = self.feedback.lock().await;
        let suggestion = feedback
            .suggestions
            .get_mut(id)
            .ok_or_else(|| create_error!(NotFound))?;

        if suggestion.moderation_status != v0::FeedbackModerationStatus::Pending
            && suggestion.moderation_status != v0::FeedbackModerationStatus::Approved
        {
            return Err(create_error!(InvalidOperation));
        }

        suggestion.moderation_status = v0::FeedbackModerationStatus::Approved;
        suggestion.rejection_reason = None;
        suggestion.merged_into = None;
        suggestion.updated_at = Timestamp::now_utc();
        let approved = suggestion.clone();
        let author_vote = FeedbackVote::new(approved.id.clone(), approved.author_id.clone());
        feedback
            .votes
            .entry(author_vote.id.clone())
            .or_insert(author_vote);

        Ok(approved)
    }

    async fn reject_feedback_suggestion(&self, id: &str, reason: String) -> Result<()> {
        let mut feedback = self.feedback.lock().await;
        let suggestion = feedback
            .suggestions
            .get_mut(id)
            .ok_or_else(|| create_error!(NotFound))?;

        if suggestion.moderation_status != v0::FeedbackModerationStatus::Pending {
            return Err(create_error!(InvalidOperation));
        }

        suggestion.moderation_status = v0::FeedbackModerationStatus::Rejected;
        suggestion.rejection_reason = Some(reason);
        suggestion.updated_at = Timestamp::now_utc();
        Ok(())
    }

    async fn merge_feedback_suggestion(
        &self,
        source_id: &str,
        target_id: &str,
        reason: Option<String>,
    ) -> Result<()> {
        if source_id == target_id {
            return Err(create_error!(InvalidOperation));
        }

        let mut feedback = self.feedback.lock().await;
        let target = feedback
            .suggestions
            .get(target_id)
            .ok_or_else(|| create_error!(NotFound))?;
        if target.moderation_status != v0::FeedbackModerationStatus::Approved {
            return Err(create_error!(InvalidOperation));
        }

        let source = feedback
            .suggestions
            .get(source_id)
            .ok_or_else(|| create_error!(NotFound))?;
        if source.moderation_status == v0::FeedbackModerationStatus::Merged {
            return if source.merged_into.as_deref() == Some(target_id) {
                Ok(())
            } else {
                Err(create_error!(InvalidOperation))
            };
        }
        if source.moderation_status == v0::FeedbackModerationStatus::Hidden {
            return Err(create_error!(InvalidOperation));
        }

        let source_votes = feedback
            .votes
            .values()
            .filter(|vote| vote.suggestion_id == source_id)
            .cloned()
            .collect::<Vec<_>>();
        for vote in source_votes {
            let transferred = FeedbackVote::new(target_id.to_string(), vote.user_id);
            feedback
                .votes
                .entry(transferred.id.clone())
                .or_insert(transferred);
        }
        feedback
            .votes
            .retain(|_, vote| vote.suggestion_id != source_id);

        let source = feedback
            .suggestions
            .get_mut(source_id)
            .expect("source suggestion checked above");
        source.moderation_status = v0::FeedbackModerationStatus::Merged;
        source.merged_into = Some(target_id.to_string());
        source.merge_reason = reason;
        source.updated_at = Timestamp::now_utc();
        Ok(())
    }

    async fn hide_feedback_suggestion(&self, id: &str) -> Result<()> {
        let mut feedback = self.feedback.lock().await;
        let suggestion = feedback
            .suggestions
            .get_mut(id)
            .ok_or_else(|| create_error!(NotFound))?;
        if suggestion.moderation_status == v0::FeedbackModerationStatus::Merged {
            return Err(create_error!(InvalidOperation));
        }

        suggestion.moderation_status = v0::FeedbackModerationStatus::Hidden;
        suggestion.updated_at = Timestamp::now_utc();
        Ok(())
    }

    async fn set_feedback_product_status(
        &self,
        id: &str,
        status: v0::FeedbackProductStatus,
    ) -> Result<()> {
        let mut feedback = self.feedback.lock().await;
        let suggestion = feedback
            .suggestions
            .get_mut(id)
            .ok_or_else(|| create_error!(NotFound))?;
        if suggestion.moderation_status != v0::FeedbackModerationStatus::Approved {
            return Err(create_error!(InvalidOperation));
        }

        suggestion.product_status = status;
        suggestion.updated_at = Timestamp::now_utc();
        Ok(())
    }

    async fn set_feedback_team_response(&self, id: &str, response: Option<String>) -> Result<()> {
        let mut feedback = self.feedback.lock().await;
        let suggestion = feedback
            .suggestions
            .get_mut(id)
            .ok_or_else(|| create_error!(NotFound))?;
        if matches!(
            suggestion.moderation_status,
            v0::FeedbackModerationStatus::Merged | v0::FeedbackModerationStatus::Hidden
        ) {
            return Err(create_error!(InvalidOperation));
        }

        suggestion.team_response = response;
        suggestion.updated_at = Timestamp::now_utc();
        Ok(())
    }

    async fn add_feedback_vote(&self, suggestion_id: &str, user_id: &str) -> Result<()> {
        let mut feedback = self.feedback.lock().await;
        let suggestion = feedback
            .suggestions
            .get(suggestion_id)
            .ok_or_else(|| create_error!(NotFound))?;
        if suggestion.moderation_status != v0::FeedbackModerationStatus::Approved {
            return Err(create_error!(NotFound));
        }

        let vote = FeedbackVote::new(suggestion_id.to_string(), user_id.to_string());
        feedback.votes.entry(vote.id.clone()).or_insert(vote);
        Ok(())
    }

    async fn remove_feedback_vote(&self, suggestion_id: &str, user_id: &str) -> Result<()> {
        let mut feedback = self.feedback.lock().await;
        if !feedback.suggestions.contains_key(suggestion_id) {
            return Err(create_error!(NotFound));
        }

        feedback
            .votes
            .remove(&FeedbackVote::key(suggestion_id, user_id));
        Ok(())
    }
}

fn query_matches(suggestion: &FeedbackSuggestion, query: &FeedbackSuggestionQuery) -> bool {
    query
        .author_id
        .as_ref()
        .is_none_or(|author_id| &suggestion.author_id == author_id)
        && (query.moderation_statuses.is_empty()
            || query
                .moderation_statuses
                .contains(&suggestion.moderation_status))
        && query
            .category
            .as_ref()
            .is_none_or(|category| &suggestion.category == category)
        && query
            .area
            .as_ref()
            .is_none_or(|area| suggestion.area.as_ref() == Some(area))
        && query
            .platform
            .as_ref()
            .is_none_or(|platform| suggestion.platform.as_ref() == Some(platform))
        && query
            .product_status
            .as_ref()
            .is_none_or(|status| &suggestion.product_status == status)
        && query.search.as_ref().is_none_or(|search| {
            let search = search.to_lowercase();
            suggestion.title.to_lowercase().contains(&search)
                || suggestion.description.to_lowercase().contains(&search)
        })
}

fn vote_count(feedback: &crate::FeedbackStore, suggestion_id: &str) -> u64 {
    feedback
        .votes
        .values()
        .filter(|vote| vote.suggestion_id == suggestion_id)
        .count() as u64
}

fn view_for(
    feedback: &crate::FeedbackStore,
    suggestion: FeedbackSuggestion,
    viewer_id: &str,
) -> FeedbackSuggestionView {
    let voted = feedback
        .votes
        .contains_key(&FeedbackVote::key(&suggestion.id, viewer_id));
    let vote_count = vote_count(feedback, &suggestion.id);

    FeedbackSuggestionView {
        suggestion,
        vote_count,
        voted,
    }
}

#[cfg(test)]
mod tests {
    use syrnike_models::v0;
    use syrnike_result::ErrorType;

    use crate::{Database, FeedbackSuggestion, FeedbackSuggestionQuery, ReferenceDb};

    async fn insert(db: &Database, author_id: &str, title: &str) -> FeedbackSuggestion {
        let suggestion = FeedbackSuggestion::new(
            author_id.to_string(),
            title.to_string(),
            "A detailed feedback proposal.".to_string(),
            v0::FeedbackCategory::Idea,
            Some(v0::FeedbackArea::Desktop),
            v0::FeedbackPlatform::Windows,
        );
        db.insert_feedback_suggestion(&suggestion)
            .await
            .expect("feedback suggestion inserted");
        suggestion
    }

    #[async_std::test]
    async fn feedback_visibility_keeps_unmoderated_records_private() {
        let db = Database::Reference(ReferenceDb::default());
        let suggestion = insert(&db, "author", "Private suggestion").await;

        let pending = db
            .fetch_feedback_suggestion(&suggestion.id)
            .await
            .expect("pending suggestion fetched");
        assert!(pending.is_visible_to("author", false));
        assert!(!pending.is_visible_to("other", false));
        assert!(pending.is_visible_to("admin", true));

        db.approve_feedback_suggestion(&suggestion.id)
            .await
            .expect("suggestion approved");
        let approved = db
            .fetch_feedback_suggestion(&suggestion.id)
            .await
            .expect("approved suggestion fetched");
        assert!(approved.is_visible_to("other", false));

        let rejected = insert(&db, "author", "Rejected suggestion").await;
        db.reject_feedback_suggestion(&rejected.id, "Out of scope".to_string())
            .await
            .expect("suggestion rejected");
        let rejected = db
            .fetch_feedback_suggestion(&rejected.id)
            .await
            .expect("rejected suggestion fetched");
        assert!(rejected.is_visible_to("author", false));
        assert!(!rejected.is_visible_to("other", false));

        db.hide_feedback_suggestion(&suggestion.id)
            .await
            .expect("suggestion hidden");
        let hidden = db
            .fetch_feedback_suggestion(&suggestion.id)
            .await
            .expect("hidden suggestion fetched");
        assert!(!hidden.is_visible_to("author", false));
        assert!(hidden.is_visible_to("admin", true));
    }

    #[async_std::test]
    async fn feedback_votes_are_unique_and_removal_is_idempotent() {
        let db = Database::Reference(ReferenceDb::default());
        let suggestion = insert(&db, "author", "Vote target").await;

        let error = db
            .add_feedback_vote(&suggestion.id, "voter")
            .await
            .expect_err("pending suggestions cannot be voted on");
        assert!(matches!(error.error_type, ErrorType::NotFound));

        db.approve_feedback_suggestion(&suggestion.id)
            .await
            .expect("suggestion approved");
        db.add_feedback_vote(&suggestion.id, "voter")
            .await
            .expect("first vote added");
        db.add_feedback_vote(&suggestion.id, "voter")
            .await
            .expect("second vote is idempotent");

        let voted = db
            .fetch_feedback_suggestion_view(&suggestion.id, "voter")
            .await
            .expect("vote view fetched");
        assert_eq!(voted.vote_count, 2, "author plus one unique voter");
        assert!(voted.voted);

        db.remove_feedback_vote(&suggestion.id, "voter")
            .await
            .expect("vote removed");
        db.remove_feedback_vote(&suggestion.id, "voter")
            .await
            .expect("second removal is idempotent");
        let unvoted = db
            .fetch_feedback_suggestion_view(&suggestion.id, "voter")
            .await
            .expect("vote view fetched");
        assert_eq!(unvoted.vote_count, 1, "submitter vote remains");
        assert!(!unvoted.voted);
    }

    #[async_std::test]
    async fn approving_adds_submitter_vote_and_rejected_items_stay_out_of_catalogue() {
        let db = Database::Reference(ReferenceDb::default());
        let approved = insert(&db, "approved-author", "Approve me").await;
        let rejected = insert(&db, "rejected-author", "Reject me").await;

        db.approve_feedback_suggestion(&approved.id)
            .await
            .expect("approved");
        db.reject_feedback_suggestion(&rejected.id, "Duplicate scope".to_string())
            .await
            .expect("rejected");

        let approved_view = db
            .fetch_feedback_suggestion_view(&approved.id, "approved-author")
            .await
            .expect("approved view fetched");
        assert_eq!(approved_view.vote_count, 1);
        assert!(approved_view.voted);

        let catalogue = db
            .fetch_feedback_suggestions(
                "other-user",
                FeedbackSuggestionQuery {
                    moderation_statuses: vec![v0::FeedbackModerationStatus::Approved],
                    ..Default::default()
                },
            )
            .await
            .expect("catalogue fetched");
        assert_eq!(catalogue.total, 1);
        assert_eq!(catalogue.suggestions[0].suggestion.id, approved.id);
    }

    #[async_std::test]
    async fn merging_transfers_votes_without_duplicate_users() {
        let db = Database::Reference(ReferenceDb::default());
        let target = insert(&db, "target-author", "Canonical feedback").await;
        let source = insert(&db, "source-author", "Duplicate feedback").await;
        db.approve_feedback_suggestion(&target.id)
            .await
            .expect("target approved");
        db.approve_feedback_suggestion(&source.id)
            .await
            .expect("source approved");

        db.add_feedback_vote(&target.id, "shared-user")
            .await
            .expect("target shared vote");
        db.add_feedback_vote(&source.id, "shared-user")
            .await
            .expect("source shared vote");
        db.add_feedback_vote(&source.id, "source-only-user")
            .await
            .expect("source only vote");

        db.merge_feedback_suggestion(
            &source.id,
            &target.id,
            Some("Same customer problem".to_string()),
        )
        .await
        .expect("merged");

        let target_view = db
            .fetch_feedback_suggestion_view(&target.id, "shared-user")
            .await
            .expect("target view fetched");
        assert_eq!(
            target_view.vote_count, 4,
            "target, source, shared, and source-only users"
        );
        assert!(target_view.voted);

        let merged = db
            .fetch_feedback_suggestion(&source.id)
            .await
            .expect("merged source fetched");
        assert_eq!(
            merged.moderation_status,
            v0::FeedbackModerationStatus::Merged
        );
        assert_eq!(merged.merged_into.as_deref(), Some(target.id.as_str()));
        assert_eq!(
            merged.merge_reason.as_deref(),
            Some("Same customer problem")
        );

        let source_view = db
            .fetch_feedback_suggestion_view(&source.id, "source-only-user")
            .await
            .expect("source view fetched");
        assert_eq!(source_view.vote_count, 0);
    }
}
