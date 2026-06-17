use syrnike_result::Result;
use ulid::Ulid;

use crate::Database;

pub const ACTIVITY_SESSION_CONTINUE_GAP_MS: i64 = 5 * 60 * 1000;

auto_derived!(
    /// Historical session for a verified game activity.
    pub struct ActivitySession {
        /// Id
        #[serde(rename = "_id")]
        pub id: String,
        /// User who published the activity.
        pub user_id: String,
        /// Source-owned realtime slot that produced the session.
        pub activity_source_id: String,
        /// Canonical verified game id.
        pub verified_game_id: String,
        /// Display name captured at the time of activity.
        pub name: String,
        /// Session start timestamp in unix milliseconds.
        pub started_at: i64,
        /// Last observed timestamp in unix milliseconds.
        pub ended_at: i64,
        /// Raw observed timestamp from the last activity update.
        pub last_observed_at: i64,
    }
);

impl ActivitySession {
    pub fn new_verified_game(
        user_id: &str,
        activity_source_id: &str,
        verified_game_id: &str,
        name: &str,
        observed_at: i64,
    ) -> Self {
        Self {
            id: Ulid::new().to_string(),
            user_id: user_id.to_string(),
            activity_source_id: activity_source_id.to_string(),
            verified_game_id: verified_game_id.to_string(),
            name: name.to_string(),
            started_at: observed_at,
            ended_at: observed_at,
            last_observed_at: observed_at,
        }
    }

    pub async fn record_verified_game(
        db: &Database,
        user_id: &str,
        activity_source_id: &str,
        verified_game_id: &str,
        name: &str,
        observed_at: i64,
    ) -> Result<Self> {
        db.record_verified_game_activity_session(
            user_id,
            activity_source_id,
            verified_game_id,
            name,
            observed_at,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use crate::{ActivitySession, DatabaseInfo};

    #[async_std::test]
    async fn same_game_with_short_gap_extends_existing_session() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference db connects");

        ActivitySession::record_verified_game(
            &db,
            "user-1",
            "desktop:game",
            "cs2.exe",
            "Counter-Strike 2",
            1_000,
        )
        .await
        .expect("first activity records");
        ActivitySession::record_verified_game(
            &db,
            "user-1",
            "desktop:game",
            "cs2.exe",
            "Counter-Strike 2",
            61_000,
        )
        .await
        .expect("second activity records");

        let sessions = db
            .fetch_user_activity_sessions("user-1")
            .await
            .expect("sessions fetch");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].started_at, 1_000);
        assert_eq!(sessions[0].ended_at, 61_000);
    }

    #[async_std::test]
    async fn same_game_after_gap_creates_new_session() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference db connects");

        ActivitySession::record_verified_game(
            &db,
            "user-1",
            "desktop:game",
            "cs2.exe",
            "Counter-Strike 2",
            1_000,
        )
        .await
        .expect("first activity records");
        ActivitySession::record_verified_game(
            &db,
            "user-1",
            "desktop:game",
            "cs2.exe",
            "Counter-Strike 2",
            1_000 + super::ACTIVITY_SESSION_CONTINUE_GAP_MS + 1,
        )
        .await
        .expect("second activity records");

        let sessions = db
            .fetch_user_activity_sessions("user-1")
            .await
            .expect("sessions fetch");
        assert_eq!(sessions.len(), 2);
    }
}
