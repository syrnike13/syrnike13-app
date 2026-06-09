use crate::{
    models::Channel,
    util::{permissions::perms, reference::Reference},
    voice::{
        desktop_native_voice_identity, get_channel_node, get_user_voice_channels,
        get_voice_channel_members, raise_if_in_voice, remove_user_from_voice_channel,
        set_call_notification_recipients, set_channel_node, set_user_voice_join_intent,
        UserVoiceChannel, VoiceClient,
    },
    Database, User,
};
use syrnike_config::config;
use syrnike_models::v0::{self, NativeVoiceCredentials};
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission, PermissionValue};
use syrnike_result::{create_error, Result};

/// LiveKit credentials returned to the client after a successful voice join request.
#[derive(Debug, Clone)]
pub struct VoiceJoinCredentials {
    pub channel_id: String,
    pub node: String,
    pub url: String,
    pub token: String,
    pub native_microphone: NativeVoiceCredentials,
    pub native_screen: NativeVoiceCredentials,
    pub native_camera: NativeVoiceCredentials,
}

/// Options for joining a voice channel through the gateway.
#[derive(Debug, Clone, Default)]
pub struct VoiceJoinOptions {
    pub node: Option<String>,
    pub force_disconnect: Option<bool>,
    pub recipients: Option<Vec<String>>,
    pub self_mute: bool,
    pub self_deaf: bool,
}

pub async fn join_voice_channel(
    db: &Database,
    voice_client: &VoiceClient,
    user: &User,
    channel_id: &str,
    options: VoiceJoinOptions,
) -> Result<VoiceJoinCredentials> {
    if !voice_client.is_enabled() {
        return Err(create_error!(LiveKitUnavailable));
    }

    let force_disconnect = should_disconnect_existing_voice_sessions(options.force_disconnect);

    if user.bot.is_some() && force_disconnect {
        return Err(create_error!(IsBot));
    }

    let channel = Reference::from_unchecked(channel_id).as_channel(db).await?;

    let Some(voice_info) = channel.voice() else {
        return Err(create_error!(NotAVoiceChannel));
    };

    let mut permissions = perms(db, user).channel(&channel);

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
    let has_existing_node = existing_node.is_some();

    let node = existing_node
        .or(options.node)
        .ok_or_else(|| create_error!(UnknownNode))?;

    let config = config().await;

    let node_host = config
        .hosts
        .livekit
        .get(&node)
        .ok_or_else(|| create_error!(UnknownNode))?
        .clone();

    if user.bot.is_none() {
        set_user_voice_join_intent(
            &user.id,
            &user_voice_channel,
            options.self_mute,
            options.self_deaf,
        )
        .await?;

        if force_disconnect {
            voice_client.remove_user_from_all_rooms(&user.id).await?;
        }

        if force_disconnect {
            for previous_channel in voice_channels_to_disconnect_on_join(
                get_user_voice_channels(&user.id).await?,
                &user_voice_channel,
            ) {
                remove_user_from_voice_channel(voice_client, &previous_channel, &user.id).await?;
            }
        }
    } else {
        raise_if_in_voice(user, &user_voice_channel).await?;
    }

    let token = voice_client
        .create_token_for_identity(&node, db, user, &user.id, current_permissions, &channel)
        .await?;
    let native_microphone = create_native_credentials(
        voice_client,
        &node,
        db,
        user,
        "microphone",
        current_permissions,
        &channel,
    )
    .await?;
    let native_screen = create_native_credentials(
        voice_client,
        &node,
        db,
        user,
        "screen",
        current_permissions,
        &channel,
    )
    .await?;
    let native_camera = create_native_credentials(
        voice_client,
        &node,
        db,
        user,
        "camera",
        current_permissions,
        &channel,
    )
    .await?;

    let room = voice_client.create_room(&node, &channel).await?;

    if !has_existing_node {
        set_channel_node(channel.id(), &node).await?;
    }

    log::debug!("Created room {}", room.name);

    if let Some(recipients) = options.recipients {
        if room.num_participants == 0 && !recipients.is_empty() {
            set_call_notification_recipients(channel.id(), &user.id, &recipients).await?;
        }
    }

    Ok(VoiceJoinCredentials {
        channel_id: channel.id().to_string(),
        node,
        url: node_host,
        token,
        native_microphone,
        native_screen,
        native_camera,
    })
}

