use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{grant_badge, publish_user_badges, BadgeAssignmentSource, Database, User};
use syrnike_models::v0;
use syrnike_result::Result;

use super::require_privileged;

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

    let badge = db.fetch_badge(&badge_id).await?;
    grant_badge(
        db,
        &user_id,
        badge,
        BadgeAssignmentSource::Manual,
        Some(user.id),
    )
    .await?;

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
    publish_user_badges(db, &user_id).await;

    Ok(Json(
        db.fetch_user_badges(&user_id)
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    ))
}
