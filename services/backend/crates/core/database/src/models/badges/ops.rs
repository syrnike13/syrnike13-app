use syrnike_result::Result;

use crate::{Badge, FieldsBadge, PartialBadge, UserBadgeAssignment};

#[cfg(feature = "mongodb")]
mod mongodb;
mod reference;

#[async_trait]
pub trait AbstractBadges: Sync + Send {
    /// Insert badge into database.
    async fn insert_badge(&self, badge: &Badge) -> Result<()>;

    /// Fetch badge by id.
    async fn fetch_badge(&self, id: &str) -> Result<Badge>;

    /// Fetch badge by slug.
    async fn fetch_badge_by_slug(&self, slug: &str) -> Result<Badge>;

    /// Fetch badge catalog.
    async fn fetch_badges(&self) -> Result<Vec<Badge>>;

    /// Update badge by id.
    async fn update_badge(
        &self,
        badge_id: &str,
        partial: &PartialBadge,
        remove: &[FieldsBadge],
    ) -> Result<()>;

    /// Delete badge by id.
    async fn delete_badge(&self, badge_id: &str) -> Result<()>;

    /// Assign badge to user, returns whether the badge was newly assigned.
    async fn assign_user_badge(&self, assignment: &UserBadgeAssignment) -> Result<bool>;

    /// Remove badge from user.
    async fn remove_user_badge(&self, user_id: &str, badge_id: &str) -> Result<()>;

    /// Fetch raw user badge assignments.
    async fn fetch_user_badge_assignments(&self, user_id: &str)
        -> Result<Vec<UserBadgeAssignment>>;

    /// Fetch assigned badge catalog rows for a user.
    async fn fetch_user_badges(&self, user_id: &str) -> Result<Vec<Badge>>;

    /// Delete assignments for badge.
    async fn delete_badge_assignments(&self, badge_id: &str) -> Result<()>;

    /// Fetch badges whose unlock notification the user has not seen yet.
    async fn fetch_unseen_user_badges(&self, user_id: &str) -> Result<Vec<Badge>>;

    /// Mark unlock notifications as seen.
    async fn mark_user_badges_seen(&self, user_id: &str, badge_ids: &[String]) -> Result<()>;

    /// Fetch ids of non-bot users that do not have the badge yet.
    async fn fetch_user_ids_missing_badge(&self, badge_id: &str, limit: i64)
        -> Result<Vec<String>>;

    /// Increment a user progress counter, returns the new value.
    async fn increment_user_stat(&self, user_id: &str, stat: &str, by: i64) -> Result<i64>;

    /// Fetch ids of users whose counter reached the value but who do not have the badge yet.
    async fn fetch_user_ids_reaching_stat(
        &self,
        stat: &str,
        at_least: i64,
        missing_badge_id: &str,
        limit: i64,
    ) -> Result<Vec<String>>;
}
