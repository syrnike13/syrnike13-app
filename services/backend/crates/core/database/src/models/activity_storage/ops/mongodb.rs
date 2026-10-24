use bson::to_document;
use futures::TryStreamExt;
use syrnike_models::v0;
use syrnike_result::Result;

use crate::{combine_activity_score, ActivityPlayerData, ActivityScore, MongoDb};

use super::AbstractActivityStorage;

static PLAYER_DATA_COL: &str = "activity_player_data";
static SCORES_COL: &str = "activity_scores";
const SCORE_RETRY_LIMIT: usize = 8;

#[async_trait]
impl AbstractActivityStorage for MongoDb {
    async fn fetch_activity_player_data(
        &self,
        application_id: &str,
        scope_id: &str,
        user_id: &str,
    ) -> Result<Option<ActivityPlayerData>> {
        self.col::<ActivityPlayerData>(PLAYER_DATA_COL)
            .find_one(doc! {
                "application_id": application_id,
                "scope_id": scope_id,
                "user_id": user_id,
            })
            .await
            .map_err(|_| create_database_error!("find_one", PLAYER_DATA_COL))
    }

    async fn save_activity_player_data(&self, data: &ActivityPlayerData) -> Result<()> {
        self.col::<ActivityPlayerData>(PLAYER_DATA_COL)
            .replace_one(
                doc! {
                    "application_id": &data.application_id,
                    "scope_id": &data.scope_id,
                    "user_id": &data.user_id,
                },
                data,
            )
            .upsert(true)
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("replace_one", PLAYER_DATA_COL))
    }

    async fn fetch_activity_score(
        &self,
        application_id: &str,
        scope_id: &str,
        key: &str,
        user_id: &str,
    ) -> Result<Option<ActivityScore>> {
        self.col::<ActivityScore>(SCORES_COL)
            .find_one(doc! {
                "application_id": application_id,
                "scope_id": scope_id,
                "key": key,
                "user_id": user_id,
            })
            .await
            .map_err(|_| create_database_error!("find_one", SCORES_COL))
    }

    async fn submit_activity_score(
        &self,
        score: &ActivityScore,
        mode: v0::ActivityScoreMode,
    ) -> Result<ActivityScore> {
        for _ in 0..SCORE_RETRY_LIMIT {
            let existing = self
                .fetch_activity_score(
                    &score.application_id,
                    &score.scope_id,
                    &score.key,
                    &score.user_id,
                )
                .await?;
            let Some(value) =
                combine_activity_score(existing.as_ref().map(|s| s.value), score.value, mode)
            else {
                return existing.ok_or_else(|| create_error!(InternalError));
            };
            let next = ActivityScore {
                value,
                ..score.clone()
            };

            let Some(existing) = existing else {
                // A concurrent first submission wins the unique index; retry against it.
                if self
                    .col::<ActivityScore>(SCORES_COL)
                    .insert_one(&next)
                    .await
                    .is_ok()
                {
                    return Ok(next);
                }
                continue;
            };

            let result = self
                .col::<ActivityScore>(SCORES_COL)
                .update_one(
                    doc! {
                        "application_id": &score.application_id,
                        "scope_id": &score.scope_id,
                        "key": &score.key,
                        "user_id": &score.user_id,
                        "value": existing.value,
                    },
                    doc! {
                        "$set": to_document(&next)
                            .map_err(|_| create_database_error!("to_document", SCORES_COL))?
                    },
                )
                .await
                .map_err(|_| create_database_error!("update_one", SCORES_COL))?;
            if result.matched_count == 1 {
                return Ok(next);
            }
        }
        Err(create_error!(InternalError))
    }

    async fn fetch_activity_leaderboard(
        &self,
        application_id: &str,
        scope_id: &str,
        key: &str,
        limit: i64,
        ascending: bool,
    ) -> Result<Vec<ActivityScore>> {
        let direction = if ascending { 1_i32 } else { -1_i32 };
        self.col::<ActivityScore>(SCORES_COL)
            .find(doc! {
                "application_id": application_id,
                "scope_id": scope_id,
                "key": key,
            })
            .sort(doc! { "value": direction, "updated_at": 1_i32 })
            .limit(limit)
            .await
            .map_err(|_| create_database_error!("find", SCORES_COL))?
            .try_collect()
            .await
            .map_err(|_| create_database_error!("collect", SCORES_COL))
    }
}
