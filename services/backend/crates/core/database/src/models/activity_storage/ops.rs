use syrnike_models::v0;
use syrnike_result::Result;

use crate::{ActivityPlayerData, ActivityScore};

#[cfg(feature = "mongodb")]
mod mongodb;
mod reference;

#[async_trait]
pub trait AbstractActivityStorage: Sync + Send {
    /// Fetch player data for `(application, scope, user)`.
    async fn fetch_activity_player_data(
        &self,
        application_id: &str,
        scope_id: &str,
        user_id: &str,
    ) -> Result<Option<ActivityPlayerData>>;

    /// Insert or replace player data.
    async fn save_activity_player_data(&self, data: &ActivityPlayerData) -> Result<()>;

    /// Fetch one user's score.
    async fn fetch_activity_score(
        &self,
        application_id: &str,
        scope_id: &str,
        key: &str,
        user_id: &str,
    ) -> Result<Option<ActivityScore>>;

    /// Combine a submitted score with the stored one and return the stored result.
    async fn submit_activity_score(
        &self,
        score: &ActivityScore,
        mode: v0::ActivityScoreMode,
    ) -> Result<ActivityScore>;

    /// Best `limit` scores for `(application, scope, key)`.
    async fn fetch_activity_leaderboard(
        &self,
        application_id: &str,
        scope_id: &str,
        key: &str,
        limit: i64,
        ascending: bool,
    ) -> Result<Vec<ActivityScore>>;
}
