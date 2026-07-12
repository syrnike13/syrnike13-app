use crate::{
    AMQP, Database, RemovalIntention, User, VoiceCallEndReason,
    events::client::EventV1,
    models::Channel,
    util::{permissions::perms, reference::Reference},
    voice::{
        UserVoiceChannel, VOICE_SESSION_TTL_SECONDS, VoiceClient, VoiceParticipantReconciliation,
        VoiceParticipantReconciliationVerdict, VoiceRtcCredential, VoiceRtcEngine, VoiceSession,
        VoiceSessionCreate,
        call_lifecycle::{
            GROUP_UNANSWERED_ACTIVE_SECONDS, VoiceCallLeaveEffect, VoiceCallLeavePolicy,
            VoiceCallLeaveReason, VoiceCallPhase, VoiceCallStateMutation,
            VoiceCallStateMutationResult, get_channel_voice_call,
            mutate_channel_voice_call_if_current, voice_call_leave_effect,
        },
        clear_call_notification_recipients, create_voice_session_if_current,
        delete_channel_voice_state, finish_voice_call_started_system_message, get_channel_node,
        get_voice_channel_members, get_voice_participant_reconciliation, is_in_voice_channel,
        raise_if_in_voice, remove_user_from_voice_channel, set_call_notification_recipients,
        set_channel_node, voice_participant_identity,
    },
};
use iso8601_timestamp::{Duration, Timestamp};
use syrnike_config::config;
use syrnike_permissions::{ChannelPermission, calculate_channel_permissions};
use syrnike_result::{Result, create_error};

/// LiveKit credentials returned to the client after a successful voice join request.
#[derive(Debug, Clone)]
pub struct VoiceJoinCredentials {
    pub channel_id: String,
    pub node: String,
    pub url: String,
    pub credential: VoiceRtcCredential,
}

/// Options for joining a voice channel through the gateway.
#[derive(Debug, Clone, Default)]
pub struct VoiceJoinOptions {
    pub node: Option<String>,
    pub operation_id: Option<String>,
    pub expected_current_operation_id: Option<String>,
    pub rtc_engine: Option<VoiceRtcEngine>,
    pub client_instance_id: Option<String>,
    pub connection_epoch: Option<String>,
    pub recipients: Option<Vec<String>>,
    pub suppress_call_notifications: bool,
    pub self_mute: bool,
    pub self_deaf: bool,
}

