//! Player data and scores through the Activity Frame (player session,
//! untrusted writes).

use rocket::{serde::json::Json, State};
use syrnike_database::{Database, User};
use syrnike_models::v0;
use syrnike_result::Result;

use super::{
    read_leaderboard, read_player_data, require_participant_in_scope, require_scope_member,
    validate_application_id, write_player_data, write_score,
};

/// # Fetch Player Data
///
/// The caller's own data; requires participating in a running instance of
/// the application in this scope.
#[openapi(tag = "Activities")]
#[get("/<application_id>/scopes/<scope_id>/data", rank = 2)]
pub async fn fetch_data(
    db: &State<Database>,
    user: User,
    application_id: String,
    scope_id: String,
) -> Result<Json<v0::ActivityPlayerData>> {
    require_participant_in_scope(&user.id, &application_id, &scope_id).await?;
    Ok(Json(
        read_player_data(db, &application_id, &scope_id, &user.id).await?,
    ))
}

/// # Save Player Data
///
/// Replace the caller's own data (untrusted).
#[openapi(tag = "Activities")]
#[put("/<application_id>/scopes/<scope_id>/data", data = "<data>", rank = 2)]
pub async fn save_data(
    db: &State<Database>,
    user: User,
    application_id: String,
    scope_id: String,
    data: Json<v0::DataActivityPlayerData>,
) -> Result<Json<v0::ActivityPlayerData>> {
    require_participant_in_scope(&user.id, &application_id, &scope_id).await?;
    Ok(Json(
        write_player_data(
            db,
            &application_id,
            &scope_id,
            &user.id,
            data.into_inner().data,
            false,
        )
        .await?,
    ))
}

/// # Submit Score
///
/// Submit the caller's own score (untrusted).
#[openapi(tag = "Activities")]
#[put(
    "/<application_id>/scopes/<scope_id>/scores/<key>",
    data = "<data>",
    rank = 2
)]
pub async fn submit_score(
    db: &State<Database>,
    user: User,
    application_id: String,
    scope_id: String,
    key: String,
    data: Json<v0::DataActivityScore>,
) -> Result<Json<v0::ActivityScore>> {
    require_participant_in_scope(&user.id, &application_id, &scope_id).await?;
    Ok(Json(
        write_score(
            db,
            &application_id,
            &scope_id,
            &key,
            &user.id,
            data.into_inner(),
            false,
        )
        .await?,
    ))
}

/// # Fetch Leaderboard
///
/// Requires membership in the server, DM or group named by the scope.
#[openapi(tag = "Activities")]
#[get(
    "/<application_id>/scopes/<scope_id>/leaderboards/<key>?<options..>",
    rank = 2
)]
pub async fn fetch_leaderboard(
    db: &State<Database>,
    user: User,
    application_id: String,
    scope_id: String,
    key: String,
    options: v0::OptionsActivityLeaderboard,
) -> Result<Json<v0::ActivityLeaderboard>> {
    validate_application_id(&application_id)?;
    require_scope_member(db, &user.id, &scope_id).await?;
    Ok(Json(
        read_leaderboard(db, &application_id, &scope_id, &key, &user.id, options).await?,
    ))
}
