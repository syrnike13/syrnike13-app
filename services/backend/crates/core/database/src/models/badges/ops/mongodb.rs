use bson::{Bson, Document};
use futures::TryStreamExt;
use mongodb::options::ReturnDocument;
use syrnike_result::Result;

use crate::{
    sort_badges_for_display, Badge, FieldsBadge, IntoDocumentPath, MongoDb, PartialBadge,
    UserBadgeAssignment,
};

use super::AbstractBadges;

static BADGES_COL: &str = "badges";
static USER_BADGES_COL: &str = "user_badges";
static USER_STATS_COL: &str = "user_stats";
static USERS_COL: &str = "users";

#[async_trait]
impl AbstractBadges for MongoDb {
    async fn insert_badge(&self, badge: &Badge) -> Result<()> {
        query!(self, insert_one, BADGES_COL, &badge).map(|_| ())
    }

    async fn fetch_badge(&self, id: &str) -> Result<Badge> {
        query!(self, find_one_by_id, BADGES_COL, id)?.ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_badge_by_slug(&self, slug: &str) -> Result<Badge> {
        query!(
            self,
            find_one,
            BADGES_COL,
            doc! {
                "slug": slug
            }
        )?
        .ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_badges(&self) -> Result<Vec<Badge>> {
        let mut badges: Vec<Badge> = query!(self, find, BADGES_COL, doc! {})?;
        sort_badges_for_display(&mut badges);
        Ok(badges)
    }

    async fn update_badge(
        &self,
        badge_id: &str,
        partial: &PartialBadge,
        remove: &[FieldsBadge],
    ) -> Result<()> {
        query!(
            self,
            update_one_by_id,
            BADGES_COL,
            badge_id,
            partial,
            remove
                .iter()
                .map(|field| field as &dyn IntoDocumentPath)
                .collect(),
            None
        )
        .map(|_| ())
    }

    async fn delete_badge(&self, badge_id: &str) -> Result<()> {
        let result = self
            .col::<Document>(BADGES_COL)
            .delete_one(doc! {
                "_id": badge_id
            })
            .await
            .map_err(|_| create_database_error!("delete_one", BADGES_COL))?;

        if result.deleted_count == 0 {
            return Err(create_error!(NotFound));
        }

        Ok(())
    }

    async fn assign_user_badge(&self, assignment: &UserBadgeAssignment) -> Result<bool> {
        self.fetch_badge(&assignment.badge_id).await?;

        self.col::<UserBadgeAssignment>(USER_BADGES_COL)
            .update_one(
                doc! {
                    "user_id": &assignment.user_id,
                    "badge_id": &assignment.badge_id
                },
                doc! {
                    "$setOnInsert": bson::to_document(assignment)
                        .map_err(|_| create_database_error!("serialize", USER_BADGES_COL))?
                },
            )
            .upsert(true)
            .await
            .map(|result| result.upserted_id.is_some())
            .map_err(|_| create_database_error!("update_one", USER_BADGES_COL))
    }

    async fn remove_user_badge(&self, user_id: &str, badge_id: &str) -> Result<()> {
        self.col::<Document>(USER_BADGES_COL)
            .delete_one(doc! {
                "user_id": user_id,
                "badge_id": badge_id
            })
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("delete_one", USER_BADGES_COL))
    }

    async fn fetch_user_badge_assignments(
        &self,
        user_id: &str,
    ) -> Result<Vec<UserBadgeAssignment>> {
        Ok(self
            .col::<UserBadgeAssignment>(USER_BADGES_COL)
            .find(doc! {
                "user_id": user_id
            })
            .await
            .map_err(|_| create_database_error!("find", USER_BADGES_COL))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", USER_BADGES_COL))?)
    }

    async fn fetch_user_badges(&self, user_id: &str) -> Result<Vec<Badge>> {
        let assignments = self.fetch_user_badge_assignments(user_id).await?;
        let badge_ids = assignments
            .into_iter()
            .map(|assignment| assignment.badge_id)
            .collect::<Vec<_>>();

        let mut badges = self
            .col::<Badge>(BADGES_COL)
            .find(doc! {
                "_id": {
                    "$in": badge_ids
                }
            })
            .await
            .map_err(|_| create_database_error!("find", BADGES_COL))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", BADGES_COL))?;

        sort_badges_for_display(&mut badges);
        Ok(badges)
    }

    async fn delete_badge_assignments(&self, badge_id: &str) -> Result<()> {
        self.col::<Document>(USER_BADGES_COL)
            .delete_many(doc! {
                "badge_id": badge_id
            })
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("delete_many", USER_BADGES_COL))
    }

    async fn fetch_unseen_user_badges(&self, user_id: &str) -> Result<Vec<Badge>> {
        let badge_ids = self
            .col::<Document>(USER_BADGES_COL)
            .distinct(
                "badge_id",
                doc! {
                    "user_id": user_id,
                    "unseen": true
                },
            )
            .await
            .map_err(|_| create_database_error!("distinct", USER_BADGES_COL))?;

        let mut badges = self
            .col::<Badge>(BADGES_COL)
            .find(doc! {
                "_id": {
                    "$in": badge_ids
                }
            })
            .await
            .map_err(|_| create_database_error!("find", BADGES_COL))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", BADGES_COL))?;

        sort_badges_for_display(&mut badges);
        Ok(badges)
    }

    async fn mark_user_badges_seen(&self, user_id: &str, badge_ids: &[String]) -> Result<()> {
        self.col::<Document>(USER_BADGES_COL)
            .update_many(
                doc! {
                    "user_id": user_id,
                    "badge_id": {
                        "$in": badge_ids
                    }
                },
                doc! {
                    "$unset": {
                        "unseen": 1_i32
                    }
                },
            )
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("update_many", USER_BADGES_COL))
    }

