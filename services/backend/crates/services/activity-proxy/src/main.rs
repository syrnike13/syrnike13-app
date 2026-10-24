//! Activity proxy (ADR-0011): serves every Activity Origin
//! (`{id}.activities.…`) by forwarding to the registered application upstream.

use axum::Router;
use syrnike_database::DatabaseInfo;
use tokio::net::TcpListener;

mod proxy;
mod rules;

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    syrnike_config::configure!(activity_proxy);
    let settings = syrnike_config::config().await;

    let db = DatabaseInfo::Auto
        .connect()
        .await
        .expect("Unable to connect to database");
    let state = proxy::AppState::new(db, &settings).expect("Invalid activity proxy configuration");

    let app = Router::new().fallback(proxy::handle).with_state(state);

    let listen = &settings.activities.proxy_listen;
    log::info!("Listening on {listen} for {}", settings.hosts.activities);
    let listener = TcpListener::bind(listen).await?;
    axum::serve(listener, app).await
}
