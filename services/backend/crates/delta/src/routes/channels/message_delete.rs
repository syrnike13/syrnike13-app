use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, User,
};
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

/// # Delete Message
///
/// Delete a message you've sent or one you have permission to delete.
#[openapi(tag = "Messaging")]
#[delete("/<target>/messages/<msg>", rank = 2)]
pub async fn delete(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    msg: Reference<'_>,
) -> Result<EmptyResponse> {
    let message = msg.as_message_in_channel(db, target.id).await?;
    let channel = target.as_channel(db).await?;
    if channel.has_bot_recipient(db).await? {
        return Err(create_error!(NotFound));
    }

    let required_permission = if message.author == user.id {
        ChannelPermission::ViewChannel
    } else {
        ChannelPermission::ManageMessages
    };
    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    calculate_channel_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(required_permission)?;

    message.delete(db).await.map(|_| EmptyResponse)
}
