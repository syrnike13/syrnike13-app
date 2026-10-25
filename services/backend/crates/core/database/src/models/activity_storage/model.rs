use iso8601_timestamp::Timestamp;
use syrnike_models::v0;

auto_derived!(
    /// Private player data for `(application, scope, user)` (ADR-0011).
    ///
    /// The scope is a server id, or the channel id for DM and group calls.
    pub struct ActivityPlayerData {
        pub application_id: String,
        pub scope_id: String,
        pub user_id: String,
        /// Serialized JSON object, kept as a string so arbitrary keys never
        /// clash with MongoDB field name rules
        pub data: String,
        /// Whether the last write came from the application backend
        pub trusted: bool,
        pub updated_at: Timestamp,
    }

    /// Score of one user for `(application, scope, key)`
    pub struct ActivityScore {
        pub application_id: String,
        pub scope_id: String,
        pub key: String,
        pub user_id: String,
        pub value: i64,
        /// Whether the last accepted write came from the application backend
        pub trusted: bool,
        pub updated_at: Timestamp,
    }
);

/// New stored value for a submitted score, or `None` when the stored score wins.
pub fn combine_activity_score(
    existing: Option<i64>,
    submitted: i64,
    mode: v0::ActivityScoreMode,
) -> Option<i64> {
    let Some(existing) = existing else {
        return Some(submitted);
    };
    match mode {
        v0::ActivityScoreMode::Max => (submitted > existing).then_some(submitted),
        v0::ActivityScoreMode::Min => (submitted < existing).then_some(submitted),
        v0::ActivityScoreMode::Set => Some(submitted),
    }
}

/// Leaderboard order: by value, ties broken by who reached it first.
pub fn sort_activity_leaderboard(scores: &mut [ActivityScore], ascending: bool) {
    scores.sort_by(|a, b| {
        let by_value = if ascending {
            a.value.cmp(&b.value)
        } else {
            b.value.cmp(&a.value)
        };
        by_value.then_with(|| a.updated_at.cmp(&b.updated_at))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_modes_combine() {
        use v0::ActivityScoreMode::*;
        assert_eq!(combine_activity_score(None, 5, Max), Some(5));
        assert_eq!(combine_activity_score(Some(4), 5, Max), Some(5));
        assert_eq!(combine_activity_score(Some(5), 5, Max), None);
        assert_eq!(combine_activity_score(Some(6), 5, Max), None);
        assert_eq!(combine_activity_score(Some(6), 5, Min), Some(5));
        assert_eq!(combine_activity_score(Some(4), 5, Min), None);
        assert_eq!(combine_activity_score(Some(4), 1, Set), Some(1));
    }

    #[test]
    fn leaderboard_orders_by_value_then_time() {
        let score = |user: &str, value: i64, seconds: i64| ActivityScore {
            application_id: "lab".into(),
            scope_id: "s".into(),
            key: "k".into(),
            user_id: user.into(),
            value,
            trusted: false,
            updated_at: Timestamp::UNIX_EPOCH
                .checked_add(iso8601_timestamp::Duration::seconds(seconds))
                .unwrap(),
        };
        let order = |scores: &[ActivityScore]| {
            scores
                .iter()
                .map(|score| score.user_id.clone())
                .collect::<Vec<_>>()
        };
        let mut scores = vec![score("a", 1, 0), score("b", 3, 2), score("c", 3, 1)];
        sort_activity_leaderboard(&mut scores, false);
        assert_eq!(order(&scores), vec!["c", "b", "a"]);
        sort_activity_leaderboard(&mut scores, true);
        assert_eq!(order(&scores), vec!["a", "c", "b"]);
    }
}
