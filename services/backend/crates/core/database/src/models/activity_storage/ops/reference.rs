use syrnike_models::v0;
use syrnike_result::Result;

use crate::{
    combine_activity_score, sort_activity_leaderboard, ActivityPlayerData, ActivityScore,
    ReferenceDb,
};

use super::AbstractActivityStorage;

#[async_trait]
impl AbstractActivityStorage for ReferenceDb {
    async fn fetch_activity_player_data(
        &self,
        application_id: &str,
        scope_id: &str,
        user_id: &str,
    ) -> Result<Option<ActivityPlayerData>> {
        Ok(self
            .activity_player_data
            .lock()
            .await
            .get(&(
                application_id.to_string(),
                scope_id.to_string(),
                user_id.to_string(),
            ))
            .cloned())
    }

    async fn save_activity_player_data(&self, data: &ActivityPlayerData) -> Result<()> {
        self.activity_player_data.lock().await.insert(
            (
                data.application_id.clone(),
                data.scope_id.clone(),
                data.user_id.clone(),
            ),
            data.clone(),
        );
        Ok(())
    }

    async fn fetch_activity_score(
        &self,
        application_id: &str,
        scope_id: &str,
        key: &str,
        user_id: &str,
    ) -> Result<Option<ActivityScore>> {
        Ok(self
            .activity_scores
            .lock()
            .await
            .get(&(
                application_id.to_string(),
                scope_id.to_string(),
                key.to_string(),
                user_id.to_string(),
            ))
            .cloned())
    }

    async fn submit_activity_score(
        &self,
        score: &ActivityScore,
        mode: v0::ActivityScoreMode,
    ) -> Result<ActivityScore> {
        let mut scores = self.activity_scores.lock().await;
        let id = (
            score.application_id.clone(),
            score.scope_id.clone(),
            score.key.clone(),
            score.user_id.clone(),
        );
        let existing = scores.get(&id).cloned();
        match combine_activity_score(existing.as_ref().map(|s| s.value), score.value, mode) {
            Some(value) => {
                let next = ActivityScore {
                    value,
                    ..score.clone()
                };
                scores.insert(id, next.clone());
                Ok(next)
            }
            None => existing.ok_or_else(|| create_error!(InternalError)),
        }
    }

    async fn fetch_activity_leaderboard(
        &self,
        application_id: &str,
        scope_id: &str,
        key: &str,
        limit: i64,
        ascending: bool,
    ) -> Result<Vec<ActivityScore>> {
        let mut scores = self
            .activity_scores
            .lock()
            .await
            .values()
            .filter(|score| {
                score.application_id == application_id
                    && score.scope_id == scope_id
                    && score.key == key
            })
            .cloned()
            .collect::<Vec<_>>();
        sort_activity_leaderboard(&mut scores, ascending);
        scores.truncate(usize::try_from(limit).unwrap_or(0));
        Ok(scores)
    }
}
