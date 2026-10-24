use std::env;
use std::pin::Pin;
use std::time::Duration;

use async_std::net::TcpListener;
use futures::{pin_mut, select, FutureExt};
use syrnike_database::AMQP;
use syrnike_presence::{clear_dead_regions, mark_region_alive, release_region};

#[macro_use]
extern crate log;

pub mod config;
pub mod events;

mod database;
mod drain;
mod voice;
mod voice_client;
mod websocket;

/// Interval between presence liveness refreshes of this process.
const REGION_ALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// Delay before the first stale presence sweep. A gone process's liveness key
/// needs up to its TTL to expire, and a gateway that predates per-process
/// regions has no key, so give a gateway being replaced that long to stop.
const DEAD_REGION_SWEEP_DELAY: Duration =
    Duration::from_secs(syrnike_presence::REGION_ALIVE_TTL_SECS + 5);
const DEAD_REGION_SWEEP_INTERVAL: Duration = Duration::from_secs(30);

#[async_std::main]
async fn main() {
    // Configure requirements for Bonfire.
    syrnike_config::configure!(events);
    database::connect().await;
    voice_client::init().await;
    let amqp = AMQP::new_auto().await;

    // Keep this process's presence region alive and clean up after gateways that are gone.
    mark_region_alive().await;
    async_std::task::spawn(async {
        loop {
            async_std::task::sleep(REGION_ALIVE_INTERVAL).await;
            mark_region_alive().await;
        }
    });

    let no_clear_region = env::var("NO_CLEAR_PRESENCE").unwrap_or_else(|_| "0".into()) == "1";
    if !no_clear_region {
        async_std::task::spawn(async {
            async_std::task::sleep(DEAD_REGION_SWEEP_DELAY).await;
            loop {
                clear_dead_regions().await;
                async_std::task::sleep(DEAD_REGION_SWEEP_INTERVAL).await;
            }
        });
    }

    // Setup a TCP listener to accept WebSocket connections on.
    // By default, we bind to port 14703 on all interfaces.
    let bind = env::var("HOST").unwrap_or_else(|_| "0.0.0.0:14703".into());
    info!("Listening on host {bind}");
    let try_socket = TcpListener::bind(bind).await;
    let listener = try_socket.expect("Failed to bind");

    {
        let accept = accept_connections(listener, amqp).fuse();
        let shutdown = drain::shutdown_signal().fuse();
        pin_mut!(accept, shutdown);

        select! {
            _ = accept => {},
            _ = shutdown => info!("Shutdown requested, handing clients over."),
        }
        // Dropping the accept loop closes the listener, so new connections
        // reach the replacement process.
    }

    drain::drain().await;
    release_region().await;
}

/// Accept new connections and spawn a client for each connection.
async fn accept_connections(listener: TcpListener, amqp: AMQP) {
    while let Ok((stream, addr)) = listener.accept().await {
        let amqp = amqp.clone();
        async_std::task::spawn(async move {
            info!("User connected from {addr:?}");
            Pin::from(Box::new(websocket::client(
                database::get_db(),
                amqp,
                stream,
                addr,
            )))
            .await;
            info!("User disconnected from {addr:?}");
        });
    }
}
