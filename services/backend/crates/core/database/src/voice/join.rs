use crate::{
    events::client::EventV1,
    models::Channel,
    util::{permissions::perms, reference::Reference},
    voice::{
        call_lifecycle::{
            get_channel_voice_call, mutate_channel_voice_call_if_current, voice_call_leave_effect,
            VoiceCallLeaveEffect, VoiceCallLeavePolicy, VoiceCallLeaveReason, VoiceCallPhase,
            VoiceCallStateMutation, VoiceCallStateMutationResult, GROUP_UNANSWERED_ACTIVE_SECONDS,
        },
        desktop_native_voice_identity, finish_voice_call_started_system_message, get_channel_node,
        get_voice_channel_members, is_in_voice_channel, raise_if_in_voice,
        remove_user_from_voice_channel, remove_user_voice_transport,
        set_call_notification_recipients, set_channel_node, set_user_voice_join_intent,
        UserVoiceChannel, VoiceClient,
    },
    Database, RemovalIntention, User, VoiceCallEndReason, AMQP,
};
use syrnike_config::config;
use syrnike_models::v0::NativeVoiceCredentials;
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
    pub operation_id: Option<String>,
    pub recipients: Option<Vec<String>>,
    pub suppress_call_notifications: bool,
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

    let channel = Reference::from_unchecked(channel_id).as_channel(db).await?;

    if matches!(
        channel,
        Channel::DirectMessage { .. } | Channel::Group { .. }
    ) {
        if user.bot.is_some() {
            return Err(create_error!(IsBot));
        }
        if channel.has_bot_recipient(db).await? {
            return Err(create_error!(NotFound));
        }
    }

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

    if user.bot.is_some() {
        raise_if_in_voice(user, &user_voice_channel).await?;
    }
    set_user_voice_join_intent(
        &user.id,
        &user_voice_channel,
        options.operation_id.as_deref(),
        options.self_mute,
        options.self_deaf,
    )
    .await?;

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

    if options.suppress_call_notifications {
        set_call_notification_recipients(channel.id(), &user.id, &[]).await?;
    } else if let Some(recipients) = options
        .recipients
        .filter(|recipients| !recipients.is_empty())
    {
        set_call_notification_recipients(channel.id(), &user.id, &recipients).await?;
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

const VOICE_CALL_MUTATION_RETRY_LIMIT: usize = 8;

pub async fn remove_user_from_voice_channel_with_call_cleanup(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    if !is_in_voice_channel(user_id, channel).await? {
        return Ok(());
    }

    remove_user_from_voice_channel(voice_client, channel, user_id).await?;

    cleanup_removed_voice_member_call(db, amqp, channel).await?;
    remove_temporary_server_member_after_voice_disconnect(db, channel, user_id).await
}

pub async fn cleanup_committed_voice_member_removal(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    remove_user_voice_transport(voice_client, channel, user_id).await?;
    cleanup_removed_voice_member_call(db, amqp, channel).await
}

pub async fn remove_temporary_server_member_after_voice_disconnect(
    db: &Database,
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    let Some(server_id) = channel.server_id.as_ref() else {
        return Ok(());
    };

    let Ok(member) = db.fetch_member(server_id, user_id).await else {
        return Ok(());
    };

    if !member.temporary || !member.roles.is_empty() {
        return Ok(());
    }

    let Ok(server) = db.fetch_server(server_id).await else {
        return Ok(());
    };

    member
        .remove(db, &server, RemovalIntention::Leave, true)
        .await
}

async fn cleanup_removed_voice_member_call(
    db: &Database,
    amqp: &AMQP,
    channel: &UserVoiceChannel,
) -> Result<()> {
    let remaining_members = get_voice_channel_members(channel)
        .await?
        .unwrap_or_default();
    let leave_policy = voice_call_leave_policy_for_channel(db, &channel.id).await;
    let left_at = iso8601_timestamp::Timestamp::now_utc();

    for _ in 0..VOICE_CALL_MUTATION_RETRY_LIMIT {
        let existing_call = get_channel_voice_call(&channel.id).await?;
        let effect = voice_call_leave_effect(
            existing_call.as_ref(),
            VoiceCallLeaveReason::ParticipantLeft {
                remaining_members_after_leave: &remaining_members,
                leave_policy,
                left_at,
            },
        );

        let mutation = match &effect {
            VoiceCallLeaveEffect::NoChange => return Ok(()),
            VoiceCallLeaveEffect::StartActiveDeadline(state) => {
                VoiceCallStateMutation::Set(state.clone())
            }
            VoiceCallLeaveEffect::End { .. } => VoiceCallStateMutation::Delete,
        };

        if let VoiceCallStateMutationResult::Conflict(_) =
            mutate_channel_voice_call_if_current(&channel.id, existing_call.as_ref(), mutation)
                .await?
        {
            continue;
        }

        let (state, stop_ringing_recipients) = match effect {
            VoiceCallLeaveEffect::NoChange => unreachable!("NoChange returned before mutation"),
            VoiceCallLeaveEffect::StartActiveDeadline(state) => {
                EventV1::VoiceCallActive {
                    channel_id: state.channel_id.clone(),
                    initiator_id: state.initiator_id.clone(),
                    started_at: state.started_at,
                    expires_at: state.expires_at,
                    declined_recipients: state.declined_recipients.clone(),
                }
                .p(state.channel_id.clone())
                .await;
                return Ok(());
            }
            VoiceCallLeaveEffect::End {
                state,
                stop_ringing_recipients,
            } => (state, stop_ringing_recipients),
        };

        EventV1::VoiceCallEnd {
            channel_id: state.channel_id.clone(),
        }
        .p(state.channel_id.clone())
        .await;

        if let Err(error) = amqp
            .dm_call_updated(
                &state.initiator_id,
                &state.channel_id,
                None,
                true,
                (!stop_ringing_recipients.is_empty()).then_some(stop_ringing_recipients),
            )
            .await
        {
            syrnike_config::capture_internal_error!(&error);
        }

        let ended_reason = if state.phase == VoiceCallPhase::Active && state.expires_at.is_none() {
            VoiceCallEndReason::Completed
        } else {
            VoiceCallEndReason::Cancelled
        };

        if let Err(error) = finish_voice_call_started_system_message(
            db,
            &state.channel_id,
            iso8601_timestamp::Timestamp::now_utc(),
            ended_reason,
        )
        .await
        {
            syrnike_config::capture_internal_error!(&error);
        }

        return Ok(());
    }

    Err(create_error!(InternalError))
}

async fn voice_call_leave_policy_for_channel(
    db: &Database,
    channel_id: &str,
) -> VoiceCallLeavePolicy {
    match Reference::from_unchecked(channel_id).as_channel(db).await {
        Ok(Channel::DirectMessage { .. }) => VoiceCallLeavePolicy::EndAfterLoneMemberTimeout {
            timeout_seconds: GROUP_UNANSWERED_ACTIVE_SECONDS,
        },
        _ => VoiceCallLeavePolicy::EndWhenEmpty,
    }
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

    if matches!(
        channel,
        Channel::DirectMessage { .. } | Channel::Group { .. }
    ) {
        if user.bot.is_some() {
            return Err(create_error!(IsBot));
        }
        if channel.has_bot_recipient(db).await? {
            return Err(create_error!(NotFound));
        }
    }

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

#[cfg(test)]
mod tests {
    use super::should_reject_voice_join_for_capacity;
    use crate::{DatabaseInfo, Member, Server, User};
    use syrnike_models::v0::DataCreateServer;

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

    #[async_std::test]
    async fn temporary_member_without_roles_is_removed_after_voice_disconnect() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let owner = User::create(&db, "Owner".to_string(), None, None)
            .await
            .expect("owner created");
        let user = User::create(&db, "Temporary".to_string(), None, None)
            .await
            .expect("temporary user created");
        let server = Server::create(
            &db,
            DataCreateServer {
                name: "Server".to_string(),
                description: None,
                nsfw: None,
            },
            &owner,
            false,
        )
        .await
        .expect("server created")
        .0;
        Member::create(&db, &server, &owner, None, false)
            .await
            .expect("owner member created");
        let member = Member::create(&db, &server, &user, None, true)
            .await
            .expect("temporary member created")
            .0;

        assert!(member.temporary);

        super::remove_temporary_server_member_after_voice_disconnect(
            &db,
            &super::UserVoiceChannel {
                id: "voice-channel".to_string(),
                server_id: Some(server.id.clone()),
            },
            &user.id,
        )
        .await
        .expect("temporary member cleanup");

        assert!(db.fetch_member(&server.id, &user.id).await.is_err());
    }
}
