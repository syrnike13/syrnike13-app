use syrnike_result::Result;

use crate::{
    sort_badges_for_display, Badge, FieldsBadge, PartialBadge, ReferenceDb, UserBadgeAssignment,
};

use super::AbstractBadges;

fn assignment_key(user_id: &str, badge_id: &str) -> String {
    format!("{user_id}:{badge_id}")
}

#[async_trait]
impl AbstractBadges for ReferenceDb {
    async fn insert_badge(&self, badge: &Badge) -> Result<()> {
        let mut badges = self.badges.lock().await;

        if badges.values().any(|existing| existing.slug == badge.slug) {
            return Err(create_database_error!("insert", "badge"));
        }

        if badges.contains_key(&badge.id) {
            Err(create_database_error!("insert", "badge"))
        } else {
            badges.insert(badge.id.clone(), badge.clone());
            Ok(())
        }
    }

    async fn fetch_badge(&self, id: &str) -> Result<Badge> {
        let badges = self.badges.lock().await;
        badges
            .get(id)
            .cloned()
            .ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_badge_by_slug(&self, slug: &str) -> Result<Badge> {
        let badges = self.badges.lock().await;
        badges
            .values()
            .find(|badge| badge.slug == slug)
            .cloned()
            .ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_badges(&self) -> Result<Vec<Badge>> {
        let badges = self.badges.lock().await;
        let mut badges = badges.values().cloned().collect::<Vec<_>>();
        sort_badges_for_display(&mut badges);
        Ok(badges)
    }

    async fn update_badge(
        &self,
        badge_id: &str,
        partial: &PartialBadge,
        remove: &[FieldsBadge],
    ) -> Result<()> {
        let mut badges = self.badges.lock().await;

        if let Some(slug) = &partial.slug {
            if badges
                .values()
                .any(|badge| badge.id != badge_id && badge.slug == *slug)
            {
                return Err(create_database_error!("update", "badge"));
            }
        }

        if let Some(badge) = badges.get_mut(badge_id) {
            for field in remove {
                badge.remove_field(field);
            }

            badge.apply_partial(partial.clone());
            Ok(())
        } else {
            Err(create_error!(NotFound))
        }
    }

    async fn delete_badge(&self, badge_id: &str) -> Result<()> {
        let mut badges = self.badges.lock().await;
        if badges.remove(badge_id).is_some() {
            Ok(())
        } else {
            Err(create_error!(NotFound))
        }
    }

    async fn assign_user_badge(&self, assignment: &UserBadgeAssignment) -> Result<()> {
        self.fetch_badge(&assignment.badge_id).await?;

        let mut assignments = self.user_badges.lock().await;
        assignments.insert(
            assignment_key(&assignment.user_id, &assignment.badge_id),
            assignment.clone(),
        );
        Ok(())
    }

    async fn remove_user_badge(&self, user_id: &str, badge_id: &str) -> Result<()> {
        let mut assignments = self.user_badges.lock().await;
        assignments.remove(&assignment_key(user_id, badge_id));
        Ok(())
    }

    async fn fetch_user_badge_assignments(
        &self,
        user_id: &str,
    ) -> Result<Vec<UserBadgeAssignment>> {
        let assignments = self.user_badges.lock().await;
        Ok(assignments
            .values()
            .filter(|assignment| assignment.user_id == user_id)
            .cloned()
            .collect())
    }

    async fn fetch_user_badges(&self, user_id: &str) -> Result<Vec<Badge>> {
        let assignments = self.fetch_user_badge_assignments(user_id).await?;
        let badges = self.badges.lock().await;
        let mut assigned = assignments
            .into_iter()
            .filter_map(|assignment| badges.get(&assignment.badge_id).cloned())
            .collect::<Vec<_>>();
        sort_badges_for_display(&mut assigned);
        Ok(assigned)
    }

    async fn delete_badge_assignments(&self, badge_id: &str) -> Result<()> {
        let mut assignments = self.user_badges.lock().await;
        assignments.retain(|_, assignment| assignment.badge_id != badge_id);
        Ok(())
    }
}
