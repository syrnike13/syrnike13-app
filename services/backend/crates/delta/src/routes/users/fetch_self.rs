use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::{Database, User};
use syrnike_models::v0;
use syrnike_result::Result;

/// # Fetch Self
///
/// Retrieve your user information.
#[openapi(tag = "User Information")]
#[get("/@me")]
pub async fn fetch(db: &State<Database>, user: User) -> Result<Json<v0::User>> {
    Ok(Json(user.into_self_with_badges(db, false).await))
}
