use std::collections::{HashMap, HashSet};

use bson::{doc, Bson, Document};
use futures::TryStreamExt;
use iso8601_timestamp::Timestamp;
use mongodb::options::UpdateOptions;
use syrnike_models::v0;
use syrnike_result::Result;

use crate::{
    FeedbackSuggestion, FeedbackSuggestionPage, FeedbackSuggestionQuery, FeedbackSuggestionView,
    FeedbackVote, MongoDb,
};

use super::AbstractFeedback;

static SUGGESTIONS_COL: &str = "feedback_suggestions";
static VOTES_COL: &str = "feedback_votes";

#[async_trait]
impl AbstractFeedback for MongoDb {
    async fn insert_feedback_suggestion(&self, suggestion: &FeedbackSuggestion) -> Result<()> {
        self.col::<FeedbackSuggestion>(SUGGESTIONS_COL)
            .insert_one(suggestion)
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("insert_one", SUGGESTIONS_COL))
    }

    async fn fetch_feedback_suggestion(&self, id: &str) -> Result<FeedbackSuggestion> {
        self.col::<FeedbackSuggestion>(SUGGESTIONS_COL)
            .find_one(doc! { "_id": id })
            .await
            .map_err(|_| create_database_error!("find_one", SUGGESTIONS_COL))?
            .ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_feedback_suggestion_view(
        &self,
        id: &str,
        viewer_id: &str,
    ) -> Result<FeedbackSuggestionView> {
        let suggestion = self.fetch_feedback_suggestion(id).await?;
        let (vote_counts, voted) = self
            .feedback_vote_state(&[suggestion.id.clone()], viewer_id)
            .await?;

        Ok(FeedbackSuggestionView {
            vote_count: vote_counts.get(&suggestion.id).copied().unwrap_or_default(),
            voted: voted.contains(&suggestion.id),
            suggestion,
        })
    }

    async fn fetch_feedback_suggestions(
        &self,
        viewer_id: &str,
        query: FeedbackSuggestionQuery,
    ) -> Result<FeedbackSuggestionPage> {
        let filter = query_filter(&query)?;
        let total = self
            .col::<Document>(SUGGESTIONS_COL)
            .count_documents(filter.clone())
            .await
            .map_err(|_| create_database_error!("count_documents", SUGGESTIONS_COL))?;
        let mut suggestions = self
            .col::<FeedbackSuggestion>(SUGGESTIONS_COL)
            .find(filter)
            .await
            .map_err(|_| create_database_error!("find", SUGGESTIONS_COL))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", SUGGESTIONS_COL))?;

        let suggestion_ids = suggestions
            .iter()
            .map(|suggestion| suggestion.id.clone())
            .collect::<Vec<_>>();
        let (vote_counts, voted) = self.feedback_vote_state(&suggestion_ids, viewer_id).await?;

        match query.sort {
            v0::FeedbackSort::Popular => suggestions.sort_by(|left, right| {
                vote_counts
                    .get(&right.id)
                    .copied()
                    .unwrap_or_default()
                    .cmp(&vote_counts.get(&left.id).copied().unwrap_or_default())
                    .then_with(|| right.created_at.cmp(&left.created_at))
                    .then_with(|| right.id.cmp(&left.id))
            }),
            v0::FeedbackSort::New => suggestions.sort_by(|left, right| {
                right
                    .created_at
                    .cmp(&left.created_at)
                    .then_with(|| right.id.cmp(&left.id))
            }),
        }

        let limit = query.limit.clamp(1, 100);
        let suggestions = suggestions
            .into_iter()
            .skip(query.offset)
            .take(limit)
            .map(|suggestion| FeedbackSuggestionView {
                vote_count: vote_counts.get(&suggestion.id).copied().unwrap_or_default(),
                voted: voted.contains(&suggestion.id),
                suggestion,
            })
            .collect();

        Ok(FeedbackSuggestionPage {
            suggestions,
            total,
            offset: query.offset,
            limit,
        })
    }

    async fn approve_feedback_suggestion(&self, id: &str) -> Result<FeedbackSuggestion> {
        let pending = bson::to_bson(&v0::FeedbackModerationStatus::Pending)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let approved = bson::to_bson(&v0::FeedbackModerationStatus::Approved)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let suggestion = self
            .col::<FeedbackSuggestion>(SUGGESTIONS_COL)
            .find_one_and_update(
                doc! {
                    "_id": id,
                    "moderation_status": { "$in": [pending, approved] },
                },
                doc! {
                    "$set": {
                        "moderation_status": bson::to_bson(&v0::FeedbackModerationStatus::Approved)
                            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                        "rejection_reason": null,
                        "merged_into": null,
                        "merge_reason": null,
                        "updated_at": bson::to_bson(&Timestamp::now_utc())
                            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                    }
                },
            )
            .return_document(mongodb::options::ReturnDocument::After)
            .await
            .map_err(|_| create_database_error!("find_one_and_update", SUGGESTIONS_COL))?
            .ok_or_else(|| create_error!(InvalidOperation))?;

        let vote = FeedbackVote::new(suggestion.id.clone(), suggestion.author_id.clone());
        self.col::<FeedbackVote>(VOTES_COL)
            .update_one(
                doc! { "suggestion_id": &vote.suggestion_id, "user_id": &vote.user_id },
                doc! { "$setOnInsert": bson::to_document(&vote)
                .map_err(|_| create_database_error!("serialize", VOTES_COL))? },
            )
            .with_options(UpdateOptions::builder().upsert(true).build())
            .await
            .map_err(|_| create_database_error!("update_one", VOTES_COL))?;

        Ok(suggestion)
    }

    async fn reject_feedback_suggestion(&self, id: &str, reason: String) -> Result<()> {
        update_pending(
            self,
            id,
            doc! {
                "moderation_status": bson::to_bson(&v0::FeedbackModerationStatus::Rejected)
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                "rejection_reason": reason,
                "updated_at": bson::to_bson(&Timestamp::now_utc())
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
            },
        )
        .await
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

        let target = self.fetch_feedback_suggestion(target_id).await?;
        if target.moderation_status != v0::FeedbackModerationStatus::Approved {
            return Err(create_error!(InvalidOperation));
        }

        let source = self.fetch_feedback_suggestion(source_id).await?;
        if source.moderation_status == v0::FeedbackModerationStatus::Hidden {
            return Err(create_error!(InvalidOperation));
        }

        if source.moderation_status == v0::FeedbackModerationStatus::Merged {
            if source.merged_into.as_deref() != Some(target_id) {
                return Err(create_error!(InvalidOperation));
            }
        } else {
            let active_statuses = vec![
                bson::to_bson(&v0::FeedbackModerationStatus::Pending)
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                bson::to_bson(&v0::FeedbackModerationStatus::Approved)
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                bson::to_bson(&v0::FeedbackModerationStatus::Rejected)
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
            ];
            let result = self
                .col::<Document>(SUGGESTIONS_COL)
                .update_one(
                    doc! { "_id": source_id, "moderation_status": { "$in": active_statuses } },
                    doc! { "$set": {
                        "moderation_status": bson::to_bson(&v0::FeedbackModerationStatus::Merged)
                            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                        "merged_into": target_id,
                        "merge_reason": reason,
                        "updated_at": bson::to_bson(&Timestamp::now_utc())
                            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                    } },
                )
                .await
                .map_err(|_| create_database_error!("update_one", SUGGESTIONS_COL))?;

            if result.matched_count == 0 {
                return Err(create_error!(InvalidOperation));
            }
        }

        let source_votes = self
            .col::<FeedbackVote>(VOTES_COL)
            .find(doc! { "suggestion_id": source_id })
            .await
            .map_err(|_| create_database_error!("find", VOTES_COL))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", VOTES_COL))?;

        // The source is now closed to new votes. Copy before removal; both
        // writes are idempotent and the compound unique index prevents
        // duplicate users on the target. Retrying a merged source resumes an
        // interrupted transfer safely.
        for vote in source_votes {
            let transferred = FeedbackVote::new(target_id.to_string(), vote.user_id);
            self.col::<FeedbackVote>(VOTES_COL)
                .update_one(
                    doc! {
                        "suggestion_id": &transferred.suggestion_id,
                        "user_id": &transferred.user_id,
                    },
                    doc! { "$setOnInsert": bson::to_document(&transferred)
                    .map_err(|_| create_database_error!("serialize", VOTES_COL))? },
                )
                .with_options(UpdateOptions::builder().upsert(true).build())
                .await
                .map_err(|_| create_database_error!("update_one", VOTES_COL))?;
        }

        self.col::<Document>(VOTES_COL)
            .delete_many(doc! { "suggestion_id": source_id })
            .await
            .map_err(|_| create_database_error!("delete_many", VOTES_COL))?;

        Ok(())
    }

    async fn hide_feedback_suggestion(&self, id: &str) -> Result<()> {
        let merged = bson::to_bson(&v0::FeedbackModerationStatus::Merged)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let result = self
            .col::<Document>(SUGGESTIONS_COL)
            .update_one(
                doc! { "_id": id, "moderation_status": { "$ne": merged } },
                doc! { "$set": {
                    "moderation_status": bson::to_bson(&v0::FeedbackModerationStatus::Hidden)
                        .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                    "updated_at": bson::to_bson(&Timestamp::now_utc())
                        .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                } },
            )
            .await
            .map_err(|_| create_database_error!("update_one", SUGGESTIONS_COL))?;

        if result.matched_count == 0 {
            Err(create_error!(InvalidOperation))
        } else {
            Ok(())
        }
    }

    async fn set_feedback_product_status(
        &self,
        id: &str,
        status: v0::FeedbackProductStatus,
    ) -> Result<()> {
        let approved = bson::to_bson(&v0::FeedbackModerationStatus::Approved)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        update_one_checked(
            self,
            doc! { "_id": id, "moderation_status": approved },
            doc! {
                "product_status": bson::to_bson(&status)
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
                "updated_at": bson::to_bson(&Timestamp::now_utc())
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
            },
        )
        .await
    }

    async fn set_feedback_team_response(&self, id: &str, response: Option<String>) -> Result<()> {
        let blocked = vec![
            bson::to_bson(&v0::FeedbackModerationStatus::Merged)
                .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
            bson::to_bson(&v0::FeedbackModerationStatus::Hidden)
                .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
        ];
        update_one_checked(
            self,
            doc! { "_id": id, "moderation_status": { "$nin": blocked } },
            doc! {
                "team_response": response.map(Bson::String).unwrap_or(Bson::Null),
                "updated_at": bson::to_bson(&Timestamp::now_utc())
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
            },
        )
        .await
    }

    async fn add_feedback_vote(&self, suggestion_id: &str, user_id: &str) -> Result<()> {
        let approved = bson::to_bson(&v0::FeedbackModerationStatus::Approved)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let exists = self
            .col::<Document>(SUGGESTIONS_COL)
            .find_one(doc! { "_id": suggestion_id, "moderation_status": approved })
            .await
            .map_err(|_| create_database_error!("find_one", SUGGESTIONS_COL))?
            .is_some();
        if !exists {
            return Err(create_error!(NotFound));
        }

        let vote = FeedbackVote::new(suggestion_id.to_string(), user_id.to_string());
        self.col::<FeedbackVote>(VOTES_COL)
            .update_one(
                doc! { "suggestion_id": suggestion_id, "user_id": user_id },
                doc! { "$setOnInsert": bson::to_document(&vote)
                .map_err(|_| create_database_error!("serialize", VOTES_COL))? },
            )
            .with_options(UpdateOptions::builder().upsert(true).build())
            .await
            .map_err(|_| create_database_error!("update_one", VOTES_COL))?;

        // A merge may have started after the approval check. In that case,
        // move this just-created vote to the canonical target rather than
        // allowing the merge's source cleanup to discard it.
        let current = self.fetch_feedback_suggestion(suggestion_id).await?;
        if current.moderation_status == v0::FeedbackModerationStatus::Approved {
            return Ok(());
        }

        if current.moderation_status == v0::FeedbackModerationStatus::Merged {
            if let Some(target_id) = current.merged_into {
                let target = self.fetch_feedback_suggestion(&target_id).await?;
                if target.moderation_status == v0::FeedbackModerationStatus::Approved {
                    let transferred = FeedbackVote::new(target_id, user_id.to_string());
                    self.col::<FeedbackVote>(VOTES_COL)
                        .update_one(
                            doc! {
                                "suggestion_id": &transferred.suggestion_id,
                                "user_id": &transferred.user_id,
                            },
                            doc! { "$setOnInsert": bson::to_document(&transferred)
                            .map_err(|_| create_database_error!("serialize", VOTES_COL))? },
                        )
                        .with_options(UpdateOptions::builder().upsert(true).build())
                        .await
                        .map_err(|_| create_database_error!("update_one", VOTES_COL))?;
                }
            }
        }

        self.col::<Document>(VOTES_COL)
            .delete_one(doc! { "suggestion_id": suggestion_id, "user_id": user_id })
            .await
            .map_err(|_| create_database_error!("delete_one", VOTES_COL))?;
        Err(create_error!(NotFound))
    }

    async fn remove_feedback_vote(&self, suggestion_id: &str, user_id: &str) -> Result<()> {
        let exists = self
            .col::<Document>(SUGGESTIONS_COL)
            .find_one(doc! { "_id": suggestion_id })
            .await
            .map_err(|_| create_database_error!("find_one", SUGGESTIONS_COL))?
            .is_some();
        if !exists {
            return Err(create_error!(NotFound));
        }

        self.col::<Document>(VOTES_COL)
            .delete_one(doc! { "suggestion_id": suggestion_id, "user_id": user_id })
            .await
            .map_err(|_| create_database_error!("delete_one", VOTES_COL))?;

        // If the source was merged while removal was in flight, removing the
        // canonical vote is the only unambiguous cancel action for this user.
        let current = self.fetch_feedback_suggestion(suggestion_id).await?;
        if current.moderation_status == v0::FeedbackModerationStatus::Merged {
            if let Some(target_id) = current.merged_into {
                self.col::<Document>(VOTES_COL)
                    .delete_one(doc! { "suggestion_id": target_id, "user_id": user_id })
                    .await
                    .map_err(|_| create_database_error!("delete_one", VOTES_COL))?;
            }
        }
        Ok(())
    }
}

