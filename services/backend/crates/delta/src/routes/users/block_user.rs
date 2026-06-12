use rocket::serde::json::Json;
use rocket::State;
use syrnike_database::util::reference::Reference;
use syrnike_database::{Database, User};
use syrnike_models::v0;
use syrnike_result::Result;

/// # Block User
///
/// Block another user by their id.
#[openapi(tag = "Relationships")]
#[put("/<target>/block")]
pub async fn block(
    db: &State<Database>,
    mut user: User,
    target: Reference<'_>,
) -> Result<Json<v0::User>> {
    let mut target = target.as_user(db).await?;

    user.block_user(db, &mut target).await?;
    Ok(Json(target.into(db, &user).await))
}
