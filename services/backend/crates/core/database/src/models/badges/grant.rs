use iso8601_timestamp::Timestamp;
use log::warn;
use syrnike_models::v0;
use syrnike_result::Result;

use crate::{events::client::EventV1, Badge, BadgeAssignmentSource, Database, UserBadgeAssignment};

/// Release version of this build, synced from the root `VERSION` file.
pub const RELEASE_VERSION: &str = include_str!("../../../../../../VERSION");

/// Users processed per reconcile query.
const RECONCILE_BATCH: i64 = 500;

/// Condition that grants a badge automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadgeTrigger {
    /// Account registered while the release major version is below this value.
    RegisteredBeforeMajor(u64),
    /// User progress counter reached the value.
    StatAtLeast { stat: &'static str, value: i64 },
}

/// Automatic badge rule bound to a catalog slug.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadgeRule {
    pub slug: &'static str,
    pub trigger: BadgeTrigger,
}

/// Automatic badge rules.
///
/// Progress rules use `BadgeTrigger::StatAtLeast` with a counter recorded through
/// `record_user_stat`; the reconcile task backfills users that already qualify.
pub static BADGE_RULES: &[BadgeRule] = &[BadgeRule {
    slug: "beta_tester",
    trigger: BadgeTrigger::RegisteredBeforeMajor(1),
}];

fn release_major(version: &str) -> Option<u64> {
    version.trim().split('.').next()?.parse().ok()
}

fn registration_qualifies(major: u64, version: &str) -> bool {
    release_major(version).is_some_and(|current| current < major)
}