impl MongoDb {
    async fn feedback_vote_state(
        &self,
        suggestion_ids: &[String],
        viewer_id: &str,
    ) -> Result<(HashMap<String, u64>, HashSet<String>)> {
        if suggestion_ids.is_empty() {
            return Ok((HashMap::new(), HashSet::new()));
        }

        let votes = self
            .col::<FeedbackVote>(VOTES_COL)
            .find(doc! { "suggestion_id": { "$in": suggestion_ids } })
            .await
            .map_err(|_| create_database_error!("find", VOTES_COL))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", VOTES_COL))?;
        let mut counts = HashMap::new();
        let mut voted = HashSet::new();
        for vote in votes {
            *counts.entry(vote.suggestion_id.clone()).or_insert(0) += 1;
            if vote.user_id == viewer_id {
                voted.insert(vote.suggestion_id);
            }
        }

        Ok((counts, voted))
    }
}

async fn update_pending(db: &MongoDb, id: &str, set: Document) -> Result<()> {
    let pending = bson::to_bson(&v0::FeedbackModerationStatus::Pending)
        .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
    update_one_checked(db, doc! { "_id": id, "moderation_status": pending }, set).await
}

async fn update_one_checked(db: &MongoDb, filter: Document, set: Document) -> Result<()> {
    let result = db
        .col::<Document>(SUGGESTIONS_COL)
        .update_one(filter, doc! { "$set": set })
        .await
        .map_err(|_| create_database_error!("update_one", SUGGESTIONS_COL))?;
    if result.matched_count == 0 {
        Err(create_error!(InvalidOperation))
    } else {
        Ok(())
    }
}