pub async fn join_voice_channel(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
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

    let mut current_voice_members = get_voice_channel_members(&user_voice_channel).await?;
    if should_reject_voice_join_for_capacity(
        current_voice_members.as_deref(),
        voice_info.max_users,
        &user.id,
    ) && !current_permissions.has(ChannelPermission::ManageChannel as u64)
    {
        if let Some(reconciliation) = reconcile_voice_channel_members_with_call_cleanup(
            db,
            voice_client,
            amqp,
            &user_voice_channel,
        )
        .await?
        {
            if !reconciliation.stale_members.is_empty() {
                current_voice_members = get_voice_channel_members(&user_voice_channel).await?;
            }
        }

        if should_reject_voice_join_for_capacity(
            current_voice_members.as_deref(),
            voice_info.max_users,
            &user.id,
        ) {
            return Err(create_error!(CannotJoinCall));
        }
    }

    let existing_node = get_channel_node(channel.id()).await?;
    let node = existing_node
        .or(options.node)
        .ok_or_else(|| create_error!(UnknownNode))?;

    let config = config().await;
    let operation_id = options
        .operation_id
        .as_deref()
        .ok_or_else(|| create_error!(InvalidOperation))?;
    let rtc_engine = options
        .rtc_engine
        .ok_or_else(|| create_error!(InvalidOperation))?;
    let client_instance_id = options
        .client_instance_id
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| create_error!(InvalidOperation))?;
    let connection_epoch = options
        .connection_epoch
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| create_error!(InvalidOperation))?;

    let node_host = config
        .hosts
        .livekit
        .get(&node)
        .ok_or_else(|| create_error!(UnknownNode))?
        .clone();

    if user.bot.is_some() {
        raise_if_in_voice(user, &user_voice_channel).await?;
    }

    let session = voice_session_for_join_request(
        operation_id,
        &user.id,
        &user_voice_channel,
        &node,
        rtc_engine,
        client_instance_id,
        connection_epoch,
        options.self_mute,
        options.self_deaf,
        Timestamp::now_utc(),
    )?;
    if !create_voice_session_if_current(&session, options.expected_current_operation_id.as_deref())
        .await?
    {
        return Err(create_error!(InvalidOperation));
    }
    let room = match voice_client.create_room(&node, &channel).await {
        Ok(room) => room,
        Err(error) => {
            clear_failed_join_metadata(channel.id(), &user.id, operation_id).await;
            return Err(error);
        }
    };
    if let Err(error) = set_channel_node(channel.id(), &node).await {
        clear_failed_join_metadata(channel.id(), &user.id, operation_id).await;
        return Err(error);
    }

    log::debug!("Created room {}", room.name);

    if options.suppress_call_notifications {
        if let Err(error) =
            set_call_notification_recipients(channel.id(), &user.id, operation_id, &[]).await
        {
            clear_failed_join_metadata(channel.id(), &user.id, operation_id).await;
            return Err(error);
        }
    } else if let Some(recipients) = options
        .recipients
        .filter(|recipients| !recipients.is_empty())
    {
        if let Err(error) =
            set_call_notification_recipients(channel.id(), &user.id, operation_id, &recipients)
                .await
        {
            clear_failed_join_metadata(channel.id(), &user.id, operation_id).await;
            return Err(error);
        }
    }

    let identity = voice_participant_identity(
        &user.id,
        rtc_engine,
        client_instance_id,
        operation_id,
        connection_epoch,
    );
    let token = match voice_client
        .create_token_for_identity(&node, db, user, &identity, current_permissions, &channel)
        .await
    {
        Ok(token) => token,
        Err(error) => {
            clear_failed_join_metadata(channel.id(), &user.id, operation_id).await;
            return Err(error);
        }
    };
    Ok(VoiceJoinCredentials {
        channel_id: channel.id().to_string(),
        node,
        url: node_host,
        credential: VoiceRtcCredential {
            rtc_engine,
            client_instance_id: client_instance_id.to_string(),
            connection_epoch: connection_epoch.to_string(),
            token,
            identity,
        },
    })
}

const VOICE_CALL_MUTATION_RETRY_LIMIT: usize = 8;

pub async fn remove_user_from_voice_channel_with_call_cleanup(
    db: &Database,
    amqp: &AMQP,
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    if !is_in_voice_channel(user_id, channel).await? {
        return Ok(());
    }

    remove_user_from_voice_channel(channel, user_id).await?;

    cleanup_removed_voice_member_call(db, amqp, channel).await?;
    remove_temporary_server_member_after_voice_disconnect(db, channel, user_id).await
}

pub async fn cleanup_committed_voice_member_removal(
    db: &Database,
    amqp: &AMQP,
    session: &VoiceSession,
) -> Result<()> {
    cleanup_removed_voice_member_call(db, amqp, &session.channel).await
}

pub async fn reconcile_voice_channel_members_with_call_cleanup(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    channel: &UserVoiceChannel,
) -> Result<Option<VoiceParticipantReconciliation>> {
    let reconciliation = match get_voice_participant_reconciliation(voice_client, channel).await? {
        VoiceParticipantReconciliationVerdict::Ready(reconciliation) => reconciliation,
        VoiceParticipantReconciliationVerdict::DeadRoom { stale_members } => {
            delete_channel_voice_state(channel, &stale_members).await?;
            cleanup_removed_voice_member_call(db, amqp, channel).await?;
            return Ok(Some(VoiceParticipantReconciliation {
                livekit_members: Vec::new(),
                stale_members,
                stale_livekit_participants: Vec::new(),
            }));
        }
        VoiceParticipantReconciliationVerdict::SkipTransient => return Ok(None),
    };

    for user_id in &reconciliation.stale_members {
        remove_user_from_voice_channel_with_call_cleanup(db, amqp, channel, user_id).await?;
    }

    if !reconciliation.stale_livekit_participants.is_empty() {
        if let Some(node) = get_channel_node(&channel.id).await? {
            for identity in &reconciliation.stale_livekit_participants {
                let _ = voice_client.remove_user(&node, identity, &channel.id).await;
            }
        }
    }

    Ok(Some(reconciliation))
}

