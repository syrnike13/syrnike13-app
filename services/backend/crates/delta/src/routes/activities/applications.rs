use rocket::{serde::json::Json, State};
use syrnike_database::{Database, User};
use syrnike_models::v0;
use syrnike_result::Result;

/// # List Activity Applications
///
/// Enabled applications with the Activity Origin to load.
#[openapi(tag = "Activities")]
#[get("/applications")]
pub async fn list(db: &State<Database>, _user: User) -> Result<Json<Vec<v0::ActivityApplication>>> {
    let template = syrnike_config::config().await.hosts.activities;
    let mut applications = db
        .fetch_activity_applications()
        .await?
        .into_iter()
        .filter(|application| application.enabled)
        .collect::<Vec<_>>();
    applications.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(
        applications
            .into_iter()
            .map(|application| application.into_v0(&template))
            .collect(),
    ))
}
