use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{
        cancel_current_pending_voice_join_in_server, get_user_voice_channel_in_server,
        remove_user_from_voice_channel, UserVoiceChannel,
    },
    Database, RemovalIntention, User,
};
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

/// # Kick Member
///
/// Removes a member from the server.
#[openapi(tag = "Server Members")]
#[delete("/<server_id>/members/<member_id>")]
pub async fn kick(
    db: &State<Database>,
    user: User,
    server_id: Reference<'_>,
    member_id: Reference<'_>,
) -> Result<EmptyResponse> {
    let server = server_id.as_server(db).await?;

    if member_id.id == user.id {
        return Err(create_error!(CannotRemoveYourself));
    }

    if member_id.id == server.owner {
        return Err(create_error!(InvalidOperation));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::KickMembers)?;

    let member = member_id.as_member(db, &server.id).await?;
    if member.get_ranking(query.server_ref().as_ref().unwrap())
        <= query.get_member_rank().unwrap_or(i64::MIN)
    {
        return Err(create_error!(NotElevated));
    }

    member
        .remove(db, &server, RemovalIntention::Kick, false)
        .await?;

    cancel_current_pending_voice_join_in_server(member_id.id, &server.id).await?;
    if let Some(channel_id) = get_user_voice_channel_in_server(member_id.id, &server.id).await? {
        remove_user_from_voice_channel(
            &UserVoiceChannel {
                id: channel_id,
                server_id: Some(server.id.clone()),
            },
            member_id.id,
        )
        .await?;
    };

    Ok(EmptyResponse)
}
