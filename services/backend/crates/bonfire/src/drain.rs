//! Graceful shutdown: hand connected clients over to another gateway process.
//!
//! On SIGTERM the process stops accepting connections and asks every client
//! to reconnect, spread over `RECONNECT_SPREAD` so the new process does not
//! receive every Ready request at once. Clients open their new connection
//! before closing this one, so they miss no events.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use once_cell::sync::Lazy;
use rand::Rng;

/// Window over which reconnect requests are spread.
pub const RECONNECT_SPREAD: Duration = Duration::from_secs(10);
/// How long a client may keep its old connection after the request.
pub const CLOSE_AFTER_RECONNECT: Duration = Duration::from_secs(20);

static NEXT_ID: AtomicU64 = AtomicU64::new(0);
static CONNECTIONS: Lazy<Mutex<HashMap<u64, async_channel::Sender<Duration>>>> =
    Lazy::new(Default::default);

/// A connection that takes part in draining; unregisters on drop.
pub struct Registration {
    id: u64,
    reconnect_after: async_channel::Receiver<Duration>,
}

impl Registration {
    /// Resolves with the delay after which the client should be asked to reconnect.
    pub async fn reconnect_requested(&self) -> Duration {
        match self.reconnect_after.recv().await {
            Ok(delay) => delay,
            Err(_) => futures::future::pending().await,
        }
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        CONNECTIONS.lock().unwrap().remove(&self.id);
    }
}

pub fn register() -> Registration {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (sender, reconnect_after) = async_channel::bounded(1);
    CONNECTIONS.lock().unwrap().insert(id, sender);
    Registration {
        id,
        reconnect_after,
    }
}

/// Ask every connection to reconnect and wait until they are gone.
pub async fn drain() {
    let senders: Vec<_> = CONNECTIONS.lock().unwrap().values().cloned().collect();
    info!("Draining {} gateway connections.", senders.len());

    for sender in senders {
        let delay = rand::thread_rng().gen_range(Duration::ZERO..RECONNECT_SPREAD);
        sender.try_send(delay).ok();
    }

    let deadline =
        Instant::now() + RECONNECT_SPREAD + CLOSE_AFTER_RECONNECT + Duration::from_secs(2);
    while Instant::now() < deadline {
        let remaining = CONNECTIONS.lock().unwrap().len();
        if remaining == 0 {
            info!("All gateway connections drained.");
            return;
        }
        async_std::task::sleep(Duration::from_millis(250)).await;
    }

    warn!(
        "Gateway drain timed out with {} connections left.",
        CONNECTIONS.lock().unwrap().len()
    );
}

/// Resolves once the process is asked to stop.
#[cfg(unix)]
pub async fn shutdown_signal() {
    use async_signal::{Signal, Signals};
    use futures::StreamExt;

    let mut signals = Signals::new([Signal::Term, Signal::Int]).expect("signal handlers");
    signals.next().await;
}

#[cfg(not(unix))]
pub async fn shutdown_signal() {
    futures::future::pending::<()>().await
}
