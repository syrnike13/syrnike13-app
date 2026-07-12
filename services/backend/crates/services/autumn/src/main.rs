use std::net::{Ipv4Addr, SocketAddr};

use axum::{middleware::from_fn_with_state, Router};

use axum_macros::FromRef;
use syrnike_database::{Database, DatabaseInfo};
use syrnike_files::{EncryptionKey, S3Storage};
use syrnike_ratelimits::axum as ratelimiter;
use tokio::net::TcpListener;
use utoipa::{
    openapi::security::{ApiKey, ApiKeyValue, SecurityScheme},
    Modify, OpenApi,
};
use utoipa_scalar::{Scalar, Servable as ScalarServable};

mod api;
pub mod clamav;
pub mod exif;
pub mod metadata;
pub mod mime_type;
mod ratelimits;
mod utils;

#[derive(FromRef, Clone)]
struct AppState {
    database: Database,
    storage: S3Storage<EncryptionKey>,
    ratelimit_storage: ratelimiter::RatelimitStorage,
}

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    // Configure logging and environment
    syrnike_config::configure!(files);

    // Wait for ClamAV
    clamav::init().await;

    // Configure API schema
    #[derive(OpenApi)]
    #[openapi(
        modifiers(&SecurityAddon),
        paths(
            api::root,
            api::upload_file,
            api::fetch_preview,
            api::fetch_file
        ),
        components(
            schemas(
                syrnike_result::Error,
                syrnike_result::ErrorType,
                api::RootResponse,
                api::Tag,
                api::UploadPayload,
                api::UploadResponse
            )
        ),
        tags(
            // (name = "Files", description = "File uploads API")
        )
    )]
    struct ApiDoc;

    struct SecurityAddon;

    impl Modify for SecurityAddon {
        fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
            if let Some(components) = openapi.components.as_mut() {
                components.add_security_scheme(
                    "bot_token",
                    SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("X-Bot-Token"))),
                );
                components.add_security_scheme(
                    "session_token",
                    SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("X-Session-Token"))),
                );
            }
        }
    }

    // Connect to the database
    let db = DatabaseInfo::Auto.connect().await.unwrap();
    let storage = S3Storage::from_config(EncryptionKey::from_config().await).await;
    let ratelimits = ratelimiter::RatelimitStorage::new(ratelimits::AutumnRatelimits);

    let state = AppState {
        database: db,
        storage,
        ratelimit_storage: ratelimits,
    };

    // Configure Axum and router
    let app = Router::new()
        .merge(Scalar::with_url("/scalar", ApiDoc::openapi()))
        .nest("/", api::router().await)
        .nest("/", ratelimiter::routes())
        .layer(from_fn_with_state(
            state.clone(),
            ratelimiter::ratelimit_middleware,
        ))
        .with_state(state);

    // Configure TCP listener and bind
    let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, 14704));
    let listener = TcpListener::bind(&address).await?;
    axum::serve(listener, app.into_make_service()).await
}
