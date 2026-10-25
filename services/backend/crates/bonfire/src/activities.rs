//! Gateway side of Channel Activities (ADR-0011): request dispatch, per
//! connection rate limits and the periodic reconciler.

use std::time::{Duration, Instant};

use syrnike_database::{
    activities::{self, logic::valid_identifier, ActivityError, ActivityReply},
    events::{
        client::{ActivityErrorCode, EventV1},
        server::ActivityRequest,
    },
    Database, User,
};

const RECONCILE_INTERVAL: Duration = Duration::from_secs(10);

/// Token bucket refilled continuously at `rate` tokens per second.
#[derive(Debug, Clone)]
pub struct TokenBucket {
    capacity: f64,
    rate: f64,
    tokens: f64,
    updated_at: Instant,
}

impl TokenBucket {
    pub fn new(per_second: u32, now: Instant) -> Self {
        let capacity = f64::from(per_second);
        Self {
            capacity,
            rate: capacity,
            tokens: capacity,
            updated_at: now,
        }
    }

    pub fn try_take(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.updated_at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.rate).min(self.capacity);
        self.updated_at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Activity rate limits of one gateway connection.
#[derive(Debug, Clone)]
pub struct ActivityRateLimits {
    send: TokenBucket,
    set_state: TokenBucket,
}

impl Default for ActivityRateLimits {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            send: TokenBucket::new(30, now),
            set_state: TokenBucket::new(10, now),
        }
    }
}

impl ActivityRateLimits {
    fn allows(&mut self, request: &ActivityRequest, now: Instant) -> bool {
        match request {
            ActivityRequest::Send { .. } => self.send.try_take(now),
            ActivityRequest::SetState { .. } => self.set_state.try_take(now),
            _ => true,
        }
    }
}

/// Handle one `ClientMessage::Activity`; always returns the `ActivityResponse`.
pub async fn handle_request(
    db: &Database,
    user: &User,
    limits: &mut ActivityRateLimits,
    request_id: String,
    request: ActivityRequest,
) -> EventV1 {
    let result = if !valid_identifier(&request_id) {
        Err(ActivityErrorCode::InvalidRequest.into())
    } else if !limits.allows(&request, Instant::now()) {
        Err(ActivityErrorCode::RateLimited.into())
    } else {
        dispatch(db, user, request).await
    };

    match result {
        Ok(ActivityReply { instance, state }) => EventV1::ActivityResponse {
            request_id,
            error: None,
            instance,
            state,
        },
        Err(ActivityError { code, state }) => EventV1::ActivityResponse {
            request_id,
            error: Some(code),
            instance: None,
            state,
        },
    }
}

async fn dispatch(
    db: &Database,
    user: &User,
    request: ActivityRequest,
) -> activities::ActivityResult<ActivityReply> {
    match request {
        ActivityRequest::Start {
            channel_id,
            application_id,
        } => activities::start(db, user, &channel_id, &application_id).await,
        ActivityRequest::Join {
            channel_id,
            instance_id,
        } => activities::join(db, user, &channel_id, &instance_id).await,
        ActivityRequest::Leave {
            channel_id,
            instance_id,
        } => activities::leave(&user.id, &channel_id, &instance_id).await,
        ActivityRequest::End {
            channel_id,
            instance_id,
        } => activities::end(db, user, &channel_id, &instance_id).await,
        ActivityRequest::Send {
            channel_id,
            instance_id,
            payload,
            to,
        } => activities::send(&user.id, &channel_id, &instance_id, payload, to).await,
        ActivityRequest::SetState {
            channel_id,
            instance_id,
            expected_version,
            data,
        } => {
            activities::set_state(&user.id, &channel_id, &instance_id, expected_version, data).await
        }
        ActivityRequest::Sync {
            channel_id,
            instance_id,
        } => activities::sync(&user.id, &channel_id, &instance_id).await,
    }
}

/// Periodically drop participants who left voice and end instances that are
/// empty or whose application is no longer available.
pub async fn run_reconciler(db: &'static Database) {
    loop {
        async_std::task::sleep(RECONCILE_INTERVAL).await;
        if let Err(error) = activities::reconcile(db).await {
            warn!("Failed to reconcile Channel Activities: {error:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bucket_allows_burst_then_refills() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(10, start);
        for _ in 0..10 {
            assert!(bucket.try_take(start));
        }
        assert!(!bucket.try_take(start));
        assert!(bucket.try_take(start + Duration::from_millis(100)));
        assert!(!bucket.try_take(start + Duration::from_millis(100)));
        for _ in 0..10 {
            assert!(bucket.try_take(start + Duration::from_secs(5)));
        }
        assert!(!bucket.try_take(start + Duration::from_secs(5)));
    }

    #[test]
    fn rate_limits_apply_only_to_send_and_set_state() {
        let now = Instant::now();
        let mut limits = ActivityRateLimits::default();
        let set_state = ActivityRequest::SetState {
            channel_id: "c".into(),
            instance_id: "i".into(),
            expected_version: 0,
            data: serde_json::Value::Null,
        };
        let sync = ActivityRequest::Sync {
            channel_id: "c".into(),
            instance_id: "i".into(),
        };
        for _ in 0..10 {
            assert!(limits.allows(&set_state, now));
        }
        assert!(!limits.allows(&set_state, now));
        assert!(limits.allows(&sync, now));
    }
}
