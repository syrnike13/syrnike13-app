use syrnike_config::config;
use syrnike_database::{
    util::{permissions::perms, reference::Reference},
    voice::{
        desktop_native_voice_identity, get_channel_node, get_user_voice_channels,
        get_voice_channel_members, raise_if_in_voice, remove_user_from_voice_channel,
        set_call_notification_recipients, set_channel_node, set_user_voice_join_intent,
        UserVoiceChannel, VoiceClient,
    },
    Database, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

use rocket::{serde::json::Json, State};

/// # Join Call
///
/// Asks the voice server for a token to join the call.
#[openapi(tag = "Voice")]
#[post("/<target>/join_call", data = "<data>")]
pub async fn call(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
    data: Json<v0::DataJoinCall>,
) -> Result<Json<v0::CreateVoiceUserResponse>> {
    if !voice_client.is_enabled() {
        return Err(create_error!(LiveKitUnavailable));
    }

    let v0::DataJoinCall {
        node,
        force_disconnect,
        recipients,
    } = data.into_inner();

    let force_disconnect = should_disconnect_existing_voice_sessions(force_disconnect);

    if user.bot.is_some() && force_disconnect {
        return Err(create_error!(IsBot));
    }

    let channel = target.as_channel(db).await?;

    let Some(voice_info) = channel.voice() else {
        return Err(create_error!(NotAVoiceChannel));
    };

    let mut permissions = perms(db, &user).channel(&channel);

    let current_permissions = calculate_channel_permissions(&mut permissions).await;
    current_permissions.throw_if_lacking_channel_permission(ChannelPermission::Connect)?;

    let user_voice_channel = UserVoiceChannel::from_channel(&channel);

    let current_voice_members = get_voice_channel_members(&user_voice_channel).await?;
    if should_reject_voice_join_for_capacity(
        current_voice_members.as_deref(),
        voice_info.max_users,
        &user.id,
    ) && !current_permissions.has(ChannelPermission::ManageChannel as u64)
    {
        return Err(create_error!(CannotJoinCall));
    }

    let existing_node = get_channel_node(channel.id()).await?;
    let has_existing_node = existing_node.is_some(); // we move existing_node in the next statement so this is the quickest way to know if we need to set it.

    let node = existing_node
        .or(node)
        .ok_or_else(|| create_error!(UnknownNode))?;

    let config = config().await;

    let node_host = config
        .hosts
        .livekit
        .get(&node)
        .ok_or_else(|| create_error!(UnknownNode))?
        .clone();

    if user.bot.is_none() {
        set_user_voice_join_intent(&user.id, &user_voice_channel).await?;

        if force_disconnect {
            voice_client.remove_user_from_all_rooms(&user.id).await?;
        }

        // Keep the target Redis voice state intact for same-channel reconnects.
        if force_disconnect {
            for previous_channel in voice_channels_to_disconnect_on_join(
                get_user_voice_channels(&user.id).await?,
                &user_voice_channel,
            ) {
                remove_user_from_voice_channel(voice_client, &previous_channel, &user.id).await?;
            }
        }
    } else {
        raise_if_in_voice(&user, &user_voice_channel).await?;
    }

    let token = voice_client
        .create_token_for_identity(&node, db, &user, &user.id, current_permissions, &channel)
        .await?;
    let native_identity = desktop_native_voice_identity(&user.id);
    let native_token = voice_client
        .create_token_for_identity(
            &node,
            db,
            &user,
            &native_identity,
            current_permissions,
            &channel,
        )
        .await?;

    let room = voice_client.create_room(&node, &channel).await?;

    if !has_existing_node {
        set_channel_node(channel.id(), &node).await?;
    }

    log::debug!("Created room {}", room.name);

    if let Some(recipients) = recipients {
        if room.num_participants == 0 && !recipients.is_empty() {
            set_call_notification_recipients(channel.id(), &user.id, &recipients).await?;
        }
    }

    Ok(Json(v0::CreateVoiceUserResponse {
        token,
        native_token,
        native_identity,
        url: node_host.clone(),
    }))
}

fn should_reject_voice_join_for_capacity(
    members: Option<&[String]>,
    max_users: Option<usize>,
    user_id: &str,
) -> bool {
    members.zip(max_users).is_some_and(|(members, max_users)| {
        members.len() >= max_users && !members.iter().any(|member_id| member_id == user_id)
    })
}

fn voice_channels_to_disconnect_on_join(
    previous_channels: Vec<UserVoiceChannel>,
    target_channel: &UserVoiceChannel,
) -> Vec<UserVoiceChannel> {
    previous_channels
        .into_iter()
        .filter(|previous_channel| previous_channel != target_channel)
        .collect()
}

fn should_disconnect_existing_voice_sessions(force_disconnect: Option<bool>) -> bool {
    force_disconnect.unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use syrnike_database::voice::UserVoiceChannel;

    #[test]
    fn full_voice_channel_allows_existing_member_rejoin() {
        let members = vec!["user-a".to_string(), "user-b".to_string()];

        assert!(!super::should_reject_voice_join_for_capacity(
            Some(&members),
            Some(2),
            "user-a",
        ));
        assert!(super::should_reject_voice_join_for_capacity(
            Some(&members),
            Some(2),
            "user-c",
        ));
    }

    #[test]
    fn same_channel_rejoin_keeps_target_voice_state() {
        let target_channel = UserVoiceChannel {
            id: "voice-a".to_string(),
            server_id: Some("server-a".to_string()),
        };
        let other_channel = UserVoiceChannel {
            id: "voice-b".to_string(),
            server_id: Some("server-a".to_string()),
        };

        assert_eq!(
            super::voice_channels_to_disconnect_on_join(
                vec![target_channel.clone(), other_channel.clone()],
                &target_channel,
            ),
            vec![other_channel],
        );
    }

    #[test]
    fn native_token_refresh_does_not_disconnect_existing_livekit_session() {
        assert!(!super::should_disconnect_existing_voice_sessions(Some(false)));
        assert!(super::should_disconnect_existing_voice_sessions(Some(true)));
        assert!(super::should_disconnect_existing_voice_sessions(None));
    }
}
