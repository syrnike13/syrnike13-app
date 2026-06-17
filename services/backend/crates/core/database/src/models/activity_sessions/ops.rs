use syrnike_result::Result;

use crate::ActivitySession;

#[cfg(feature = "mongodb")]
mod mongodb;
mod reference;

#[async_trait]
pub trait AbstractActivitySessions: Sync + Send {
    /// Record or extend a verified game activity session.
    async fn record_verified_game_activity_session(
        &self,
        user_id: &str,
        activity_source_id: &str,
        verified_game_id: &str,
        name: &str,
        observed_at: i64,
    ) -> Result<ActivitySession>;

    /// Finish the latest session for a realtime activity source.
    async fn finish_activity_session_source(
        &self,
        user_id: &str,
        activity_source_id: &str,
        observed_at: i64,
    ) -> Result<()>;

    /// Fetch user activity sessions. Used by tests and future summary surfaces.
    async fn fetch_user_activity_sessions(&self, user_id: &str) -> Result<Vec<ActivitySession>>;
}
