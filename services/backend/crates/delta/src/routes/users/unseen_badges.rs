use rocket::serde::json::Json;
use rocket::State;
use serde::{Deserialize, Serialize};
use syrnike_database::{Badge, Database, User};
use syrnike_models::v0;
use syrnike_result::{create_error, Result};
use validator::Validate;

/// # Seen Badges
#[derive(Validate, Serialize, Deserialize, JsonSchema)]
pub struct DataAcknowledgeBadges {
    /// Badge ids whose unlock notification was shown
    #[validate(length(min = 1, max = 100))]
    badges: Vec<String>,
}

/// # Fetch Unseen Badges
///
/// Retrieve badges whose unlock notification has not been shown yet.
#[openapi(tag = "User Information")]
#[get("/@me/badges/unseen")]
pub async fn fetch(db: &State<Database>, user: User) -> Result<Json<Vec<v0::UserBadge>>> {
    Ok(Json(
        db.fetch_unseen_user_badges(&user.id)
            .await?
            .into_iter()
            .filter_map(Badge::into_public_user_badge)
            .collect(),
    ))
}

/// # Acknowledge Badges
///
/// Mark badge unlock notifications as shown.
#[openapi(tag = "User Information")]
#[put("/@me/badges/seen", data = "<data>")]
pub async fn acknowledge(
    db: &State<Database>,
    user: User,
    data: Json<DataAcknowledgeBadges>,
) -> Result<()> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    db.mark_user_badges_seen(&user.id, &data.badges).await
}