async fn clear_failed_join_metadata(channel_id: &str, user_id: &str, operation_id: &str) {
    clear_call_notification_recipients(channel_id, user_id, operation_id)
        .await
        .ok();
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
    operation_id: &str,
    rtc_engine: VoiceRtcEngine,
    client_instance_id: &str,
    connection_epoch: &str,
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

    let identity = voice_participant_identity(
        &user.id,
        rtc_engine,
        client_instance_id,
        operation_id,
        connection_epoch,
    );
    let token = voice_client
        .create_token_for_identity(&node, db, user, &identity, current_permissions, &channel)
        .await?;

    Ok(VoiceJoinCredentials {
        channel_id: channel.id().to_string(),
        node,
        url: node_host,
        credential: VoiceRtcCredential {
            rtc_engine,
            client_instance_id: client_instance_id.to_string(),
            connection_epoch: connection_epoch.to_string(),
            token,
            identity,
        },
    })
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

fn voice_session_for_join_request(
    operation_id: &str,
    user_id: &str,
    channel: &UserVoiceChannel,
    node: &str,
    rtc_engine: VoiceRtcEngine,
    client_instance_id: &str,
    connection_epoch: &str,
    self_mute: bool,
    self_deaf: bool,
    created_at: Timestamp,
) -> Result<VoiceSession> {
    Ok(VoiceSession::new_awaiting_join(VoiceSessionCreate {
        operation_id: operation_id.to_string(),
        user_id: user_id.to_string(),
        channel: channel.clone(),
        node: node.to_string(),
        rtc_engine,
        client_instance_id: client_instance_id.to_string(),
        connection_epoch: connection_epoch.to_string(),
        // Self-deafen also disables the microphone, matching Discord's
        // user-facing semantics and keeping public voice state truthful.
        self_mute: self_mute || self_deaf,
        self_deaf,
        created_at,
        expires_at: created_at
            .checked_add(Duration::seconds(VOICE_SESSION_TTL_SECONDS as i64))
            .ok_or_else(|| create_error!(InternalError))?,
    }))
}

#[cfg(test)]
mod tests {
    use super::{should_reject_voice_join_for_capacity, voice_session_for_join_request};
    use crate::voice::{UserVoiceChannel, VoiceRtcEngine, VoiceSessionState};
    use crate::{DatabaseInfo, Member, Server, User};
    use iso8601_timestamp::{Duration, Timestamp};
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

    #[test]
    fn voice_session_for_join_request_carries_fencing_and_preferences() {
        let channel = UserVoiceChannel {
            id: "voice-a".to_string(),
            server_id: Some("server-a".to_string()),
        };
        let created_at = Timestamp::UNIX_EPOCH;

        let session = voice_session_for_join_request(
            "op-a",
            "user-a",
            &channel,
            "node-a",
            VoiceRtcEngine::Web,
            "client-a",
            "epoch-a",
            true,
            false,
            created_at,
        )
        .expect("session");

        assert_eq!(session.operation_id, "op-a");
        assert_eq!(session.user_id, "user-a");
        assert_eq!(session.channel, channel);
        assert_eq!(session.node, "node-a");
        assert_eq!(session.state, VoiceSessionState::AwaitingLivekitJoin);
        assert_eq!(session.self_mute, true);
        assert_eq!(session.self_deaf, false);
        assert_eq!(
            session.expires_at,
            created_at.checked_add(Duration::seconds(120)).unwrap()
        );
    }

    #[test]
    fn voice_session_for_join_request_mutes_when_self_deafened() {
        let channel = UserVoiceChannel {
            id: "voice-a".to_string(),
            server_id: None,
        };

        let session = voice_session_for_join_request(
            "op-a",
            "user-a",
            &channel,
            "node-a",
            VoiceRtcEngine::Web,
            "client-a",
            "epoch-a",
            false,
            true,
            Timestamp::UNIX_EPOCH,
        )
        .expect("session");

        assert!(session.self_mute);
        assert!(session.self_deaf);
    }
}
