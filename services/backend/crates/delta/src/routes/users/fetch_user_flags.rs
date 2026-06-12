use rocket::{serde::json::Json, State};
use syrnike_database::{util::reference::Reference, Database};
use syrnike_models::v0;
use syrnike_result::Result;

/// # Fetch User Flags
///
/// Retrieve a user's flags.
#[openapi(tag = "User Information")]
#[get("/<target>/flags")]
pub async fn fetch_user_flags(
    db: &State<Database>,
    target: Reference<'_>,
) -> Result<Json<v0::FlagResponse>> {
    let flags = if let Ok(target) = target.as_user(db).await {
        target.flags.unwrap_or_default()
    } else {
        0
    };

    Ok(Json(v0::FlagResponse { flags }))
}
