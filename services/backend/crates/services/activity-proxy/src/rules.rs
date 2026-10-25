//! Pure request rules of the activity proxy: Activity Origin hosts, upstream
//! URLs, header filtering and the on-demand TLS ask decision.

use axum::http::{
    header::{self, HeaderMap, HeaderName, HeaderValue},
    uri::{PathAndQuery, Scheme},
    Uri,
};

/// Activity Origin template (`hosts.activities`), e.g.
/// `https://{id}.activities.syrnike13.ru`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OriginTemplate {
    secure: bool,
    /// Lowercase part after `{id}`, including any port: `.activities.localhost:14707`.
    suffix: String,
}

impl OriginTemplate {
    pub fn parse(template: &str) -> Result<Self, String> {
        let (scheme, rest) = template
            .split_once("://")
            .ok_or_else(|| format!("activity origin template has no scheme: {template}"))?;
        let secure = match scheme {
            "https" => true,
            "http" => false,
            _ => return Err(format!("unsupported activity origin scheme: {scheme}")),
        };
        let suffix = rest
            .strip_prefix("{id}")
            .ok_or_else(|| format!("activity origin template must start with {{id}}: {template}"))?
            .trim_end_matches('/')
            .to_ascii_lowercase();
        if !suffix.starts_with('.') || suffix.len() < 2 || suffix.contains(['/', '{', '}']) {
            return Err(format!("invalid activity origin suffix: {template}"));
        }
        Ok(Self { secure, suffix })
    }

    /// Application id for a request `Host` (host and port must match the template).
    pub fn app_id(&self, host: &str) -> Option<String> {
        let host = host.to_ascii_lowercase();
        let id = host.strip_suffix(&self.suffix)?;
        is_app_id(id).then(|| id.to_owned())
    }

    /// Application id for a bare domain name (no port), as Caddy asks about it.
    pub fn app_id_for_domain(&self, domain: &str) -> Option<String> {
        let domain = domain.to_ascii_lowercase();
        let id = domain.strip_suffix(self.suffix_host())?;
        is_app_id(id).then(|| id.to_owned())
    }

    fn suffix_host(&self) -> &str {
        match self.suffix.rsplit_once(':') {
            Some((host, port)) if port.bytes().all(|b| b.is_ascii_digit()) => host,
            _ => &self.suffix,
        }
    }

    /// WebSocket origin of an application, listed explicitly in `connect-src`.
    pub fn websocket_origin(&self, id: &str) -> String {
        let scheme = if self.secure { "wss" } else { "ws" };
        format!("{scheme}://{id}{}", self.suffix)
    }
}

/// Application ids are DNS labels: `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`.
pub fn is_app_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let edge = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (1..=32).contains(&bytes.len())
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|b| edge(b) || *b == b'-')
}

/// Whether a request path could leave its upstream base path once decoded
/// (`.`/`..` segments, also percent-encoded, or backslashes).
pub fn is_unsafe_path(path: &str) -> bool {
    let decoded = percent_decode(path);
    decoded.contains(&b'\\')
        || decoded
            .split(|b| *b == b'/')
            .any(|segment| segment == b"." || segment == b"..")
}

