//! Request handling: registry lookups, forwarding, WebSocket upgrades, and
//! the internal `/_health` and `/_caddy/ask` endpoints.

use std::{sync::Arc, time::Duration};

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::{
    client::legacy::{connect::HttpConnector, Client},
    rt::{TokioExecutor, TokioIo},
};
use moka::future::Cache;
use syrnike_database::{ActivityApplication, Database};
use syrnike_result::ErrorType;
use tower::ServiceExt;

use crate::rules::{self, AskRoute, OriginTemplate};

const REGISTRY_TTL: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const ASK_TIMEOUT: Duration = Duration::from_secs(5);

type Connector = HttpsConnector<HttpConnector>;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    db: Database,
    template: OriginTemplate,
    client_origins: String,
    ask_delegate_suffix: String,
    ask_delegate_url: String,
    connector: Connector,
    client: Client<Connector, Body>,
    /// Enabled applications by id; `None` caches unknown and disabled ids too.
    registry: Cache<String, Option<Arc<ActivityApplication>>>,
}

impl AppState {
    pub fn new(db: Database, settings: &syrnike_config::Settings) -> Result<Self, String> {
        let template = OriginTemplate::parse(&settings.hosts.activities)?;

        let mut http = HttpConnector::new();
        http.enforce_http(false);
        http.set_connect_timeout(Some(CONNECT_TIMEOUT));
        let connector = HttpsConnectorBuilder::new()
            .with_provider_and_native_roots(Arc::new(rustls::crypto::ring::default_provider()))
            .map_err(|error| format!("cannot load TLS roots: {error}"))?
            .https_or_http()
            .enable_http1()
            .wrap_connector(http);
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(30))
            .build(connector.clone());

        Ok(Self(Arc::new(Inner {
            db,
            template,
            client_origins: settings.activities.client_origins.clone(),
            ask_delegate_suffix: settings.activities.ask_delegate_suffix.clone(),
            ask_delegate_url: settings.activities.ask_delegate_url.clone(),
            connector,
            client,
            registry: Cache::builder()
                .max_capacity(10_000)
                .time_to_live(REGISTRY_TTL)
                .build(),
        })))
    }

    /// Enabled application by id, cached for [`REGISTRY_TTL`].
    async fn application(&self, id: &str) -> Result<Option<Arc<ActivityApplication>>, ()> {
        let db = self.0.db.clone();
        let key = id.to_owned();
        self.0
            .registry
            .try_get_with(key.clone(), async move {
                match db.fetch_activity_application(&key).await {
                    Ok(app) => Ok(app.enabled.then(|| Arc::new(app))),
                    Err(error) if matches!(error.error_type, ErrorType::NotFound) => Ok(None),
                    Err(error) => Err(error),
                }
            })
            .await
            .map_err(|error| log::error!("registry lookup for {id} failed: {error}"))
    }
}

fn status(code: StatusCode) -> Response {
    (code, code.canonical_reason().unwrap_or_default()).into_response()
}

fn request_host(req: &Request) -> Option<String> {
    req.headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| req.uri().authority().map(|a| a.to_string()))
}

pub async fn handle(State(state): State<AppState>, req: Request) -> Response {
    let host = request_host(&req).unwrap_or_default();
    if let Some(id) = state.0.template.app_id(&host) {
        return proxy(&state, &id, req).await;
    }
    match (req.method(), req.uri().path()) {
        (&Method::GET, "/_health") => (StatusCode::OK, "ok").into_response(),
        (&Method::GET, "/_caddy/ask") => ask(&state, req.uri()).await,
        _ => status(StatusCode::NOT_FOUND),
    }
}

/// Caddy on-demand TLS check: 200 only for enabled registered applications.
async fn ask(state: &AppState, uri: &Uri) -> Response {
    let domain = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .find_map(|pair| pair.strip_prefix("domain="))
        .unwrap_or_default();

    let allowed = match rules::ask_route(domain, &state.0.template, &state.0.ask_delegate_suffix) {
        AskRoute::Registry(id) => matches!(state.application(&id).await, Ok(Some(_))),
        AskRoute::Delegate => ask_delegate(state, domain).await,
        AskRoute::Deny => false,
    };
    status(if allowed { StatusCode::OK } else { StatusCode::NOT_FOUND })
}

