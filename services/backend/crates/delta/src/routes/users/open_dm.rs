use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Channel, Database, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_user_permissions, UserPermission};
use syrnike_result::{create_error, Result};

/// # Open Direct Message
///
/// Open a DM with another user.
///
/// If the target is oneself, a saved messages channel is returned.
#[openapi(tag = "Direct Messaging")]
#[get("/<target>/dm")]
pub async fn open_dm(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
) -> Result<Json<v0::Channel>> {
    let target = target.as_user(db).await?;
    if user.bot.is_some() || target.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).user(&target);
    calculate_user_permissions(&mut query)
        .await
        .throw_if_lacking_user_permission(UserPermission::SendMessage)?;

    Channel::create_dm(db, &user, &target)
        .await
        .map(Into::into)
        .map(Json)
}
