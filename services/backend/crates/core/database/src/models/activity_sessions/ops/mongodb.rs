use super::AbstractActivitySessions;
use crate::{
    mongodb::{
        bson::{doc, Document},
        options::FindOneOptions,
    },
    ActivitySession, MongoDb, ACTIVITY_SESSION_CONTINUE_GAP_MS,
};
use futures::StreamExt;
use syrnike_result::Result;

static COL: &str = "activity_sessions";

#[async_trait]
impl AbstractActivitySessions for MongoDb {
    async fn record_verified_game_activity_session(
        &self,
        user_id: &str,
        activity_source_id: &str,
        verified_game_id: &str,
        name: &str,
        observed_at: i64,
    ) -> Result<ActivitySession> {
        let latest = latest_source_session(self, user_id, activity_source_id).await?;

        if let Some(mut session) = latest {
            if session.verified_game_id == verified_game_id
                && observed_at <= session.ended_at + ACTIVITY_SESSION_CONTINUE_GAP_MS
            {
                session.name = name.to_string();
                session.ended_at = session.ended_at.max(observed_at);
                session.last_observed_at = observed_at;
                self.col::<Document>(COL)
                    .update_one(
                        doc! { "_id": &session.id },
                        doc! {
                            "$set": {
                                "name": &session.name,
                                "ended_at": session.ended_at,
                                "last_observed_at": session.last_observed_at,
                            }
                        },
                    )
                    .await
                    .map_err(|_| create_database_error!("update", COL))?;
                return Ok(session);
            }
        }

        let session = ActivitySession::new_verified_game(
            user_id,
            activity_source_id,
            verified_game_id,
            name,
            observed_at,
        );
        query!(self, insert_one, COL, &session).map(|_| session)
    }

    async fn finish_activity_session_source(
        &self,
        user_id: &str,
        activity_source_id: &str,
        observed_at: i64,
    ) -> Result<()> {
        let Some(mut session) = latest_source_session(self, user_id, activity_source_id).await?
        else {
            return Ok(());
        };

        session.ended_at = session.ended_at.max(observed_at);
        session.last_observed_at = observed_at;
        self.col::<Document>(COL)
            .update_one(
                doc! { "_id": &session.id },
                doc! {
                    "$set": {
                        "ended_at": session.ended_at,
                        "last_observed_at": session.last_observed_at,
                    }
                },
            )
            .await
            .map(|_| ())
            .map_err(|_| create_database_error!("update", COL))
    }

    async fn fetch_user_activity_sessions(&self, user_id: &str) -> Result<Vec<ActivitySession>> {
        Ok(self
            .col::<ActivitySession>(COL)
            .find(doc! { "user_id": user_id })
            .sort(doc! { "started_at": 1_i32 })
            .await
            .map_err(|_| create_database_error!("fetch", COL))?
            .filter_map(|session| async {
                if cfg!(debug_assertions) {
                    Some(session.unwrap())
                } else {
                    session.ok()
                }
            })
            .collect()
            .await)
    }
}

async fn latest_source_session(
    db: &MongoDb,
    user_id: &str,
    activity_source_id: &str,
) -> Result<Option<ActivitySession>> {
    let options = FindOneOptions::builder()
        .sort(doc! { "ended_at": -1_i32 })
        .build();
    db.find_one_with_options(
        COL,
        doc! {
            "user_id": user_id,
            "activity_source_id": activity_source_id,
        },
        options,
    )
    .await
    .map_err(|_| create_database_error!("fetch", COL))
}