fn query_filter(query: &FeedbackSuggestionQuery) -> Result<Document> {
    let mut filters = Vec::new();
    if let Some(author_id) = &query.author_id {
        filters.push(doc! { "author_id": author_id });
    }
    if !query.moderation_statuses.is_empty() {
        filters.push(doc! {
            "moderation_status": { "$in": query.moderation_statuses.iter()
                .map(bson::to_bson)
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))? }
        });
    }
    if let Some(category) = &query.category {
        filters.push(doc! { "category": bson::to_bson(category)
        .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))? });
    }
    if let Some(area) = &query.area {
        filters.push(doc! { "area": bson::to_bson(area)
        .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))? });
    }
    if let Some(platform) = &query.platform {
        filters.push(doc! { "platform": bson::to_bson(platform)
        .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))? });
    }
    if let Some(status) = &query.product_status {
        filters.push(doc! { "product_status": bson::to_bson(status)
        .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))? });
    }
    if let Some(search) = &query.search {
        let escaped = regex::escape(search);
        filters.push(doc! { "$or": [
            { "title": { "$regex": &escaped, "$options": "i" } },
            { "description": { "$regex": &escaped, "$options": "i" } },
        ] });
    }

    Ok(match filters.as_slice() {
        [] => doc! {},
        [filter] => filter.clone(),
        _ => doc! { "$and": filters },
    })
}

#[cfg(test)]
mod tests {
    use bson::doc;
    use syrnike_models::v0;

    use crate::FeedbackSuggestionQuery;

    use super::query_filter;

    #[test]
    fn query_filter_uses_stable_persisted_field_names() {
        let filter = query_filter(&FeedbackSuggestionQuery {
            category: Some(v0::FeedbackCategory::Idea),
            area: Some(v0::FeedbackArea::Desktop),
            product_status: Some(v0::FeedbackProductStatus::Planned),
            ..Default::default()
        })
        .expect("filter built");

        assert_eq!(
            filter,
            doc! { "$and": [
                { "category": bson::to_bson(&v0::FeedbackCategory::Idea).unwrap() },
                { "area": bson::to_bson(&v0::FeedbackArea::Desktop).unwrap() },
                { "product_status": bson::to_bson(&v0::FeedbackProductStatus::Planned).unwrap() },
            ] }
        );
    }
}
