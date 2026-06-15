use bson::Document;
use futures::StreamExt;
use syrnike_result::Result;

use crate::{sort_badges_for_display, Badge, MongoDb, PartialBadge, UserBadgeAssignment};

use super::AbstractBadges;

static BADGES_COL: &str = "badges";
static USER_BADGES_COL: &str = "user_badges";

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

    async fn update_badge(&self, badge_id: &str, partial: &PartialBadge) -> Result<()> {
        query!(self, update_one_by_id, BADGES_COL, badge_id, partial, vec![], None).map(|_| ())
    }

    async fn delete_badge(&self, badge_id: &str) -> Result<()> {
        self.col::<Document>(BADGES_COL)
            .delete_one(doc! {
                "_id": badge_id
            })
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("delete_one", BADGES_COL))
    }

    async fn assign_user_badge(&self, assignment: &UserBadgeAssignment) -> Result<()> {
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
            .map(|_| ())
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

    async fn fetch_user_badge_assignments(&self, user_id: &str) -> Result<Vec<UserBadgeAssignment>> {
        Ok(self
            .col::<UserBadgeAssignment>(USER_BADGES_COL)
            .find(doc! {
                "user_id": user_id
            })
            .await
            .map_err(|_| create_database_error!("find", USER_BADGES_COL))?
            .filter_map(|assignment| async { assignment.ok() })
            .collect()
            .await)
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
            .filter_map(|badge| async { badge.ok() })
            .collect::<Vec<_>>()
            .await;

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
}
