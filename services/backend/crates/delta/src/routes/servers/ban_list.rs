use futures::future::join_all;
use syrnike_database::util::permissions::DatabasePermissionQuery;
use syrnike_database::util::reference::Reference;
use syrnike_database::{Database, User};
use syrnike_models::v0;

use rocket::serde::json::Json;
use rocket::State;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::Result;

/// # Fetch Bans
///
/// Fetch all bans on a server.
#[openapi(tag = "Server Members")]
#[get("/<target>/bans")]
pub async fn list(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
) -> Result<Json<v0::BanListResult>> {
    let server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::BanMembers)?;

    let bans = db.fetch_bans(&server.id).await?;
    let users = join_all(
        db.fetch_users(
            &bans
                .iter()
                .map(|x| &x.id.user)
                .cloned()
                .collect::<Vec<String>>(),
        )
        .await?
        .into_iter()
        .map(|u| u.into_self_with_badges(db, false)),
    )
    .await;

    Ok(Json(v0::BanListResult {
        users: users.into_iter().map(Into::into).collect(),
        bans: bans.into_iter().map(Into::into).collect(),
    }))
}
