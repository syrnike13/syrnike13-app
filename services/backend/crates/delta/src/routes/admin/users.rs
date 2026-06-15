use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{Database, User};
use syrnike_models::v0;
use syrnike_result::Result;

use super::require_privileged;

#[openapi(tag = "Admin")]
#[get("/users/<query>")]
pub async fn fetch(
    db: &State<Database>,
    user: User,
    query: String,
) -> Result<Json<v0::User>> {
    require_privileged(&user)?;

    let target = if let Some((username, discriminator)) = query.split_once('#') {
        db.fetch_user_by_username(username, discriminator).await?
    } else {
        db.fetch_user(&query).await?
    };

    Ok(Json(target.into_self_with_badges(db, false).await))
}
