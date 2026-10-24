//! Channel Activities REST API (ADR-0011).
//!
//! - `/activities/applications` — enabled applications for clients
//! - `/activities/<app>/...` — Activity Frame calls with the player's session;
//!   writes are untrusted
//! - `/activities/oauth/...` — application backends with an access token;
//!   writes are trusted

use revolt_okapi::openapi3::OpenApi;
use rocket::Route;
use serde_json::Value;
use syrnike_database::{
    activities::{logic::instance_scope, participating_instance},
    iso8601_timestamp::Timestamp,
    ActivityPlayerData, ActivityScore, Channel, Database,
};
use syrnike_models::v0;
use syrnike_result::{create_error, Result};

mod applications;
mod oauth;
mod storage;

/// Maximum serialized size of a player data document.
const MAX_PLAYER_DATA_BYTES: usize = 16 * 1024;
/// Maximum length of a scope id.
const MAX_SCOPE_ID_BYTES: usize = 128;
const DEFAULT_LEADERBOARD_LIMIT: i64 = 10;
const MAX_LEADERBOARD_LIMIT: i64 = 100;

pub fn routes() -> (Vec<Route>, OpenApi) {
    openapi_get_routes_spec![
        applications::list,
        storage::fetch_data,
        storage::save_data,
        storage::submit_score,
        storage::fetch_leaderboard,
        oauth::authorize,
        oauth::token,
        oauth::identify,
        oauth::fetch_data,
        oauth::save_data,
        oauth::submit_score,
        oauth::fetch_leaderboard,
    ]
}

fn failed_validation(error: &str) -> syrnike_result::Error {
    create_error!(FailedValidation {
        error: error.to_string()
    })
}

fn not_participant() -> syrnike_result::Error {
    create_error!(MissingPermission {
        permission: "ActivityParticipant".to_string()
    })
}

fn validate_application_id(application_id: &str) -> Result<()> {
    if v0::RE_ACTIVITY_APPLICATION_ID.is_match(application_id) {
        Ok(())
    } else {
        Err(create_error!(NotFound))
    }
}

fn validate_scope_id(scope_id: &str) -> Result<()> {
    if !scope_id.is_empty() && scope_id.len() <= MAX_SCOPE_ID_BYTES {
        Ok(())
    } else {
        Err(create_error!(NotFound))
    }
}

/// The user must participate in a running instance of `application_id`
/// whose storage scope is `scope_id`.
async fn require_participant_in_scope(
    user_id: &str,
    application_id: &str,
    scope_id: &str,
) -> Result<()> {
    match participating_instance(user_id, application_id).await? {
        Some(instance) if instance_scope(&instance) == scope_id => Ok(()),
        _ => Err(not_participant()),
    }
}

/// The user must be a member of the server, or a recipient of the DM or
/// group channel, named by `scope_id`.
async fn require_scope_member(db: &Database, user_id: &str, scope_id: &str) -> Result<()> {
    validate_scope_id(scope_id)?;
    if db.fetch_member(scope_id, user_id).await.is_ok() {
        return Ok(());
    }
    match db.fetch_channel(scope_id).await {
        Ok(Channel::DirectMessage { recipients, .. } | Channel::Group { recipients, .. })
            if recipients.iter().any(|recipient| recipient == user_id) =>
        {
            Ok(())
        }
        _ => Err(create_error!(NotFound)),
    }
}

async fn read_player_data(
    db: &Database,
    application_id: &str,
    scope_id: &str,
    user_id: &str,
) -> Result<v0::ActivityPlayerData> {
    Ok(
        match db
            .fetch_activity_player_data(application_id, scope_id, user_id)
            .await?
        {
            Some(stored) => v0::ActivityPlayerData {
                data: serde_json::from_str(&stored.data)
                    .map_err(|_| create_error!(InternalError))?,
                trusted: stored.trusted,
                updated_at: Some(stored.updated_at),
            },
            None => v0::ActivityPlayerData {
                data: Value::Object(Default::default()),
                trusted: false,
                updated_at: None,
            },
        },
    )
}

async fn write_player_data(
    db: &Database,
    application_id: &str,
    scope_id: &str,
    user_id: &str,
    data: Value,
    trusted: bool,
) -> Result<v0::ActivityPlayerData> {
    if !data.is_object() {
        return Err(failed_validation("player data must be a JSON object"));
    }
    let raw = serde_json::to_string(&data).map_err(|_| create_error!(InternalError))?;
    if raw.len() > MAX_PLAYER_DATA_BYTES {
        return Err(create_error!(PayloadTooLarge));
    }

    let updated_at = Timestamp::now_utc();
    db.save_activity_player_data(&ActivityPlayerData {
        application_id: application_id.to_string(),
        scope_id: scope_id.to_string(),
        user_id: user_id.to_string(),
        data: raw,
        trusted,
        updated_at,
    })
    .await?;

    Ok(v0::ActivityPlayerData {
        data,
        trusted,
        updated_at: Some(updated_at),
    })
}

fn score_to_v0(score: ActivityScore) -> v0::ActivityScore {
    v0::ActivityScore {
        user_id: score.user_id,
        value: score.value,
        trusted: score.trusted,
        updated_at: score.updated_at,
    }
}

fn validate_score_key(key: &str) -> Result<()> {
    if v0::RE_ACTIVITY_SCORE_KEY.is_match(key) {
        Ok(())
    } else {
        Err(failed_validation("invalid score key"))
    }
}

async fn write_score(
    db: &Database,
    application_id: &str,
    scope_id: &str,
    key: &str,
    user_id: &str,
    data: v0::DataActivityScore,
    trusted: bool,
) -> Result<v0::ActivityScore> {
    validate_score_key(key)?;
    let score = ActivityScore {
        application_id: application_id.to_string(),
        scope_id: scope_id.to_string(),
        key: key.to_string(),
        user_id: user_id.to_string(),
        value: data.value,
        trusted,
        updated_at: Timestamp::now_utc(),
    };
    Ok(score_to_v0(
        db.submit_activity_score(&score, data.mode).await?,
    ))
}

async fn read_leaderboard(
    db: &Database,
    application_id: &str,
    scope_id: &str,
    key: &str,
    user_id: &str,
    options: v0::OptionsActivityLeaderboard,
) -> Result<v0::ActivityLeaderboard> {
    validate_score_key(key)?;
    let limit = options.limit.unwrap_or(DEFAULT_LEADERBOARD_LIMIT);
    if !(1..=MAX_LEADERBOARD_LIMIT).contains(&limit) {
        return Err(failed_validation("limit must be between 1 and 100"));
    }
    let entries = db
        .fetch_activity_leaderboard(
            application_id,
            scope_id,
            key,
            limit,
            options.ascending.unwrap_or(false),
        )
        .await?;
    let own = db
        .fetch_activity_score(application_id, scope_id, key, user_id)
        .await?;

    Ok(v0::ActivityLeaderboard {
        key: key.to_string(),
        entries: entries.into_iter().map(score_to_v0).collect(),
        own: own.map(score_to_v0),
    })
}

#[cfg(test)]
mod tests {
    #[rocket::async_test]
    async fn routes_do_not_collide() {
        let (routes, _) = super::routes();
        rocket::build()
            .mount("/activities", routes)
            .ignite()
            .await
            .expect("activity routes must not collide");
    }
}
