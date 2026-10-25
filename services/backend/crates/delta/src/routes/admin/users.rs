use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{Database, User};
use syrnike_models::v0;
use syrnike_result::Result;

use super::require_privileged;

#[openapi(tag = "Admin")]
#[get("/users/<query>")]
pub async fn fetch(db: &State<Database>, user: User, query: String) -> Result<Json<v0::User>> {
    require_privileged(&user)?;

    // Look the user up by id, then by their unique username.
    let target = match db.fetch_user(&query).await {
        Ok(target) => target,
        Err(_) => db.fetch_user_by_username(&query).await?,
    };

    Ok(Json(target.into_self_with_badges(db, false).await))
}