    async fn fetch_user_ids_missing_badge(
        &self,
        badge_id: &str,
        limit: i64,
    ) -> Result<Vec<String>> {
        let assigned = self.fetch_badge_holder_ids(badge_id).await?;

        self.fetch_ids(
            USERS_COL,
            doc! {
                "_id": {
                    "$nin": assigned
                },
                "bot": {
                    "$exists": false
                }
            },
            limit,
        )
        .await
    }

    async fn increment_user_stat(&self, user_id: &str, stat: &str, by: i64) -> Result<i64> {
        let mut increment = Document::new();
        increment.insert(format!("counters.{stat}"), by);
        let stats = self
            .col::<Document>(USER_STATS_COL)
            .find_one_and_update(
                doc! {
                    "_id": user_id
                },
                doc! {
                    "$inc": increment
                },
            )
            .upsert(true)
            .return_document(ReturnDocument::After)
            .await
            .map_err(|_| create_database_error!("find_one_and_update", USER_STATS_COL))?
            .ok_or_else(|| create_database_error!("find_one_and_update", USER_STATS_COL))?;

        stats
            .get_document("counters")
            .ok()
            .and_then(|counters| counters.get(stat))
            .and_then(Bson::as_i64)
            .ok_or_else(|| create_database_error!("deserialize", USER_STATS_COL))
    }

    async fn fetch_user_ids_reaching_stat(
        &self,
        stat: &str,
        at_least: i64,
        missing_badge_id: &str,
        limit: i64,
    ) -> Result<Vec<String>> {
        let assigned = self.fetch_badge_holder_ids(missing_badge_id).await?;

        let mut filter = doc! {
            "_id": {
                "$nin": assigned
            }
        };
        filter.insert(format!("counters.{stat}"), doc! { "$gte": at_least });

        self.fetch_ids(USER_STATS_COL, filter, limit).await
    }
}

impl MongoDb {
    async fn fetch_badge_holder_ids(&self, badge_id: &str) -> Result<Vec<Bson>> {
        self.col::<Document>(USER_BADGES_COL)
            .distinct(
                "user_id",
                doc! {
                    "badge_id": badge_id
                },
            )
            .await
            .map_err(|_| create_database_error!("distinct", USER_BADGES_COL))
    }

    async fn fetch_ids(
        &self,
        collection: &'static str,
        filter: Document,
        limit: i64,
    ) -> Result<Vec<String>> {
        Ok(self
            .col::<Document>(collection)
            .find(filter)
            .projection(doc! { "_id": 1_i32 })
            .limit(limit)
            .await
            .map_err(|_| create_database_error!("find", collection))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| create_database_error!("deserialize", collection))?
            .into_iter()
            .filter_map(|document| document.get_str("_id").ok().map(str::to_string))
            .collect())
    }
}

impl IntoDocumentPath for FieldsBadge {
    fn as_path(&self) -> Option<&'static str> {
        Some(match self {
            FieldsBadge::Description => "description",
            FieldsBadge::Icon => "icon",
        })
    }
}
