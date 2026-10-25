//! Activity authorization (ADR-0011): the Activity Frame requests a
//! single-use code, the application backend exchanges it with its client
//! secret for an opaque access token.
//!
//! Redis keys:
//! - `activity:oauth:code:{code}` — grant JSON, 5 minutes, single use
//! - `activity:oauth:token:{sha256(token)}` — grant JSON, 7 days

use redis_kiss::{get_connection, redis::cmd, AsyncCommands};
use revolt_rocket_okapi::{
    r#gen::OpenApiGenerator,
    request::{OpenApiFromRequest, RequestHeaderInput},
};
use rocket::{
    http::Status,
    request::{FromRequest, Outcome},
    serde::json::Json,
    Request, State,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use syrnike_database::{
    activities::{available_application, participating_instance},
    Database, User,
};
use syrnike_models::v0;
use syrnike_result::{create_error, Result, ToSyrnikeError};

use super::{
    not_participant, read_leaderboard, read_player_data, require_scope_member,
    validate_application_id, write_player_data, write_score,
};

const CODE_TTL_SECONDS: usize = 5 * 60;
const TOKEN_TTL_SECONDS: usize = 7 * 24 * 60 * 60;

const TAKE_CODE: &str = r#"
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
"#;

/// What a code or access token grants.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
struct ActivityGrant {
    application_id: String,
    user_id: String,
    scopes: Vec<v0::ActivityOAuthScope>,
}

fn code_key(code: &str) -> String {
    format!("activity:oauth:code:{code}")
}

fn token_key(token: &str) -> String {
    format!("activity:oauth:token:{}", sha256_hex(token))
}

fn sha256_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn normalized_scopes(scopes: &[v0::ActivityOAuthScope]) -> Vec<v0::ActivityOAuthScope> {
    let mut normalized = Vec::new();
    for scope in [
        v0::ActivityOAuthScope::Identify,
        v0::ActivityOAuthScope::Storage,
    ] {
        if scopes.contains(&scope) {
            normalized.push(scope);
        }
    }
    normalized
}

async fn store_grant(key: String, grant: &ActivityGrant, ttl_seconds: usize) -> Result<()> {
    let raw = serde_json::to_string(grant).to_internal_error()?;
    get_connection()
        .await
        .map_err(|_| create_error!(InternalError))?
        .set_ex::<_, _, ()>(key, raw, ttl_seconds)
        .await
        .to_internal_error()
}

async fn take_code(code: &str) -> Result<Option<ActivityGrant>> {
    let mut connection = get_connection()
        .await
        .map_err(|_| create_error!(InternalError))?
        .into_inner();
    let raw: Option<String> = cmd("EVAL")
        .arg(TAKE_CODE)
        .arg(1)
        .arg(code_key(code))
        .query_async(&mut connection)
        .await
        .to_internal_error()?;
    raw.map(|raw| serde_json::from_str(&raw).to_internal_error())
        .transpose()
}

async fn resolve_token(db: &Database, token: &str) -> Result<Option<ActivityGrant>> {
    let raw: Option<String> = get_connection()
        .await
        .map_err(|_| create_error!(InternalError))?
        .get(token_key(token))
        .await
        .to_internal_error()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let grant: ActivityGrant = serde_json::from_str(&raw).to_internal_error()?;
    // Disabling or removing an application revokes its tokens.
    if available_application(db, &grant.application_id)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    Ok(Some(grant))
}

/// Access token presented by an application backend as `Authorization: Bearer`.
pub struct ActivityBearer(ActivityGrant);

impl ActivityBearer {
    fn require(&self, scope: v0::ActivityOAuthScope) -> Result<&ActivityGrant> {
        if self.0.scopes.contains(&scope) {
            Ok(&self.0)
        } else {
            Err(create_error!(MissingPermission {
                permission: match scope {
                    v0::ActivityOAuthScope::Identify => "identify",
                    v0::ActivityOAuthScope::Storage => "storage",
                }
                .to_string()
            }))
        }
    }
}

#[rocket::async_trait]
impl<'r> FromRequest<'r> for ActivityBearer {
    type Error = syrnike_result::Error;

    async fn from_request(request: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let Some(token) = request
            .headers()
            .get_one("Authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| !token.is_empty())
        else {
            return Outcome::Error((Status::Unauthorized, create_error!(NotAuthenticated)));
        };
        let db = request.rocket().state::<Database>().expect("`Database`");
        match resolve_token(db, token).await {
            Ok(Some(grant)) => Outcome::Success(ActivityBearer(grant)),
            Ok(None) => Outcome::Error((Status::Unauthorized, create_error!(InvalidSession))),
            Err(error) => Outcome::Error((Status::InternalServerError, error)),
        }
    }
}

impl<'r> OpenApiFromRequest<'r> for ActivityBearer {
    fn from_request_input(
        _gen: &mut OpenApiGenerator,
        _name: String,
        _required: bool,
    ) -> revolt_rocket_okapi::Result<RequestHeaderInput> {
        Ok(RequestHeaderInput::None)
    }
}

/// # Authorize Activity
///
/// Issue a single-use authorization code for the application backend. The
/// caller must participate in a running instance of the application.
#[openapi(tag = "Activities")]
#[post("/<application_id>/authorize", data = "<data>")]
pub async fn authorize(
    db: &State<Database>,
    user: User,
    application_id: String,
    data: Json<v0::DataActivityAuthorize>,
) -> Result<Json<v0::ActivityAuthorizationCode>> {
    validate_application_id(&application_id)?;
    let scopes = normalized_scopes(&data.scopes);
    if scopes.is_empty() {
        return Err(create_error!(FailedValidation {
            error: "at least one scope is required".to_string()
        }));
    }
    if available_application(db, &application_id).await?.is_none() {
        return Err(create_error!(NotFound));
    }
    if participating_instance(&user.id, &application_id)
        .await?
        .is_none()
    {
        return Err(not_participant());
    }

    let code = nanoid::nanoid!(48);
    store_grant(
        code_key(&code),
        &ActivityGrant {
            application_id,
            user_id: user.id,
            scopes,
        },
        CODE_TTL_SECONDS,
    )
    .await?;

    Ok(Json(v0::ActivityAuthorizationCode { code }))
}

/// # Exchange Activity Authorization Code
///
/// Exchange a code and the client secret for an access token.
#[openapi(tag = "Activities")]
#[post("/oauth/token", data = "<data>")]
pub async fn token(
    db: &State<Database>,
    data: Json<v0::DataActivityTokenExchange>,
) -> Result<Json<v0::ActivityAccessToken>> {
    let data = data.into_inner();
    let application = available_application(db, &data.client_id)
        .await?
        .ok_or_else(|| create_error!(InvalidCredentials))?;
    let Some(secret_hash) = application.client_secret_hash.as_deref() else {
        return Err(create_error!(InvalidCredentials));
    };
    if !constant_time_eq(
        sha256_hex(&data.client_secret).as_bytes(),
        secret_hash.as_bytes(),
    ) {
        return Err(create_error!(InvalidCredentials));
    }

    let grant = take_code(&data.code)
        .await?
        .filter(|grant| grant.application_id == application.id)
        .ok_or_else(|| create_error!(InvalidCredentials))?;

    let access_token = nanoid::nanoid!(64);
    store_grant(token_key(&access_token), &grant, TOKEN_TTL_SECONDS).await?;

    Ok(Json(v0::ActivityAccessToken {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: TOKEN_TTL_SECONDS as u64,
        scopes: grant.scopes,
    }))
}

/// # Fetch Activity User
///
/// Identity of the token's user (`identify` scope).
#[openapi(tag = "Activities")]
#[get("/oauth/@me")]
pub async fn identify(
    db: &State<Database>,
    bearer: ActivityBearer,
) -> Result<Json<v0::ActivityUserIdentity>> {
    let grant = bearer.require(v0::ActivityOAuthScope::Identify)?;
    let user = db.fetch_user(&grant.user_id).await?;
    Ok(Json(v0::ActivityUserIdentity {
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        display_name: user.display_name,
        avatar: user.avatar.map(Into::into),
    }))
}

/// # Fetch Player Data (application backend)
#[openapi(tag = "Activities")]
#[get("/oauth/scopes/<scope_id>/data")]
pub async fn fetch_data(
    db: &State<Database>,
    bearer: ActivityBearer,
    scope_id: String,
) -> Result<Json<v0::ActivityPlayerData>> {
    let grant = bearer.require(v0::ActivityOAuthScope::Storage)?;
    require_scope_member(db, &grant.user_id, &scope_id).await?;
    Ok(Json(
        read_player_data(db, &grant.application_id, &scope_id, &grant.user_id).await?,
    ))
}

/// # Save Player Data (application backend, trusted)
#[openapi(tag = "Activities")]
#[put("/oauth/scopes/<scope_id>/data", data = "<data>")]
pub async fn save_data(
    db: &State<Database>,
    bearer: ActivityBearer,
    scope_id: String,
    data: Json<v0::DataActivityPlayerData>,
) -> Result<Json<v0::ActivityPlayerData>> {
    let grant = bearer.require(v0::ActivityOAuthScope::Storage)?;
    require_scope_member(db, &grant.user_id, &scope_id).await?;
    Ok(Json(
        write_player_data(
            db,
            &grant.application_id,
            &scope_id,
            &grant.user_id,
            data.into_inner().data,
            true,
        )
        .await?,
    ))
}

/// # Submit Score (application backend, trusted)
#[openapi(tag = "Activities")]
#[put("/oauth/scopes/<scope_id>/scores/<key>", data = "<data>")]
pub async fn submit_score(
    db: &State<Database>,
    bearer: ActivityBearer,
    scope_id: String,
    key: String,
    data: Json<v0::DataActivityScore>,
) -> Result<Json<v0::ActivityScore>> {
    let grant = bearer.require(v0::ActivityOAuthScope::Storage)?;
    require_scope_member(db, &grant.user_id, &scope_id).await?;
    Ok(Json(
        write_score(
            db,
            &grant.application_id,
            &scope_id,
            &key,
            &grant.user_id,
            data.into_inner(),
            true,
        )
        .await?,
    ))
}

/// # Fetch Leaderboard (application backend)
#[openapi(tag = "Activities")]
#[get("/oauth/scopes/<scope_id>/leaderboards/<key>?<options..>")]
pub async fn fetch_leaderboard(
    db: &State<Database>,
    bearer: ActivityBearer,
    scope_id: String,
    key: String,
    options: v0::OptionsActivityLeaderboard,
) -> Result<Json<v0::ActivityLeaderboard>> {
    let grant = bearer.require(v0::ActivityOAuthScope::Storage)?;
    require_scope_member(db, &grant.user_id, &scope_id).await?;
    Ok(Json(
        read_leaderboard(
            db,
            &grant.application_id,
            &scope_id,
            &key,
            &grant.user_id,
            options,
        )
        .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_compare_in_constant_time() {
        let hash = sha256_hex("secret");
        assert!(constant_time_eq(
            sha256_hex("secret").as_bytes(),
            hash.as_bytes()
        ));
        assert!(!constant_time_eq(
            sha256_hex("other").as_bytes(),
            hash.as_bytes()
        ));
        assert!(!constant_time_eq(b"a", b"ab"));
    }

    #[test]
    fn scopes_are_deduplicated_in_canonical_order() {
        use v0::ActivityOAuthScope::*;
        assert_eq!(
            normalized_scopes(&[Storage, Identify, Storage]),
            vec![Identify, Storage]
        );
        assert!(normalized_scopes(&[]).is_empty());
    }

    #[test]
    fn token_keys_never_contain_the_token() {
        let key = token_key("plain-token");
        assert!(!key.contains("plain-token"));
        assert!(key.starts_with("activity:oauth:token:"));
    }
}