/// Publish the user's current public badges.
pub async fn publish_user_badges(db: &Database, user_id: &str) {
    let badges = db
        .fetch_user_badges(user_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(Badge::into_public_user_badge)
        .collect();

    EventV1::UserUpdate {
        id: user_id.to_string(),
        data: v0::PartialUser {
            badges: Some(badges),
            ..Default::default()
        },
        clear: vec![],
        event_id: None,
    }
    .p(user_id.to_string())
    .await;
}

/// Assign a badge, returns whether it was newly granted.
///
/// New grants are published to everyone and announced to the user once.
pub async fn grant_badge(
    db: &Database,
    user_id: &str,
    badge: Badge,
    source: BadgeAssignmentSource,
    assigned_by: Option<String>,
) -> Result<bool> {
    let granted = db
        .assign_user_badge(&UserBadgeAssignment {
            user_id: user_id.to_string(),
            badge_id: badge.id.clone(),
            source,
            assigned_by,
            assigned_at: Timestamp::now_utc(),
            unseen: true,
        })
        .await?;

    if granted {
        publish_user_badges(db, user_id).await;

        if let Some(badge) = badge.into_public_user_badge() {
            EventV1::UserBadgeUnlock { badge }
                .private(user_id.to_string())
                .await;
        }
    }

    Ok(granted)
}

async fn grant_rule_badge(db: &Database, user_id: &str, slug: &str) -> Result<bool> {
    let Ok(badge) = db.fetch_badge_by_slug(slug).await else {
        return Ok(false);
    };

    grant_badge(db, user_id, badge, BadgeAssignmentSource::Rule, None).await
}

/// Grant registration badges to a freshly onboarded user.
pub async fn grant_registration_badges(db: &Database, user_id: &str) {
    for rule in BADGE_RULES {
        if let BadgeTrigger::RegisteredBeforeMajor(major) = rule.trigger {
            if !registration_qualifies(major, RELEASE_VERSION) {
                continue;
            }

            if let Err(error) = grant_rule_badge(db, user_id, rule.slug).await {
                warn!(
                    "Failed to grant badge {} to {user_id}: {error:?}",
                    rule.slug
                );
            }
        }
    }
}

/// Increment a user progress counter and grant badges whose threshold it reached.
pub async fn record_user_stat(
    db: &Database,
    user_id: &str,
    stat: &'static str,
    by: i64,
) -> Result<()> {
    let current = db.increment_user_stat(user_id, stat, by).await?;

    for rule in BADGE_RULES {
        if let BadgeTrigger::StatAtLeast {
            stat: rule_stat,
            value,
        } = rule.trigger
        {
            if rule_stat == stat && current >= value {
                grant_rule_badge(db, user_id, rule.slug).await?;
            }
        }
    }

    Ok(())
}

/// Grant rule badges to every user that already qualifies.
pub async fn reconcile_badge_rules(db: &Database) -> Result<()> {
    for rule in BADGE_RULES {
        let Ok(badge) = db.fetch_badge_by_slug(rule.slug).await else {
            continue;
        };

        if let BadgeTrigger::RegisteredBeforeMajor(major) = rule.trigger {
            if !registration_qualifies(major, RELEASE_VERSION) {
                continue;
            }
        }

        loop {
            let user_ids = match rule.trigger {
                BadgeTrigger::RegisteredBeforeMajor(_) => {
                    db.fetch_user_ids_missing_badge(&badge.id, RECONCILE_BATCH)
                        .await?
                }
                BadgeTrigger::StatAtLeast { stat, value } => {
                    db.fetch_user_ids_reaching_stat(stat, value, &badge.id, RECONCILE_BATCH)
                        .await?
                }
            };

            let mut granted = 0;
            for user_id in &user_ids {
                if grant_badge(
                    db,
                    user_id,
                    badge.clone(),
                    BadgeAssignmentSource::Rule,
                    None,
                )
                .await?
                {
                    granted += 1;
                }
            }

            if (user_ids.len() as i64) < RECONCILE_BATCH || granted == 0 {
                break;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{registration_qualifies, release_major, RELEASE_VERSION};
    use crate::{Badge, BadgeAssignmentSource, UserBadgeAssignment};
    use iso8601_timestamp::Timestamp;

    #[test]
    fn release_version_is_semver() {
        assert!(release_major(RELEASE_VERSION).is_some());
    }

    #[test]
    fn registration_qualifies_only_before_major() {
        assert!(registration_qualifies(1, "0.7.0\n"));
        assert!(!registration_qualifies(1, "1.0.0"));
        assert!(!registration_qualifies(1, "2.3.1"));
        assert!(!registration_qualifies(1, "nightly"));
    }

    #[async_std::test]
    async fn unseen_badges_are_cleared_after_ack() {
        database_test!(|db| async move {
            let badge = Badge::new_seed("beta_tester", "Бета тестер", 20, true, false);
            db.insert_badge(&badge).await.unwrap();
            db.assign_user_badge(&UserBadgeAssignment {
                user_id: "user".to_string(),
                badge_id: badge.id.clone(),
                source: BadgeAssignmentSource::Rule,
                assigned_by: None,
                assigned_at: Timestamp::now_utc(),
                unseen: true,
            })
            .await
            .unwrap();

            assert_eq!(db.fetch_unseen_user_badges("user").await.unwrap().len(), 1);

            db.mark_user_badges_seen("user", &[badge.id.clone()])
                .await
                .unwrap();

            assert!(db
                .fetch_unseen_user_badges("user")
                .await
                .unwrap()
                .is_empty());
            assert_eq!(db.fetch_user_badges("user").await.unwrap().len(), 1);
        });
    }

    #[async_std::test]
    async fn stat_threshold_lookup_skips_badge_holders() {
        database_test!(|db| async move {
            let badge = Badge::new_seed("chatter", "Chatter", 100, true, false);
            db.insert_badge(&badge).await.unwrap();

            assert_eq!(db.increment_user_stat("a", "messages", 3).await.unwrap(), 3);
            assert_eq!(db.increment_user_stat("a", "messages", 2).await.unwrap(), 5);
            db.increment_user_stat("b", "messages", 10).await.unwrap();
            db.increment_user_stat("c", "messages", 1).await.unwrap();
            db.assign_user_badge(&UserBadgeAssignment {
                user_id: "b".to_string(),
                badge_id: badge.id.clone(),
                source: BadgeAssignmentSource::Rule,
                assigned_by: None,
                assigned_at: Timestamp::now_utc(),
                unseen: false,
            })
            .await
            .unwrap();

            assert_eq!(
                db.fetch_user_ids_reaching_stat("messages", 5, &badge.id, 10)
                    .await
                    .unwrap(),
                vec!["a".to_string()]
            );
        });
    }
}
