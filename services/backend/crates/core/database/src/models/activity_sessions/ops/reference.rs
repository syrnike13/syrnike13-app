use super::AbstractActivitySessions;
use crate::{ActivitySession, ReferenceDb, ACTIVITY_SESSION_CONTINUE_GAP_MS};
use syrnike_result::Result;

#[async_trait]
impl AbstractActivitySessions for ReferenceDb {
    async fn record_verified_game_activity_session(
        &self,
        user_id: &str,
        activity_source_id: &str,
        verified_game_id: &str,
        name: &str,
        observed_at: i64,
    ) -> Result<ActivitySession> {
        let mut sessions = self.activity_sessions.lock().await;

        if let Some(existing_id) = sessions
            .values()
            .filter(|session| {
                session.user_id == user_id && session.activity_source_id == activity_source_id
            })
            .max_by_key(|session| session.ended_at)
            .map(|session| session.id.clone())
        {
            let existing = sessions
                .get_mut(&existing_id)
                .expect("session id came from the same map");
            if existing.verified_game_id == verified_game_id
                && observed_at <= existing.ended_at + ACTIVITY_SESSION_CONTINUE_GAP_MS
            {
                existing.name = name.to_string();
                existing.ended_at = existing.ended_at.max(observed_at);
                existing.last_observed_at = observed_at;
                return Ok(existing.clone());
            }
        }

        let session = ActivitySession::new_verified_game(
            user_id,
            activity_source_id,
            verified_game_id,
            name,
            observed_at,
        );
        sessions.insert(session.id.clone(), session.clone());
        Ok(session)
    }

    async fn finish_activity_session_source(
        &self,
        user_id: &str,
        activity_source_id: &str,
        observed_at: i64,
    ) -> Result<()> {
        let mut sessions = self.activity_sessions.lock().await;
        let existing_id = sessions
            .values()
            .filter(|session| {
                session.user_id == user_id && session.activity_source_id == activity_source_id
            })
            .max_by_key(|session| session.ended_at)
            .map(|session| session.id.clone());

        if let Some(existing_id) = existing_id {
            let existing = sessions
                .get_mut(&existing_id)
                .expect("session id came from the same map");
            existing.ended_at = existing.ended_at.max(observed_at);
            existing.last_observed_at = observed_at;
        }

        Ok(())
    }

    async fn fetch_user_activity_sessions(&self, user_id: &str) -> Result<Vec<ActivitySession>> {
        let sessions = self.activity_sessions.lock().await;
        let mut sessions = sessions
            .values()
            .filter(|session| session.user_id == user_id)
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| session.started_at);
        Ok(sessions)
    }
}