pub async fn refresh_voice_credentials(
    db: &Database,
    voice_client: &VoiceClient,
    user: &User,
    channel_id: &str,
) -> Result<VoiceJoinCredentials> {
    if !voice_client.is_enabled() {
        return Err(create_error!(LiveKitUnavailable));
    }

    let channel = Reference::from_unchecked(channel_id).as_channel(db).await?;

    if channel.voice().is_none() {
        return Err(create_error!(NotAVoiceChannel));
    }

    let mut permissions = perms(db, user).channel(&channel);
    let current_permissions = calculate_channel_permissions(&mut permissions).await;
    current_permissions.throw_if_lacking_channel_permission(ChannelPermission::Connect)?;

    let node = get_channel_node(channel.id())
        .await?
        .ok_or_else(|| create_error!(UnknownNode))?;

    let config = config().await;
    let node_host = config
        .hosts
        .livekit
        .get(&node)
        .ok_or_else(|| create_error!(UnknownNode))?
        .clone();

    let token = voice_client
        .create_token_for_identity(&node, db, user, &user.id, current_permissions, &channel)
        .await?;

    Ok(VoiceJoinCredentials {
        channel_id: channel.id().to_string(),
        node,
        url: node_host,
        token,
        native_microphone: create_native_credentials(
            voice_client,
            &node,
            db,
            user,
            "microphone",
            current_permissions,
            &channel,
        )
        .await?,
        native_screen: create_native_credentials(
            voice_client,
            &node,
            db,
            user,
            "screen",
            current_permissions,
            &channel,
        )
        .await?,
        native_camera: create_native_credentials(
            voice_client,
            &node,
            db,
            user,
            "camera",
            current_permissions,
            &channel,
        )
        .await?,
    })
}

async fn create_native_credentials(
    voice_client: &VoiceClient,
    node: &str,
    db: &Database,
    user: &User,
    media_kind: &str,
    current_permissions: PermissionValue,
    channel: &Channel,
) -> Result<NativeVoiceCredentials> {
    let identity = desktop_native_voice_identity(&user.id, media_kind);
    let token = voice_client
        .create_token_for_identity(node, db, user, &identity, current_permissions, channel)
        .await?;

    Ok(NativeVoiceCredentials { token, identity })
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
    use super::{
        should_disconnect_existing_voice_sessions, should_reject_voice_join_for_capacity,
        voice_channels_to_disconnect_on_join,
    };
    use crate::voice::UserVoiceChannel;

    #[test]
    fn rejects_join_when_channel_is_at_capacity() {
        assert!(should_reject_voice_join_for_capacity(
            Some(&["a".into(), "b".into()]),
            Some(2),
            "c",
        ));
    }

    #[test]
    fn allows_rejoin_for_existing_member() {
        assert!(!should_reject_voice_join_for_capacity(
            Some(&["a".into(), "b".into()]),
            Some(2),
            "a",
        ));
    }

    #[test]
    fn disconnects_other_channels_on_join_by_default() {
        let target = UserVoiceChannel {
            id: "target".into(),
            server_id: None,
        };
        let other = UserVoiceChannel {
            id: "other".into(),
            server_id: None,
        };

        assert_eq!(
            voice_channels_to_disconnect_on_join(vec![target.clone(), other], &target),
            vec![UserVoiceChannel {
                id: "other".into(),
                server_id: None,
            }]
        );
    }

    #[test]
    fn force_disconnect_defaults_to_true() {
        assert!(should_disconnect_existing_voice_sessions(None));
        assert!(!should_disconnect_existing_voice_sessions(Some(false)));
    }
}
