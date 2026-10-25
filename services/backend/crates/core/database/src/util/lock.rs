use std::{
    collections::HashSet,
    future::Future,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

use redis_kiss::{
    AsyncCommands,
    redis::{ExistenceCheck, SetExpiry, SetOptions, cmd},
};
use syrnike_result::{Result, ToSyrnikeError, create_error};

use crate::Database;

const LOCK_TTL_SECONDS: usize = 120;
const LOCK_RETRY_LIMIT: usize = 200;
const LOCK_RETRY_DELAY_MS: u64 = 10;
const LOCK_RENEW_INTERVAL_SECONDS: u64 = 30;
const RENEW_LOCK: &str = r#"
local key = KEYS[1]
local token = ARGV[1]
local ttl = ARGV[2]

if redis.call('GET', key) == token then
    return redis.call('EXPIRE', key, ttl)
end

return 0
"#;
const RELEASE_LOCK: &str = r#"
local key = KEYS[1]
local token = ARGV[1]

if redis.call('GET', key) == token then
    return redis.call('DEL', key)
end

return 0
"#;

static REFERENCE_LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct ReferenceLock {
    key: String,
}

impl Drop for ReferenceLock {
    fn drop(&mut self) {
        REFERENCE_LOCKS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.key);
    }
}

struct LockRenewalGuard {
    stopped: Arc<AtomicBool>,
}

impl Drop for LockRenewalGuard {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

async fn get_connection() -> Result<redis_kiss::Conn> {
    redis_kiss::get_connection()
        .await
        .map_err(|_| create_error!(InternalError))
}

/// Run `operation` while holding a distributed lock named `key`.
///
/// The reference database uses a process-local lock so tests do not need Redis.
pub async fn with_lock<T, F, Fut>(db: &Database, key: &str, operation: F) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    if matches!(db, Database::Reference(_)) {
        for _ in 0..LOCK_RETRY_LIMIT {
            let acquired = REFERENCE_LOCKS
                .get_or_init(|| Mutex::new(HashSet::new()))
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(key.to_string());
            if acquired {
                let _guard = ReferenceLock {
                    key: key.to_string(),
                };
                return operation().await;
            }
            async_std::task::sleep(std::time::Duration::from_millis(LOCK_RETRY_DELAY_MS)).await;
        }
        return Err(create_error!(InternalError));
    }

    let token = ulid::Ulid::new().to_string();
    let mut acquired = false;
    let mut connection = get_connection().await?.into_inner();

    for _ in 0..LOCK_RETRY_LIMIT {
        let set_result: Option<String> = connection
            .set_options(
                key,
                &token,
                SetOptions::default()
                    .conditional_set(ExistenceCheck::NX)
                    .with_expiration(SetExpiry::EX(LOCK_TTL_SECONDS)),
            )
            .await
            .to_internal_error()?;
        if set_result.is_some() {
            acquired = true;
            break;
        }

        async_std::task::sleep(std::time::Duration::from_millis(LOCK_RETRY_DELAY_MS)).await;
    }
    drop(connection);

    if !acquired {
        return Err(create_error!(InternalError));
    }

    let stop_renewal = Arc::new(AtomicBool::new(false));
    let renewal_guard = LockRenewalGuard {
        stopped: Arc::clone(&stop_renewal),
    };
    let renewal_stopped = Arc::clone(&stop_renewal);
    let renewal_key = key.to_string();
    let renewal_token = token.clone();
    async_std::task::spawn(async move {
        while !renewal_stopped.load(Ordering::Acquire) {
            async_std::task::sleep(std::time::Duration::from_secs(LOCK_RENEW_INTERVAL_SECONDS))
                .await;
            if renewal_stopped.load(Ordering::Acquire) {
                break;
            }

            let renewal_result: Result<i64> = async {
                cmd("EVAL")
                    .arg(RENEW_LOCK)
                    .arg(1)
                    .arg(&renewal_key)
                    .arg(&renewal_token)
                    .arg(LOCK_TTL_SECONDS)
                    .query_async::<_, i64>(&mut get_connection().await?.into_inner())
                    .await
                    .to_internal_error()
            }
            .await;
            match renewal_result {
                Ok(1) => {}
                Ok(_) => break,
                Err(error) => {
                    syrnike_config::capture_internal_error!(&error);
                }
            }
        }
    });

    let result = operation().await;
    drop(renewal_guard);
    let release_result: Result<i64> = async {
        cmd("EVAL")
            .arg(RELEASE_LOCK)
            .arg(1)
            .arg(key)
            .arg(&token)
            .query_async::<_, i64>(&mut get_connection().await?.into_inner())
            .await
            .to_internal_error()
    }
    .await;
    if let Err(error) = release_result {
        syrnike_config::capture_internal_error!(&error);
    }

    result
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::with_lock;

    #[async_std::test]
    async fn operations_under_the_same_key_do_not_interleave() {
        let db = crate::DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let counter = Arc::new(AtomicUsize::new(0));

        let increment = || {
            let counter = Arc::clone(&counter);
            let db = db.clone();
            async move {
                with_lock(&db, "lock_test:counter", || async {
                    let value = counter.load(Ordering::SeqCst);
                    async_std::task::sleep(std::time::Duration::from_millis(50)).await;
                    counter.store(value + 1, Ordering::SeqCst);
                    Ok(())
                })
                .await
            }
        };

        let (first, second) = futures::join!(increment(), increment());
        first.expect("first increment");
        second.expect("second increment");
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }
}
