use iso8601_timestamp::Timestamp;
use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{events::client::EventV1, Badge, Database, User, UserBadgeAssignment};
use syrnike_models::v0;
use syrnike_result::Result;

use super::require_privileged;

async fn publish_user_badge_update(db: &Database, user_id: &str) {
    let badges = db
        .fetch_user_badges(user_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(Badge::into_public_user_badge)
        .collect();

    EventV1::UserUpdate {
        id: user_id.to_string(),
        data: v0::PartialUser {
            badges: Some(badges),
            ..Default::default()
        },
        clear: vec![],
        event_id: None,
    }
    .p(user_id.to_string())
    .await;
}

#[openapi(tag = "Admin")]
#[get("/users/<user_id>/badges")]
pub async fn list(
    db: &State<Database>,
    user: User,
    user_id: String,
) -> Result<Json<Vec<v0::Badge>>> {
    require_privileged(&user)?;

    Ok(Json(
        db.fetch_user_badges(&user_id)
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    ))
}

#[openapi(tag = "Admin")]
#[put("/users/<user_id>/badges/<badge_id>")]
pub async fn assign(
    db: &State<Database>,
    user: User,
    user_id: String,
    badge_id: String,
) -> Result<Json<Vec<v0::Badge>>> {
    require_privileged(&user)?;

    db.assign_user_badge(&UserBadgeAssignment {
        user_id: user_id.clone(),
        badge_id,
        assigned_by: user.id,
        assigned_at: Timestamp::now_utc(),
    })
    .await?;
    publish_user_badge_update(db, &user_id).await;

    Ok(Json(
        db.fetch_user_badges(&user_id)
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    ))
}

#[openapi(tag = "Admin")]
#[delete("/users/<user_id>/badges/<badge_id>")]
pub async fn remove(
    db: &State<Database>,
    user: User,
    user_id: String,
    badge_id: String,
) -> Result<Json<Vec<v0::Badge>>> {
    require_privileged(&user)?;

    db.remove_user_badge(&user_id, &badge_id).await?;
    publish_user_badge_update(db, &user_id).await;

    Ok(Json(
        db.fetch_user_badges(&user_id)
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    ))
}