async fn ask_delegate(state: &AppState, domain: &str) -> bool {
    let Ok(uri) = format!("{}?domain={}", state.0.ask_delegate_url, domain.to_ascii_lowercase())
        .parse::<Uri>()
    else {
        log::error!("invalid ask_delegate_url: {}", state.0.ask_delegate_url);
        return false;
    };
    let Ok(request) = axum::http::Request::get(uri).body(Body::empty()) else {
        return false;
    };
    match tokio::time::timeout(ASK_TIMEOUT, state.0.client.request(request)).await {
        Ok(Ok(response)) => response.status() == StatusCode::OK,
        Ok(Err(error)) => {
            log::warn!("delegate ask for {domain} failed: {error}");
            false
        }
        Err(_) => {
            log::warn!("delegate ask for {domain} timed out");
            false
        }
    }
}

async fn proxy(state: &AppState, id: &str, req: Request) -> Response {
    let app = match state.application(id).await {
        Ok(Some(app)) => app,
        Ok(None) => return status(StatusCode::NOT_FOUND),
        Err(()) => return status(StatusCode::SERVICE_UNAVAILABLE),
    };

    let path = req.uri().path().to_owned();
    if rules::is_unsafe_path(&path) {
        return status(StatusCode::BAD_REQUEST);
    }
    let Some((base, tail)) = app.upstream_for_path(&path) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Some(upstream) = rules::upstream_uri(base, tail, req.uri().query()) else {
        log::error!("application {id} has an invalid upstream: {base}");
        return status(StatusCode::BAD_GATEWAY);
    };

    let csp = rules::content_security_policy(
        &state.0.client_origins,
        &state.0.template.websocket_origin(id),
    );
    let Ok(csp) = HeaderValue::try_from(csp) else {
        log::error!("activities.client_origins is not a valid header value");
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    };

    let upgrade = req.headers().contains_key(header::UPGRADE);
    let result = if upgrade {
        forward_upgrade(state, req, upstream, &csp).await
    } else {
        forward(state, req, upstream, &csp).await
    };
    result.unwrap_or_else(|error| {
        log::warn!("upstream request for {id} failed: {error}");
        status(StatusCode::BAD_GATEWAY)
    })
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

fn upstream_request(req: Request, upstream: &Uri, upgrade: bool, origin_form: bool) -> Result<Request, BoxError> {
    let (parts, body) = req.into_parts();
    let authority = upstream.authority().ok_or("upstream has no authority")?.as_str();
    let uri = if origin_form {
        Uri::from(upstream.path_and_query().ok_or("upstream has no path")?.clone())
    } else {
        upstream.clone()
    };
    let mut request = axum::http::Request::builder()
        .method(parts.method).uri(uri).body(body)?;
    *request.headers_mut() = rules::upstream_request_headers(&parts.headers, authority, upgrade);
    Ok(request)
}

async fn forward(state: &AppState, req: Request, upstream: Uri, csp: &HeaderValue) -> Result<Response, BoxError> {
    let request = upstream_request(req, &upstream, false, false)?;
    let response = state.0.client.request(request).await?;
    let (mut parts, body) = response.into_parts();
    parts.headers = rules::client_response_headers(&parts.headers, false, csp);
    Ok(Response::from_parts(parts, Body::new(body)))
}

/// Upgrades (WebSocket) use a dedicated upstream connection, then splice the
/// two upgraded streams together.
async fn forward_upgrade(
    state: &AppState,
    mut req: Request,
    upstream: Uri,
    csp: &HeaderValue,
) -> Result<Response, BoxError> {
    let client_upgrade = hyper::upgrade::on(&mut req);
    let io = state.0.connector.clone().oneshot(upstream.clone()).await?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(io).await?;
    tokio::spawn(async move {
        if let Err(error) = connection.with_upgrades().await {
            log::debug!("upstream upgrade connection closed: {error}");
        }
    });

    let request = upstream_request(req, &upstream, true, true)?;
    let mut response = sender.send_request(request).await?;
    let upgraded = response.status() == StatusCode::SWITCHING_PROTOCOLS;
    if upgraded {
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        tokio::spawn(async move {
            match tokio::try_join!(client_upgrade, upstream_upgrade) {
                Ok((client, upstream)) => {
                    let (mut client, mut upstream) = (TokioIo::new(client), TokioIo::new(upstream));
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                }
                Err(error) => log::debug!("upgrade failed: {error}"),
            }
        });
    }

    let (mut parts, body) = response.into_parts();
    parts.headers = rules::client_response_headers(&parts.headers, upgraded, csp);
    Ok(Response::from_parts(parts, Body::new(body)))
}
