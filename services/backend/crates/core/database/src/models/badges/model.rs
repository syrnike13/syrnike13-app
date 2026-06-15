use iso8601_timestamp::Timestamp;
use syrnike_models::v0;
use ulid::Ulid;

use crate::File;

auto_derived_partial!(
    /// Badge catalog entry
    pub struct Badge {
        /// Unique Id
        #[serde(rename = "_id")]
        pub id: String,
        /// Stable system slug
        pub slug: String,
        /// Display name
        pub name: String,
        /// Optional display description
        #[serde(skip_serializing_if = "Option::is_none")]
        pub description: Option<String>,
        /// Badge icon
        #[serde(skip_serializing_if = "Option::is_none")]
        pub icon: Option<File>,
        /// Whether normal user-facing payloads can include this badge
        #[serde(skip_serializing_if = "crate::if_false", default)]
        pub visible: bool,
        /// Whether this badge is reserved for the premium system
        #[serde(skip_serializing_if = "crate::if_false", default)]
        pub premium: bool,
        /// Global display order
        pub display_order: i32,
        /// Creation timestamp
        pub created_at: Timestamp,
        /// Update timestamp
        pub updated_at: Timestamp,
    },
    "PartialBadge"
);

auto_derived!(
    /// User badge assignment
    pub struct UserBadgeAssignment {
        /// User id
        pub user_id: String,
        /// Badge id
        pub badge_id: String,
        /// Privileged user who assigned the badge
        pub assigned_by: String,
        /// Assignment timestamp
        pub assigned_at: Timestamp,
    }
);

impl Badge {
    pub fn new(
        slug: String,
        name: String,
        description: Option<String>,
        icon: Option<File>,
        visible: bool,
        premium: bool,
        display_order: i32,
    ) -> Self {
        let now = Timestamp::now_utc();

        Self {
            id: Ulid::new().to_string(),
            slug,
            name,
            description,
            icon,
            visible,
            premium,
            display_order,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn new_seed(
        slug: &str,
        name: &str,
        display_order: i32,
        visible: bool,
        premium: bool,
    ) -> Self {
        Self::new(
            slug.to_string(),
            name.to_string(),
            None,
            None,
            visible,
            premium,
            display_order,
        )
    }

    pub fn apply_partial(&mut self, partial: PartialBadge) {
        if let Some(slug) = partial.slug {
            self.slug = slug;
        }

        if let Some(name) = partial.name {
            self.name = name;
        }

        if partial.description.is_some() {
            self.description = partial.description;
        }

        if partial.icon.is_some() {
            self.icon = partial.icon;
        }

        if let Some(visible) = partial.visible {
            self.visible = visible;
        }

        if let Some(premium) = partial.premium {
            self.premium = premium;
        }

        if let Some(display_order) = partial.display_order {
            self.display_order = display_order;
        }

        self.updated_at = Timestamp::now_utc();
    }

    pub fn into_public_user_badge(self) -> Option<v0::UserBadge> {
        if !self.visible || self.premium {
            return None;
        }

        let icon = self.icon?;

        Some(v0::UserBadge {
            id: self.id,
            slug: self.slug,
            name: self.name,
            description: self.description,
            icon: icon.into(),
            order: self.display_order,
        })
    }
}

impl From<Badge> for v0::Badge {
    fn from(value: Badge) -> Self {
        Self {
            id: value.id,
            slug: value.slug,
            name: value.name,
            description: value.description,
            icon: value.icon.map(Into::into),
            visible: value.visible,
            premium: value.premium,
            display_order: value.display_order,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl From<PartialBadge> for v0::PartialBadge {
    fn from(value: PartialBadge) -> Self {
        Self {
            id: value.id,
            slug: value.slug,
            name: value.name,
            description: value.description,
            icon: value.icon.map(Into::into),
            visible: value.visible,
            premium: value.premium,
            display_order: value.display_order,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

pub fn initial_badges() -> Vec<Badge> {
    vec![
        Badge::new_seed("founder", "Основатель", 0, true, false),
        Badge::new_seed("developer", "Разработчик", 10, true, false),
        Badge::new_seed("beta_tester", "Бета тестер", 20, true, false),
        Badge::new_seed("bug_hunter", "BugHunter", 30, true, false),
        Badge::new_seed("partner", "Партнер", 40, true, false),
        Badge::new_seed("supporter", "Саппорт", 50, true, false),
        Badge::new_seed("premium_subscriber", "Premium Subscriber", 1000, false, true),
        Badge::new_seed("premium_supporter", "Premium Supporter", 1010, false, true),
    ]
}

pub fn sort_badges_for_display(badges: &mut [Badge]) {
    badges.sort_by(|a, b| {
        a.display_order
            .cmp(&b.display_order)
            .then_with(|| a.slug.cmp(&b.slug))
    });
}

#[cfg(test)]
mod tests {
    use super::{sort_badges_for_display, Badge, UserBadgeAssignment};
    use iso8601_timestamp::Timestamp;

    #[async_std::test]
    async fn inserting_duplicate_badge_slug_fails() {
        database_test!(|db| async move {
            let first = Badge::new_seed("founder", "Основатель", 0, true, false);
            let duplicate = Badge::new_seed("founder", "Основатель 2", 1, true, false);

            db.insert_badge(&first).await.unwrap();

            assert!(db.insert_badge(&duplicate).await.is_err());
        });
    }

    #[async_std::test]
    async fn assigning_same_badge_twice_is_idempotent() {
        database_test!(|db| async move {
            let badge = Badge::new_seed("founder", "Основатель", 0, true, false);
            db.insert_badge(&badge).await.unwrap();

            let assignment = UserBadgeAssignment {
                user_id: "user".to_string(),
                badge_id: badge.id.clone(),
                assigned_by: "admin".to_string(),
                assigned_at: Timestamp::now_utc(),
            };

            db.assign_user_badge(&assignment).await.unwrap();
            db.assign_user_badge(&assignment).await.unwrap();

            assert_eq!(db.fetch_user_badge_assignments("user").await.unwrap().len(), 1);
        });
    }

    #[test]
    fn display_sort_uses_order_then_slug() {
        let mut badges = vec![
            Badge::new_seed("zeta", "Zeta", 1, true, false),
            Badge::new_seed("alpha", "Alpha", 1, true, false),
            Badge::new_seed("first", "First", 0, true, false),
        ];

        sort_badges_for_display(&mut badges);

        assert_eq!(
            badges
                .into_iter()
                .map(|badge| badge.slug)
                .collect::<Vec<_>>(),
            vec!["first", "alpha", "zeta"]
        );
    }
}
