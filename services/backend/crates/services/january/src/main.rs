use std::net::{Ipv4Addr, SocketAddr};

use axum::Router;

use tokio::net::TcpListener;
use utoipa::{
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
    Modify, OpenApi,
};
use utoipa_scalar::{Scalar, Servable as ScalarServable};

mod api;
pub mod requests;
pub mod website_embed;

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    // Configure logging and environment
    syrnike_config::configure!(proxy);

    // Configure API schema
    #[derive(OpenApi)]
    #[openapi(
        modifiers(&SecurityAddon),
        paths(
            api::root,
            api::proxy,
            api::embed
        ),
        components(
            schemas(
                api::RootResponse,
                syrnike_result::Error,
                syrnike_result::ErrorType,
                syrnike_models::v0::ImageSize,
                syrnike_models::v0::Image,
                syrnike_models::v0::Video,
                syrnike_models::v0::TwitchType,
                syrnike_models::v0::LightspeedType,
                syrnike_models::v0::BandcampType,
                syrnike_models::v0::Special,
                syrnike_models::v0::WebsiteMetadata,
                syrnike_models::v0::Text,
                syrnike_models::v0::Embed
            )
        )
    )]
    struct ApiDoc;

    struct SecurityAddon;

    impl Modify for SecurityAddon {
        fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
            if let Some(components) = openapi.components.as_mut() {
                components.add_security_scheme(
                    "api_key",
                    SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
                )
            }
        }
    }

    // Configure Axum and router
    let app = Router::new()
        .merge(Scalar::with_url("/scalar", ApiDoc::openapi()))
        .nest("/", api::router().await);

    // Configure TCP listener and bind
    tracing::info!("Listening on 0.0.0.0:14705");
    tracing::info!("Play around with the API: http://localhost:14705/scalar");
    let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, 14705));
    let listener = TcpListener::bind(&address).await?;
    axum::serve(listener, app.into_make_service()).await
}
