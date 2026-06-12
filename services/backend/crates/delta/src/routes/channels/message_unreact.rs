use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

/// # Remove Reaction(s) to Message
///
/// Remove your own, someone else's or all of a given reaction.
///
/// Requires `ManageMessages` if changing others' reactions.
#[openapi(tag = "Interactions")]
#[delete("/<target>/messages/<msg>/reactions/<emoji>?<options..>")]
pub async fn unreact_message(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    msg: Reference<'_>,
    emoji: Reference<'_>,
    options: v0::OptionsUnreact,
) -> Result<EmptyResponse> {
    let channel = target.as_channel(db).await?;
    if channel.has_bot_recipient(db).await? {
        return Err(create_error!(NotFound));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    let permissions = calculate_channel_permissions(&mut query).await;

    permissions.throw_if_lacking_channel_permission(ChannelPermission::React)?;

    // Check if we need to escalate permissions
    let remove_all = options.remove_all.unwrap_or_default();
    if options.user_id.is_some() || remove_all {
        permissions.throw_if_lacking_channel_permission(ChannelPermission::ManageMessages)?;
    }

    // Fetch relevant message
    let message = msg.as_message_in_channel(db, channel.id()).await?;

    // Check if we should wipe all of this reaction
    if remove_all {
        return message
            .clear_reaction(db, emoji.id)
            .await
            .map(|_| EmptyResponse);
    }

    // Remove the reaction
    message
        .remove_reaction(db, options.user_id.as_ref().unwrap_or(&user.id), emoji.id)
        .await
        .map(|_| EmptyResponse)
}
