use std::collections::{HashMap, HashSet};

use bson::{Bson, Document, doc};
use futures::{FutureExt, TryStreamExt, future::BoxFuture};
use iso8601_timestamp::Timestamp;
use mongodb::error::{TRANSIENT_TRANSACTION_ERROR, UNKNOWN_TRANSACTION_COMMIT_RESULT};
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
const TRANSACTION_ATTEMPTS: usize = 3;

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
        let limit = query.limit.clamp(1, 100);
        let offset = query.offset.min(i64::MAX as usize) as i64;
        let suggestions = match query.sort {
            v0::FeedbackSort::New => self
                .col::<FeedbackSuggestion>(SUGGESTIONS_COL)
                .find(filter)
                .sort(doc! { "created_at": -1, "_id": -1 })
                .skip(offset as u64)
                .limit(limit as i64)
                .await
                .map_err(|_| create_database_error!("find", SUGGESTIONS_COL))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|_| create_database_error!("deserialize", SUGGESTIONS_COL))?,
            v0::FeedbackSort::Popular => {
                let documents = self
                    .col::<FeedbackSuggestion>(SUGGESTIONS_COL)
                    .aggregate(vec![
                    doc! { "$match": filter },
                    doc! { "$lookup": {
                        "from": VOTES_COL,
                        "let": { "suggestion_id": "$_id" },
                        "pipeline": [
                            { "$match": { "$expr": { "$eq": ["$suggestion_id", "$$suggestion_id"] } } },
                            { "$count": "count" },
                        ],
                        "as": "_vote_stats",
                    } },
                    doc! { "$set": {
                        "_vote_count": { "$ifNull": [
                            { "$arrayElemAt": ["$_vote_stats.count", 0] },
                            0,
                        ] },
                    } },
                    doc! { "$unset": "_vote_stats" },
                    doc! { "$sort": { "_vote_count": -1, "created_at": -1, "_id": -1 } },
                    doc! { "$skip": offset },
                    doc! { "$limit": limit as i64 },
                    doc! { "$unset": "_vote_count" },
                    ])
                    .await
                    .map_err(|_| create_database_error!("aggregate", SUGGESTIONS_COL))?
                    .try_collect::<Vec<_>>()
                    .await
                    .map_err(|_| create_database_error!("deserialize", SUGGESTIONS_COL))?;
                documents
                    .into_iter()
                    .map(bson::from_document::<FeedbackSuggestion>)
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|_| create_database_error!("deserialize", SUGGESTIONS_COL))?
            }
        };

        let suggestion_ids = suggestions
            .iter()
            .map(|suggestion| suggestion.id.clone())
            .collect::<Vec<_>>();
        let (vote_counts, voted) = self.feedback_vote_state(&suggestion_ids, viewer_id).await?;
        let suggestions = suggestions
            .into_iter()
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
        let db = self.clone();
        let id = id.to_string();
        run_feedback_transaction(self, SUGGESTIONS_COL, move |session| {
            let db = db.clone();
            let id = id.clone();
            let pending = pending.clone();
            let approved = approved.clone();
            async move {
                let suggestion = db
                    .col::<FeedbackSuggestion>(SUGGESTIONS_COL)
                    .find_one_and_update(
                        doc! {
                            "_id": &id,
                            "moderation_status": { "$in": [pending, approved] },
                        },
                        doc! { "$set": {
                            "moderation_status": bson::to_bson(&v0::FeedbackModerationStatus::Approved)
                                .map_err(mongodb::error::Error::custom)?,
                            "rejection_reason": null,
                            "merged_into": null,
                            "merge_reason": null,
                            "updated_at": bson::to_bson(&Timestamp::now_utc())
                                .map_err(mongodb::error::Error::custom)?,
                        } },
                    )
                    .return_document(mongodb::options::ReturnDocument::After)
                    .session(&mut *session)
                    .await?
                    .ok_or_else(|| mongodb::error::Error::custom(create_error!(InvalidOperation)))?;
                let vote = FeedbackVote::new(suggestion.id.clone(), suggestion.author_id.clone());
                db.col::<FeedbackVote>(VOTES_COL)
                    .update_one(
                        doc! { "suggestion_id": &vote.suggestion_id, "user_id": &vote.user_id },
                        doc! { "$setOnInsert": bson::to_document(&vote)
                            .map_err(mongodb::error::Error::custom)? },
                    )
                    .with_options(UpdateOptions::builder().upsert(true).build())
                    .session(&mut *session)
                    .await?;
                Ok(suggestion)
            }
            .boxed()
        })
        .await
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
        let approved = bson::to_bson(&v0::FeedbackModerationStatus::Approved)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let active_statuses = vec![
            bson::to_bson(&v0::FeedbackModerationStatus::Pending)
                .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
            approved.clone(),
            bson::to_bson(&v0::FeedbackModerationStatus::Rejected)
                .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
        ];
        let merged = bson::to_bson(&v0::FeedbackModerationStatus::Merged)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let now = bson::to_bson(&Timestamp::now_utc())
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let db = self.clone();
        let source_id = source_id.to_string();
        let target_id = target_id.to_string();
        run_feedback_transaction(self, SUGGESTIONS_COL, move |session| {
            let db = db.clone();
            let source_id = source_id.clone();
            let target_id = target_id.clone();
            let approved = approved.clone();
            let active_statuses = active_statuses.clone();
            let merged = merged.clone();
            let now = now.clone();
            let reason = reason.clone();
            async move {
                let target = db
                    .col::<Document>(SUGGESTIONS_COL)
                    .update_one(
                        doc! {
                            "_id": &target_id,
                            "moderation_status": &approved,
                        },
                        doc! { "$inc": { "_merge_revision": 1_i64 } },
                    )
                    .session(&mut *session)
                    .await?;
                if target.matched_count == 0 {
                    return Err(mongodb::error::Error::custom(create_error!(InvalidOperation)));
                }
                let source = db
                    .col::<FeedbackSuggestion>(SUGGESTIONS_COL)
                    .find_one(doc! { "_id": &source_id })
                    .session(&mut *session)
                    .await?
                    .ok_or_else(|| mongodb::error::Error::custom(create_error!(NotFound)))?;
                if source.moderation_status == v0::FeedbackModerationStatus::Merged {
                    return if source.merged_into.as_deref() == Some(target_id.as_str()) {
                        Ok(())
                    } else {
                        Err(mongodb::error::Error::custom(create_error!(InvalidOperation)))
                    };
                }
                if source.moderation_status == v0::FeedbackModerationStatus::Hidden {
                    return Err(mongodb::error::Error::custom(create_error!(InvalidOperation)));
                }
                let mut cursor = db
                    .col::<FeedbackVote>(VOTES_COL)
                    .find(doc! { "suggestion_id": &source_id })
                    .session(&mut *session)
                    .await?;
                let source_votes = cursor.stream(&mut *session).try_collect::<Vec<_>>().await?;
                for vote in source_votes {
                    let transferred = FeedbackVote::new(target_id.clone(), vote.user_id);
                    db.col::<FeedbackVote>(VOTES_COL)
                        .update_one(
                            doc! { "suggestion_id": &transferred.suggestion_id, "user_id": &transferred.user_id },
                            doc! { "$setOnInsert": bson::to_document(&transferred)
                                .map_err(mongodb::error::Error::custom)? },
                        )
                        .with_options(UpdateOptions::builder().upsert(true).build())
                        .session(&mut *session)
                        .await?;
                }
                db.col::<Document>(VOTES_COL)
                    .delete_many(doc! { "suggestion_id": &source_id })
                    .session(&mut *session)
                    .await?;
                let source = db
                    .col::<Document>(SUGGESTIONS_COL)
                    .update_one(
                        doc! {
                            "_id": &source_id,
                            "moderation_status": { "$in": active_statuses },
                        },
                        doc! { "$set": {
                            "moderation_status": merged,
                            "merged_into": &target_id,
                            "merge_reason": reason,
                            "updated_at": now,
                        } },
                    )
                    .session(&mut *session)
                    .await?;
                if source.matched_count == 0 {
                    return Err(mongodb::error::Error::custom(create_error!(InvalidOperation)));
                }
                Ok(())
            }
            .boxed()
        })
        .await
    }

    async fn hide_feedback_suggestion(&self, id: &str) -> Result<()> {
        let merged = bson::to_bson(&v0::FeedbackModerationStatus::Merged)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let result = self
            .col::<Document>(SUGGESTIONS_COL)
            .update_one(
                doc! {
                    "_id": id,
                    "moderation_status": { "$ne": merged },
                },
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

    async fn update_feedback_publication(
        &self,
        id: &str,
        status: v0::FeedbackProductStatus,
        response: Option<String>,
    ) -> Result<()> {
        let approved = bson::to_bson(&v0::FeedbackModerationStatus::Approved)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        update_one_checked(
            self,
            doc! {
                "_id": id,
                "moderation_status": approved,
            },
            doc! {
                "product_status": bson::to_bson(&status)
                    .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?,
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
        let vote = FeedbackVote::new(suggestion_id.to_string(), user_id.to_string());
        let db = self.clone();
        let suggestion_id = suggestion_id.to_string();
        let user_id = user_id.to_string();
        run_feedback_transaction(self, VOTES_COL, move |session| {
            let db = db.clone();
            let suggestion_id = suggestion_id.clone();
            let user_id = user_id.clone();
            let approved = approved.clone();
            let vote = vote.clone();
            async move {
                let suggestion = db
                    .col::<Document>(SUGGESTIONS_COL)
                    .update_one(
                        doc! {
                            "_id": &suggestion_id,
                            "moderation_status": approved,
                        },
                        doc! { "$inc": { "_vote_revision": 1_i64 } },
                    )
                    .session(&mut *session)
                    .await?;
                if suggestion.matched_count == 0 {
                    return Err(mongodb::error::Error::custom(create_error!(NotFound)));
                }
                db.col::<FeedbackVote>(VOTES_COL)
                    .update_one(
                        doc! { "suggestion_id": &suggestion_id, "user_id": &user_id },
                        doc! { "$setOnInsert": bson::to_document(&vote)
                        .map_err(mongodb::error::Error::custom)? },
                    )
                    .with_options(UpdateOptions::builder().upsert(true).build())
                    .session(&mut *session)
                    .await?;
                Ok(())
            }
            .boxed()
        })
        .await
    }

    async fn remove_feedback_vote(&self, suggestion_id: &str, user_id: &str) -> Result<()> {
        let approved = bson::to_bson(&v0::FeedbackModerationStatus::Approved)
            .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
        let db = self.clone();
        let suggestion_id = suggestion_id.to_string();
        let user_id = user_id.to_string();
        run_feedback_transaction(self, VOTES_COL, move |session| {
            let db = db.clone();
            let suggestion_id = suggestion_id.clone();
            let user_id = user_id.clone();
            let approved = approved.clone();
            async move {
                let suggestion = db
                    .col::<Document>(SUGGESTIONS_COL)
                    .update_one(
                        doc! {
                            "_id": &suggestion_id,
                            "moderation_status": approved,
                        },
                        doc! { "$inc": { "_vote_revision": 1_i64 } },
                    )
                    .session(&mut *session)
                    .await?;
                if suggestion.matched_count == 0 {
                    return Err(mongodb::error::Error::custom(create_error!(NotFound)));
                }
                db.col::<Document>(VOTES_COL)
                    .delete_one(doc! { "suggestion_id": &suggestion_id, "user_id": &user_id })
                    .session(&mut *session)
                    .await?;
                Ok(())
            }
            .boxed()
        })
        .await
    }
}

async fn run_feedback_transaction<T, F>(
    db: &MongoDb,
    collection: &'static str,
    mut operation: F,
) -> Result<T>
where
    F: for<'a> FnMut(&'a mut mongodb::ClientSession) -> BoxFuture<'a, mongodb::error::Result<T>>,
{
    db.require_feedback_transactions().await?;
    let mut last_error = None;
    for _ in 0..TRANSACTION_ATTEMPTS {
        let mut session = db
            .start_session()
            .await
            .map_err(|_| create_database_error!("start_session", collection))?;
        if let Err(error) = session.start_transaction().await {
            if error.contains_label(TRANSIENT_TRANSACTION_ERROR) {
                last_error = Some(error);
                async_std::task::yield_now().await;
                continue;
            }
            return Err(feedback_transaction_error(error, collection));
        }

        let value = match operation(&mut session).await {
            Ok(value) => value,
            Err(error) => {
                let _ = session.abort_transaction().await;
                if error.contains_label(TRANSIENT_TRANSACTION_ERROR) {
                    last_error = Some(error);
                    async_std::task::yield_now().await;
                    continue;
                }
                return Err(feedback_transaction_error(error, collection));
            }
        };

        let mut retry_whole_transaction = false;
        for _ in 0..TRANSACTION_ATTEMPTS {
            match session.commit_transaction().await {
                Ok(()) => return Ok(value),
                Err(error) if error.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT) => {
                    last_error = Some(error);
                    async_std::task::yield_now().await;
                }
                Err(error) if error.contains_label(TRANSIENT_TRANSACTION_ERROR) => {
                    last_error = Some(error);
                    retry_whole_transaction = true;
                    break;
                }
                Err(error) => return Err(feedback_transaction_error(error, collection)),
            }
        }
        if !retry_whole_transaction {
            break;
        }
    }

    Err(feedback_transaction_error(
        last_error.unwrap_or_else(|| mongodb::error::Error::custom("transaction retry exhausted")),
        collection,
    ))
}

fn feedback_transaction_error(
    error: mongodb::error::Error,
    collection: &'static str,
) -> syrnike_result::Error {
    if let Some(error) = error.get_custom::<syrnike_result::Error>() {
        error.clone()
    } else {
        create_database_error!("transaction", collection)
    }
}

impl MongoDb {
    async fn require_feedback_transactions(&self) -> Result<()> {
        if let Some(supported) = self.transaction_capability().get().copied() {
            return if supported {
                Ok(())
            } else {
                Err(create_database_error!(
                    "transactions_required",
                    SUGGESTIONS_COL
                ))
            };
        }

        let hello = self
            .db()
            .run_command(doc! { "hello": 1 })
            .await
            .map_err(|_| create_database_error!("hello", SUGGESTIONS_COL))?;
        let supported = hello.contains_key("setName")
            || hello
                .get_str("msg")
                .is_ok_and(|message| message == "isdbgrid");
        let _ = self.transaction_capability().set(supported);
        info!(
            "MongoDB feedback transactions for database '{}': {}",
            self.1, supported
        );
        if supported {
            Ok(())
        } else {
            Err(create_database_error!(
                "transactions_required",
                SUGGESTIONS_COL
            ))
        }
    }

    async fn feedback_vote_state(
        &self,
        suggestion_ids: &[String],
        viewer_id: &str,
    ) -> Result<(HashMap<String, u64>, HashSet<String>)> {
        if suggestion_ids.is_empty() {
            return Ok((HashMap::new(), HashSet::new()));
        }

        let grouped = self
            .col::<Document>(VOTES_COL)
            .aggregate(vec![
                doc! { "$match": { "suggestion_id": { "$in": suggestion_ids } } },
                doc! { "$group": { "_id": "$suggestion_id", "count": { "$sum": 1 } } },
            ])
            .await
            .map_err(|_| create_database_error!("aggregate", VOTES_COL))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", VOTES_COL))?;
        let mut counts = HashMap::new();
        for group in grouped {
            let suggestion_id = group
                .get_str("_id")
                .map_err(|_| create_database_error!("deserialize", VOTES_COL))?;
            let count = group
                .get_i64("count")
                .or_else(|_| group.get_i32("count").map(i64::from))
                .map_err(|_| create_database_error!("deserialize", VOTES_COL))?;
            counts.insert(suggestion_id.to_string(), count.max(0) as u64);
        }

        let viewer_votes = self
            .col::<FeedbackVote>(VOTES_COL)
            .find(doc! {
                "suggestion_id": { "$in": suggestion_ids },
                "user_id": viewer_id,
            })
            .await
            .map_err(|_| create_database_error!("find", VOTES_COL))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", VOTES_COL))?;
        let mut voted = HashSet::new();
        for vote in viewer_votes {
            voted.insert(vote.suggestion_id);
        }

        Ok((counts, voted))
    }
}

async fn update_pending(db: &MongoDb, id: &str, set: Document) -> Result<()> {
    let pending = bson::to_bson(&v0::FeedbackModerationStatus::Pending)
        .map_err(|_| create_database_error!("serialize", SUGGESTIONS_COL))?;
    update_one_checked(
        db,
        doc! {
            "_id": id,
            "moderation_status": pending,
        },
        set,
    )
    .await
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