fn percent_decode(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// Joins an upstream base URL (which may carry a path) with the remaining
/// request path and query. `tail` always starts with `/`.
pub fn upstream_uri(base: &str, tail: &str, query: Option<&str>) -> Option<Uri> {
    let base: Uri = base.parse().ok()?;
    let scheme = base.scheme()?;
    if *scheme != Scheme::HTTP && *scheme != Scheme::HTTPS {
        return None;
    }
    let authority = base.authority()?.clone();
    let mut path = format!("{}{tail}", base.path().trim_end_matches('/'));
    if let Some(query) = query {
        path.push('?');
        path.push_str(query);
    }
    Uri::builder()
        .scheme(scheme.clone())
        .authority(authority)
        .path_and_query(PathAndQuery::try_from(path).ok()?)
        .build()
        .ok()
}

const HOP_BY_HOP: [HeaderName; 8] = [
    header::CONNECTION,
    HeaderName::from_static("keep-alive"),
    header::PROXY_AUTHENTICATE,
    header::PROXY_AUTHORIZATION,
    header::TE,
    header::TRAILER,
    header::TRANSFER_ENCODING,
    header::UPGRADE,
];

/// Headers that reveal the client address; never sent upstream.
const CLIENT_ADDRESS: [&str; 6] = [
    "forwarded",
    "x-real-ip",
    "x-client-ip",
    "true-client-ip",
    "cf-connecting-ip",
    "x-cluster-client-ip",
];

fn strip_hop_by_hop(headers: &mut HeaderMap) -> Option<HeaderValue> {
    // `Connection: Upgrade` lists `Upgrade` itself, so read it first.
    let upgrade = headers.get(header::UPGRADE).cloned();
    let listed: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::try_from(name.trim()).ok())
        .collect();
    for name in listed {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
    upgrade
}

fn keep_upgrade(headers: &mut HeaderMap, upgrade: Option<HeaderValue>) {
    if let Some(upgrade) = upgrade {
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(header::UPGRADE, upgrade);
    }
}

/// Request headers sent upstream: no hop-by-hop or client address headers,
/// `Host` set to the upstream authority. The `Upgrade` handshake survives when
/// `upgrade` is set.
pub fn upstream_request_headers(headers: &HeaderMap, host: &str, upgrade: bool) -> HeaderMap {
    let mut headers = headers.clone();
    let upgrade_value = strip_hop_by_hop(&mut headers);
    let forwarded: Vec<HeaderName> = headers
        .keys()
        .filter(|name| {
            name.as_str().starts_with("x-forwarded-") || CLIENT_ADDRESS.contains(&name.as_str())
        })
        .cloned()
        .collect();
    for name in forwarded {
        headers.remove(name);
    }
    if let Ok(host) = HeaderValue::try_from(host) {
        headers.insert(header::HOST, host);
    }
    keep_upgrade(&mut headers, upgrade_value.filter(|_| upgrade));
    headers
}

/// Response headers sent to the client: no hop-by-hop headers (except a
/// completed upgrade), no `X-Frame-Options`, and our CSP added next to the
/// application's own.
pub fn client_response_headers(headers: &HeaderMap, upgraded: bool, csp: &HeaderValue) -> HeaderMap {
    let mut headers = headers.clone();
    let upgrade_value = strip_hop_by_hop(&mut headers);
    headers.remove(header::X_FRAME_OPTIONS);
    headers.append(header::CONTENT_SECURITY_POLICY, csp.clone());
    keep_upgrade(&mut headers, upgrade_value.filter(|_| upgraded));
    headers
}

/// Policy added on top of the application's own: only syrnike13 clients may
/// frame the Activity Origin, and it may only connect to itself.
pub fn content_security_policy(client_origins: &str, websocket_origin: &str) -> String {
    let ancestors = client_origins.split_whitespace().collect::<Vec<_>>().join(" ");
    let ancestors = if ancestors.is_empty() { "'none'".to_owned() } else { ancestors };
    format!("frame-ancestors {ancestors}; connect-src 'self' {websocket_origin}")
}

/// Who answers Caddy's on-demand TLS question for a domain.
#[derive(Debug, PartialEq, Eq)]
pub enum AskRoute {
    /// An application id under this proxy's Activity Origins.
    Registry(String),
    /// A host under the delegate suffix; the delegate proxy decides.
    Delegate,
    Deny,
}

pub fn ask_route(domain: &str, template: &OriginTemplate, delegate_suffix: &str) -> AskRoute {
    let domain = domain.to_ascii_lowercase();
    if !domain
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
    {
        return AskRoute::Deny;
    }
    if let Some(id) = template.app_id_for_domain(&domain) {
        return AskRoute::Registry(id);
    }
    let delegate_suffix = delegate_suffix.to_ascii_lowercase();
    match domain.strip_suffix(&delegate_suffix) {
        Some(label) if delegate_suffix.starts_with('.') && is_app_id(label) => AskRoute::Delegate,
        _ => AskRoute::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prod() -> OriginTemplate {
        OriginTemplate::parse("https://{id}.activities.syrnike13.ru").unwrap()
    }

    fn local() -> OriginTemplate {
        OriginTemplate::parse("http://{id}.activities.localhost:14707").unwrap()
    }

    #[test]
    fn template_rejects_invalid() {
        assert!(OriginTemplate::parse("activities.syrnike13.ru").is_err());
        assert!(OriginTemplate::parse("ftp://{id}.x.ru").is_err());
        assert!(OriginTemplate::parse("https://x.{id}.ru").is_err());
        assert!(OriginTemplate::parse("https://{id}").is_err());
        assert!(OriginTemplate::parse("https://{id}-x.ru").is_err());
    }

    #[test]
    fn host_parsing() {
        assert_eq!(prod().app_id("lab.activities.syrnike13.ru"), Some("lab".into()));
        assert_eq!(prod().app_id("LAB.Activities.Syrnike13.ru"), Some("lab".into()));
        assert_eq!(prod().app_id("lab.activities.syrnike13.ru:443"), None);
        assert_eq!(prod().app_id("a.b.activities.syrnike13.ru"), None);
        assert_eq!(prod().app_id("activities.syrnike13.ru"), None);
        assert_eq!(prod().app_id(".activities.syrnike13.ru"), None);
        assert_eq!(prod().app_id("-x.activities.syrnike13.ru"), None);
        assert_eq!(prod().app_id("lab.activities.beta.syrnike13.ru"), None);
        assert_eq!(local().app_id("lab.activities.localhost:14707"), Some("lab".into()));
        assert_eq!(local().app_id("lab.activities.localhost"), None);
        assert_eq!(local().app_id("lab.activities.localhost:1470"), None);
    }

    #[test]
    fn app_id_rules() {
        assert!(is_app_id("a"));
        assert!(is_app_id("lab-2"));
        assert!(is_app_id(&"a".repeat(32)));
        assert!(!is_app_id(&"a".repeat(33)));
        assert!(!is_app_id("lab-"));
        assert!(!is_app_id("Lab"));
        assert!(!is_app_id("la_b"));
        assert!(!is_app_id(""));
    }

    #[test]
    fn unsafe_paths() {
        assert!(!is_unsafe_path("/"));
        assert!(!is_unsafe_path("/assets/index-abc.js"));
        assert!(!is_unsafe_path("/.proxy/api/v1"));
        assert!(!is_unsafe_path("/a..b/c"));
        assert!(is_unsafe_path("/../secret"));
        assert!(is_unsafe_path("/.proxy/api/../../x"));
        assert!(is_unsafe_path("/%2e%2E/x"));
        assert!(is_unsafe_path("/.%2e/x"));
        assert!(is_unsafe_path("/a/..%2fx"));
        assert!(is_unsafe_path("/a%5c..%5cx"));
        assert!(is_unsafe_path("/./x"));
        assert!(!is_unsafe_path("/x%2"));
    }

    #[test]
    fn url_joining() {
        let join = |base, tail, query| upstream_uri(base, tail, query).map(|u| u.to_string());
        assert_eq!(
            join("http://web:5000/_activities/lab", "/", None).as_deref(),
            Some("http://web:5000/_activities/lab/")
        );
        assert_eq!(
            join("http://web:5000/_activities/lab/", "/assets/a.js", Some("v=1")).as_deref(),
            Some("http://web:5000/_activities/lab/assets/a.js?v=1")
        );
        assert_eq!(
            join("https://lab.example.com", "/v1/score", None).as_deref(),
            Some("https://lab.example.com/v1/score")
        );
        assert_eq!(
            join("https://lab.example.com/", "/", Some("a=b&c")).as_deref(),
            Some("https://lab.example.com/?a=b&c")
        );
        assert_eq!(join("ftp://lab.example.com", "/", None), None);
        assert_eq!(join("/relative", "/", None), None);
    }

    #[test]
    fn request_header_filtering() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("host", "lab.activities.syrnike13.ru"),
            ("connection", "keep-alive, x-secret"),
            ("x-secret", "1"),
            ("keep-alive", "timeout=5"),
            ("x-forwarded-for", "203.0.113.7"),
            ("x-forwarded-proto", "https"),
            ("x-real-ip", "203.0.113.7"),
            ("forwarded", "for=203.0.113.7"),
            ("accept", "text/html"),
            ("cookie", "app=1"),
        ] {
            headers.append(name, HeaderValue::from_static(value));
        }
        let out = upstream_request_headers(&headers, "web:5000", false);
        let names: Vec<_> = out.keys().map(|k| k.as_str()).collect();
        assert_eq!(out.get("host").unwrap(), "web:5000");
        assert_eq!(out.get("accept").unwrap(), "text/html");
        assert_eq!(out.get("cookie").unwrap(), "app=1");
        for removed in [
            "connection",
            "x-secret",
            "keep-alive",
            "x-forwarded-for",
            "x-forwarded-proto",
            "x-real-ip",
            "forwarded",
        ] {
            assert!(!names.contains(&removed), "{removed} was forwarded");
        }
    }

    #[test]
    fn request_upgrade_survives() {
        let mut headers = HeaderMap::new();
        headers.insert("connection", HeaderValue::from_static("Upgrade"));
        headers.insert("upgrade", HeaderValue::from_static("websocket"));
        headers.insert("sec-websocket-key", HeaderValue::from_static("abc"));
        let out = upstream_request_headers(&headers, "web:5000", true);
        assert_eq!(out.get("connection").unwrap(), "upgrade");
        assert_eq!(out.get("upgrade").unwrap(), "websocket");
        assert_eq!(out.get("sec-websocket-key").unwrap(), "abc");
        let out = upstream_request_headers(&headers, "web:5000", false);
        assert!(out.get("upgrade").is_none());
    }

    #[test]
    fn response_header_filtering() {
        let mut headers = HeaderMap::new();
        headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
        headers.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'self'"),
        );
        let csp = HeaderValue::from_static("frame-ancestors https://app.syrnike13.ru");
        let out = client_response_headers(&headers, false, &csp);
        assert!(out.get("x-frame-options").is_none());
        assert!(out.get("transfer-encoding").is_none());
        let policies: Vec<_> = out.get_all("content-security-policy").iter().collect();
        assert_eq!(policies.len(), 2);
        assert_eq!(policies[1], &csp);
    }

    #[test]
    fn csp_value() {
        assert_eq!(
            content_security_policy(
                " https://app.syrnike13.ru  http://localhost:3001 ",
                &prod().websocket_origin("lab")
            ),
            "frame-ancestors https://app.syrnike13.ru http://localhost:3001; \
             connect-src 'self' wss://lab.activities.syrnike13.ru"
        );
        assert_eq!(
            content_security_policy("", &local().websocket_origin("lab")),
            "frame-ancestors 'none'; connect-src 'self' ws://lab.activities.localhost:14707"
        );
    }

    #[test]
    fn ask_decision() {
        let beta = ".activities.beta.syrnike13.ru";
        assert_eq!(
            ask_route("lab.activities.syrnike13.ru", &prod(), beta),
            AskRoute::Registry("lab".into())
        );
        assert_eq!(
            ask_route("lab.activities.beta.syrnike13.ru", &prod(), beta),
            AskRoute::Delegate
        );
        assert_eq!(ask_route("lab.activities.beta.syrnike13.ru", &prod(), ""), AskRoute::Deny);
        assert_eq!(ask_route("a.b.activities.beta.syrnike13.ru", &prod(), beta), AskRoute::Deny);
        assert_eq!(ask_route("syrnike13.ru", &prod(), beta), AskRoute::Deny);
        assert_eq!(ask_route("evil.example.com", &prod(), beta), AskRoute::Deny);
        assert_eq!(ask_route("lab.activities.syrnike13.ru/x", &prod(), beta), AskRoute::Deny);
        assert_eq!(
            ask_route("lab.activities.localhost", &local(), ""),
            AskRoute::Registry("lab".into())
        );
    }
}
