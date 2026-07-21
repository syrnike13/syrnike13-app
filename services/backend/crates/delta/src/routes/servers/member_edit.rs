use std::collections::HashSet;

use iso8601_timestamp::Timestamp;
use log::warn;
use syrnike_database::{
    events::client::{
        EventV1, VoiceAuthorityLease, VoiceAuthorityMembershipClaim, VoiceRtcCredential,
    },
    util::{
        permissions::{perms, DatabasePermissionQuery},
        reference::Reference,
    },
    voice::{
        cancel_current_pending_voice_join_in_server, create_voice_session, get_channel_node,
        get_current_voice_operation_id, get_current_voice_session,
        get_user_voice_channel_in_server, get_voice_state,
        publish_authoritative_voice_snapshot,
        remove_temporary_server_member_after_voice_disconnect_locked,
        remove_user_from_voice_channel, set_channel_node, sync_user_voice_permissions,
        voice_participant_identity,
        voice_session_for_join_request, with_temporary_voice_user_lock, UserVoiceChannel,
        VoiceClient, VOICE_OPERATION_ID_PREFIX,
    },
    Database, File, PartialMember, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0::{self, FieldsMember};

use rocket::{form::validate::Contains, serde::json::Json, State};
use syrnike_config::config;
use syrnike_permissions::{
    calculate_channel_permissions, calculate_server_permissions, ChannelPermission,
};
use syrnike_result::{create_error, Result};
use uuid::Uuid;
use validator::Validate;

use super::{audit_mutation, hierarchy_policy};

fn changes_voice_permissions(data: &v0::DataMemberEdit) -> bool {
    data.roles.is_some()
        || data.timeout.is_some()
        || data.can_publish.is_some()
        || data.can_receive.is_some()
        || data.remove.contains(&FieldsMember::Roles)
        || data.remove.contains(&FieldsMember::Timeout)
        || data.remove.contains(&FieldsMember::CanPublish)
        || data.remove.contains(&FieldsMember::CanReceive)
}

fn changes_explicit_voice_membership(data: &v0::DataMemberEdit) -> bool {
    data.voice_channel.is_some() || data.remove.contains(&FieldsMember::VoiceChannel)
}

fn changes_persisted_member(data: &v0::DataMemberEdit) -> bool {
    data.nickname.is_some()
        || data.avatar.is_some()
        || changes_voice_permissions(data)
        || data.remove.contains(&FieldsMember::Nickname)
        || data.remove.contains(&FieldsMember::Avatar)
}

async fn disconnect_member_from_voice(
    db: &Database,
    voice_client: &VoiceClient,
    server_id: &str,
    user_id: &str,
    cleanup_temporary_member: bool,
) -> Result<()> {
    let disconnected_at = Timestamp::now_utc();
    cancel_current_pending_voice_join_in_server(user_id, server_id).await?;
    let active_session = get_current_voice_session(user_id)
        .await?
        .filter(|session| session.channel.server_id.as_deref() == Some(server_id));
    if let Some(session) = active_session {
        remove_user_from_voice_channel(&session.channel, user_id).await?;
        publish_authoritative_voice_snapshot(user_id).await?;

        let identity = voice_participant_identity(
            user_id,
            session.rtc_engine,
            &session.client_instance_id,
            &session.operation_id,
            &session.connection_epoch,
        );
        let removal = async_std::future::timeout(
            std::time::Duration::from_secs(2),
            voice_client.remove_user(&session.node, &identity, &session.channel.id),
        )
        .await;
        if !matches!(removal, Ok(Ok(()))) {
            warn!(
                "Voice transport removal did not complete for user {user_id} after authoritative disconnect"
            );
        }
    } else {
        // A cancelled pending join also changes authority even though it has no
        // committed roster entry to remove.
        publish_authoritative_voice_snapshot(user_id).await?;
    }
    if cleanup_temporary_member {
        remove_temporary_server_member_after_voice_disconnect_locked(
            db,
            server_id,
            user_id,
            disconnected_at,
        )
        .await?;
    }
    Ok(())
}

/// # Edit Member
///
/// Edit a member by their id.
#[openapi(tag = "Server Members")]
#[patch("/<server_id>/members/<member_id>", data = "<data>")]
pub async fn edit(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    server_id: Reference<'_>,
    member_id: Reference<'_>,
    data: Json<v0::DataMemberEdit>,
) -> Result<Json<v0::Member>> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;
    if let Some(roles) = &data.roles {
        if roles.iter().collect::<HashSet<_>>().len() != roles.len() {
            return Err(create_error!(FailedValidation {
                error: "roles must not contain duplicate IDs".to_string(),
            }));
        }
    }
    if data.remove.contains(&FieldsMember::JoinedAt) {
        return Err(create_error!(InvalidOperation));
    }

    // Fetch server and member
    let server = server_id.as_server(db).await?;
    let target_user = member_id.as_user(db).await?;
    let mut member = member_id.as_member(db, &server.id).await?;

    // Fetch our currrent permissions
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    let permissions = calculate_server_permissions(&mut query).await;

    // Fetch target permissions
    let mut target_query = DatabasePermissionQuery::new(db, &target_user)
        .server(&server)
        .member(&member);
    let target_permissions = calculate_server_permissions(&mut target_query).await;

    // Check permissions in server
    if data.nickname.is_some() || data.remove.contains(&v0::FieldsMember::Nickname) {
        if user.id == member.id.user {
            permissions.throw_if_lacking_channel_permission(ChannelPermission::ChangeNickname)?;
        } else {
            permissions.throw_if_lacking_channel_permission(ChannelPermission::ManageNicknames)?;
        }
    }

    if data.avatar.is_some() || data.remove.contains(&v0::FieldsMember::Avatar) {
        if user.id == member.id.user {
            permissions.throw_if_lacking_channel_permission(ChannelPermission::ChangeAvatar)?;
        } else if data.remove.contains(&v0::FieldsMember::Avatar) {
            permissions.throw_if_lacking_channel_permission(ChannelPermission::RemoveAvatars)?;
        } else {
            return Err(create_error!(InvalidOperation));
        }
    }

    if data.roles.is_some() || data.remove.contains(&v0::FieldsMember::Roles) {
        permissions.throw_if_lacking_channel_permission(ChannelPermission::AssignRoles)?;

        if user.id != server.owner && member.id.user == user.id {
            return Err(create_error!(NotElevated));
        }
    }

    if data.timeout.is_some() || data.remove.contains(&v0::FieldsMember::Timeout) {
        if data.timeout.is_some() {
            if member.id.user == user.id {
                return Err(create_error!(CannotTimeoutYourself));
            }

            if target_permissions.has_channel_permission(ChannelPermission::TimeoutMembers) {
                return Err(create_error!(IsElevated));
            }
        }

        permissions.throw_if_lacking_channel_permission(ChannelPermission::TimeoutMembers)?;
    }

    if data.can_publish.is_some() || data.remove.contains(&v0::FieldsMember::CanPublish) {
        permissions.throw_if_lacking_channel_permission(ChannelPermission::MuteMembers)?;
    }

    if data.can_receive.is_some() || data.remove.contains(&v0::FieldsMember::CanReceive) {
        permissions.throw_if_lacking_channel_permission(ChannelPermission::DeafenMembers)?;
    }

    if data.voice_channel.is_some() && data.remove.contains(&FieldsMember::VoiceChannel) {
        return Err(create_error!(InvalidOperation));
    }

    let explicit_voice_membership_change = changes_explicit_voice_membership(&data);
    if explicit_voice_membership_change && changes_persisted_member(&data) {
        return Err(create_error!(InvalidOperation));
    }

    if explicit_voice_membership_change {
        if !voice_client.is_enabled() {
            return Err(create_error!(LiveKitUnavailable));
        };

        permissions.throw_if_lacking_channel_permission(ChannelPermission::MoveMembers)?;
    }

    let new_voice_channel = if let Some(new_channel) = &data.voice_channel {
        // ensure the channel we are moving them to is in the server and is a voice channel

        let channel = Reference::from_unchecked(new_channel)
            .as_channel(db)
            .await
            .map_err(|_| create_error!(UnknownChannel))?;

        if channel.server().is_none_or(|v| v != member.id.server) || channel.voice().is_none() {
            Err(create_error!(UnknownChannel))?
        }

        if member.id.user == user.id {
            let channel_permissions =
                calculate_channel_permissions(&mut query.clone().channel(&channel)).await;
            channel_permissions.throw_if_lacking_channel_permission(ChannelPermission::Connect)?;
        }
        if get_user_voice_channel_in_server(&target_user.id, &server.id)
            .await?
            .is_none()
        {
            Err(create_error!(NotConnected))?
        };

        Some(channel)
    } else {
        None
    };

    let actor_rank = query.get_member_rank();

    // Voice moderation is explicitly permission-gated above and is allowed
    // against the server owner. Server kick/ban/roles and other punitive
    // mutations keep their separate hierarchy policy.
    let changes_ranked_member_fields = data.nickname.is_some()
        || data.remove.contains(&v0::FieldsMember::Nickname)
        || data.avatar.is_some()
        || data.remove.contains(&v0::FieldsMember::Avatar)
        || data.timeout.is_some()
        || data.remove.contains(&v0::FieldsMember::Timeout);

    if member.id.user != user.id && changes_ranked_member_fields {
        hierarchy_policy::ensure_member_below_actor(&user, &server, actor_rank, &member)?;
    }

    // Check permissions against roles in diff
    if let Some(roles) = &data.roles {
        let current_roles = member.roles.iter().collect::<HashSet<&String>>();
        let new_roles = roles.iter().collect::<HashSet<&String>>();

        for role_id in new_roles.symmetric_difference(&current_roles) {
            if let Some(role) = server.roles.get(*role_id) {
                hierarchy_policy::ensure_role_below_actor(&user, &server, actor_rank, role.rank)?;
            } else {
                return Err(create_error!(InvalidRole));
            }
        }
    } else if data.remove.contains(&v0::FieldsMember::Roles) {
        for role_id in &member.roles {
            if let Some(role) = server.roles.get(role_id) {
                hierarchy_policy::ensure_role_below_actor(&user, &server, actor_rank, role.rank)?;
            } else {
                return Err(create_error!(InvalidRole));
            }
        }
    }

    let mut change_entries = Vec::new();
    if data.nickname.is_some() || data.remove.contains(&v0::FieldsMember::Nickname) {
        change_entries.push((
            "nickname",
            audit_mutation::audit_change(member.nickname.clone(), data.nickname.clone())?,
        ));
    }

    if data.avatar.is_some() || data.remove.contains(&v0::FieldsMember::Avatar) {
        change_entries.push((
            "avatar",
            audit_mutation::audit_change(
                member.avatar.as_ref().map(|avatar| avatar.id.clone()),
                data.avatar.clone(),
            )?,
        ));
    }

    if data.roles.is_some() || data.remove.contains(&v0::FieldsMember::Roles) {
        let roles_after = data.roles.clone().or_else(|| {
            data.remove
                .contains(&v0::FieldsMember::Roles)
                .then(Vec::<String>::new)
        });
        change_entries.push((
            "roles",
            audit_mutation::audit_change(Some(member.roles.clone()), roles_after)?,
        ));
    }

    if data.timeout.is_some() || data.remove.contains(&v0::FieldsMember::Timeout) {
        change_entries.push((
            "timeout",
            audit_mutation::audit_change(member.timeout, data.timeout)?,
        ));
    }

    if data.can_publish.is_some() || data.remove.contains(&v0::FieldsMember::CanPublish) {
        let can_publish_after = data.can_publish.or_else(|| {
            data.remove
                .contains(&v0::FieldsMember::CanPublish)
                .then_some(true)
        });
        change_entries.push((
            "can_publish",
            audit_mutation::audit_change(Some(member.can_publish), can_publish_after)?,
        ));
    }

    if data.can_receive.is_some() || data.remove.contains(&v0::FieldsMember::CanReceive) {
        let can_receive_after = data.can_receive.or_else(|| {
            data.remove
                .contains(&v0::FieldsMember::CanReceive)
                .then_some(true)
        });
        change_entries.push((
            "can_receive",
            audit_mutation::audit_change(Some(member.can_receive), can_receive_after)?,
        ));
    }

    if data.voice_channel.is_some() || data.remove.contains(&FieldsMember::VoiceChannel) {
        change_entries.push((
            "voice_channel",
            audit_mutation::audit_change(None::<String>, data.voice_channel.clone())?,
        ));
    }

    let action = if data.timeout.is_some() || data.remove.contains(&v0::FieldsMember::Timeout) {
        ServerAuditLogAction::MemberTimeout
    } else {
        ServerAuditLogAction::MemberUpdate
    };
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        action,
        ServerAuditLogTarget::Member {
            user_id: member.id.user.clone(),
        },
        None,
        audit_mutation::audit_changes(change_entries),
    )
    .await?;

    let should_sync_voice_permissions = changes_voice_permissions(&data);

    let was_temporary_member = member.temporary;
    let mutation = || async {
        // Apply edits to the member object
        let v0::DataMemberEdit {
            nickname,
            avatar,
            roles,
            timeout,
            remove,
            can_publish,
            can_receive,
            voice_channel: _,
        } = data;

        let makes_temporary_member_permanent =
            member.temporary && roles.as_ref().is_some_and(|roles| !roles.is_empty());
        let mut partial = PartialMember {
            nickname,
            roles,
            timeout,
            can_publish,
            can_receive,
            temporary: makes_temporary_member_permanent.then_some(false),
            ..Default::default()
        };

        // 1. Remove fields from object
        if remove.contains(&v0::FieldsMember::Avatar) {
            if let Some(avatar) = &member.avatar {
                db.mark_attachment_as_deleted(&avatar.id).await?;
            }
        }

        // 2. Apply new avatar
        if let Some(avatar) = avatar {
            partial.avatar = Some(File::use_user_avatar(db, &avatar, &user.id, &user.id).await?);
        }

        if !explicit_voice_membership_change {
            member
                .update(
                    db,
                    partial,
                    remove.clone().into_iter().map(Into::into).collect(),
                )
                .await?;
        }

        if let Some(new_voice_channel) = new_voice_channel {
            if let Some(channel) =
                get_user_voice_channel_in_server(&target_user.id, &server.id).await?
            {
                let old_node = get_channel_node(&channel)
                    .await?
                    .ok_or_else(|| create_error!(UnknownNode))?;

                let new_node = match get_channel_node(new_voice_channel.id()).await? {
                    Some(node) => node,
                    None => {
                        set_channel_node(new_voice_channel.id(), &old_node).await?;
                        old_node.clone()
                    }
                };

                let new_user_voice_channel = UserVoiceChannel::from_channel(&new_voice_channel);
                let old_user_voice_channel = UserVoiceChannel {
                    id: channel.clone(),
                    server_id: new_user_voice_channel.server_id.clone(),
                };

                let existing_voice_state =
                    get_voice_state(&old_user_voice_channel, &target_user.id).await?;
                let self_mute = existing_voice_state
                    .as_ref()
                    .map(|state| state.self_mute)
                    .unwrap_or(false);
                let self_deaf = existing_voice_state
                    .as_ref()
                    .map(|state| state.self_deaf)
                    .unwrap_or(false);
                let operation_id = format!("{VOICE_OPERATION_ID_PREFIX}{}", Uuid::new_v4());
                let previous_operation_id =
                    get_current_voice_operation_id(&old_user_voice_channel, &target_user.id)
                        .await?
                        .ok_or_else(|| create_error!(NotConnected))?;
                let previous_session = get_current_voice_session(&target_user.id)
                    .await?
                    .ok_or_else(|| create_error!(NotConnected))?;
                let connection_epoch = Uuid::new_v4().to_string();
                let query = perms(db, &target_user).channel(&new_voice_channel);
                let destination_was_visible = calculate_channel_permissions(&mut query.clone())
                    .await
                    .has_channel_permission(ChannelPermission::ViewChannel);
                let permissions =
                    calculate_channel_permissions(&mut query.voice_channel_membership()).await;

                voice_client
                    .create_room(&new_node, &new_voice_channel)
                    .await?;
                let identity = voice_participant_identity(
                    &target_user.id,
                    previous_session.rtc_engine,
                    &previous_session.client_instance_id,
                    &operation_id,
                    &connection_epoch,
                );
                let token = voice_client
                    .create_token_for_identity(
                        &new_node,
                        db,
                        &target_user,
                        &identity,
                        permissions,
                        &new_voice_channel,
                    )
                    .await?;
                let created_at = Timestamp::now_utc();
                create_voice_session(&voice_session_for_join_request(
                    &operation_id,
                    &target_user.id,
                    &new_user_voice_channel,
                    &new_node,
                    previous_session.rtc_engine,
                    &previous_session.client_instance_id,
                    &connection_epoch,
                    self_mute,
                    self_deaf,
                    created_at,
                )?)
                .await?;

                let authority_version =
                    syrnike_database::voice::get_voice_authority_snapshot(&target_user.id)
                        .await?
                        .version;
                let url = config()
                    .await
                    .hosts
                    .livekit
                    .get(&new_node)
                    .cloned()
                    .ok_or_else(|| create_error!(UnknownNode))?;

                // The move publisher already owns the authoritative channel
                // object. Project a hidden destination before the credentialed
                // move so Bonfire does not have to recover it with a fallible
                // database lookup while processing the authority event.
                if !destination_was_visible {
                    EventV1::ChannelCreate(new_voice_channel.clone().into())
                        .private(target_user.id.clone())
                        .await;
                }

                EventV1::VoiceAuthorityMove {
                    from: VoiceAuthorityMembershipClaim {
                        operation_id: previous_session.operation_id.clone(),
                        channel_id: channel.clone(),
                        rtc_engine: previous_session.rtc_engine,
                        client_instance_id: previous_session.client_instance_id.clone(),
                        connection_epoch: previous_session.connection_epoch.clone(),
                    },
                    lease: VoiceAuthorityLease {
                        operation_id: operation_id.clone(),
                        authority_version,
                        channel_id: new_voice_channel.id().to_string(),
                        node: new_node.clone(),
                        url,
                        credential: VoiceRtcCredential {
                            rtc_engine: previous_session.rtc_engine,
                            client_instance_id: previous_session.client_instance_id.clone(),
                            connection_epoch: connection_epoch.clone(),
                            token,
                            identity,
                        },
                    },
                }
                .private(target_user.id.clone())
                .await;

                // Let the exact move directive reach the owning client before the
                // old participant is forcibly removed. The client still performs
                // break-before-make; removal is an administrative enforcement
                // fallback for an unresponsive or non-compliant client.
                async_std::task::sleep(std::time::Duration::from_millis(500)).await;

                let _ = async_std::future::timeout(
                    std::time::Duration::from_secs(2),
                    voice_client.remove_user(
                        &old_node,
                        &voice_participant_identity(
                            &target_user.id,
                            previous_session.rtc_engine,
                            &previous_session.client_instance_id,
                            &previous_operation_id,
                            &previous_session.connection_epoch,
                        ),
                        &channel,
                    ),
                )
                .await;
            };
        } else if voice_client.is_enabled() && should_sync_voice_permissions {
            let reconciliation = async {
                let Some(channel_id) =
                    get_user_voice_channel_in_server(&target_user.id, &server.id).await?
                else {
                    return Ok(());
                };
                let node = get_channel_node(&channel_id)
                    .await?
                    .ok_or_else(|| create_error!(UnknownNode))?;
                let channel = Reference::from_unchecked(&channel_id)
                    .as_channel(db)
                    .await?;

                sync_user_voice_permissions(
                    db,
                    voice_client,
                    &node,
                    &target_user,
                    &channel,
                    Some(&server),
                    None,
                )
                .await
            }
            .await;

            if let Err(error) = reconciliation {
                syrnike_config::capture_internal_error!(&error);
                warn!(
                    "Failed to reconcile voice permissions for user {} after committed member update: {error:?}",
                    target_user.id
                );
            }
        };

        if remove.contains(&FieldsMember::VoiceChannel) {
            disconnect_member_from_voice(
                db,
                voice_client,
                &server.id,
                &target_user.id,
                was_temporary_member,
            )
            .await?;
        }

        Ok(member)
    };
    let mutation_result: Result<_> = if was_temporary_member {
        with_temporary_voice_user_lock(db, &target_user.id, mutation).await
    } else {
        mutation().await
    };

    let member = match mutation_result {
        Ok(member) => member,
        Err(error) => return audit_mutation::mark_failed_and_return(db, &mut audit, error).await,
    };

    audit_mutation::mark_succeeded_after_commit(db, &mut audit).await;

    Ok(Json(member.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![edit]
}

#[cfg(test)]
mod test {
    use std::collections::HashMap;

    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use iso8601_timestamp::Timestamp;
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_config::LiveKitNode;
    use syrnike_database::voice::VoiceClient;
    use syrnike_database::{
        fixture, Database, DatabaseInfo, PartialRole, ServerAuditLogAction, ServerAuditLogQuery,
        ServerAuditLogStatus, ServerAuditLogTarget,
    };
    use syrnike_permissions::{ChannelPermission, OverrideField};
    use ulid::Ulid;

    struct MemberEditTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl MemberEditTestContext {
        async fn new() -> Self {
            Self::new_with_voice_client(VoiceClient::new(HashMap::new())).await
        }

        async fn new_with_voice_enabled() -> Self {
            Self::new_with_voice_client(VoiceClient::new(HashMap::from([(
                "test".to_string(),
                LiveKitNode {
                    url: "http://127.0.0.1:7880".to_string(),
                    lat: 0.0,
                    lon: 0.0,
                    key: "test".to_string(),
                    secret: "test".to_string(),
                    private: false,
                },
            )])))
            .await
        }

        async fn new_with_voice_client(voice_client: VoiceClient) -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let authifier = db.clone().to_authifier().await;
            let client = Client::tracked(
                rocket::build()
                    .mount("/servers", super::routes_under_test())
                    .manage(authifier.clone())
                    .manage(db.clone())
                    .manage(voice_client),
            )
            .await
            .expect("valid rocket instance");

            Self {
                client,
                db,
                authifier,
            }
        }

        async fn account_from_user(&self, id: String) -> (Account, Session) {
            let account = Account {
                id,
                email: format!("{}@syrnike13.ru", Ulid::new()),
                password: Default::default(),
                email_normalised: Default::default(),
                deletion: None,
                disabled: false,
                lockout: None,
                mfa: Default::default(),
                password_reset: None,
                verification: EmailVerification::Verified,
            };

            self.authifier
                .database
                .save_account(&account)
                .await
                .expect("account saved");

            let session = account
                .create_session(&self.authifier, String::new())
                .await
                .expect("session created");

            (account, session)
        }
    }

    #[rocket::async_test]
    async fn member_nickname_edit_writes_audit_entry() {
        let context = MemberEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            target user 2
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "nickname": "Renamed" }).to_string())
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::MemberUpdate),
                    target_type: Some("Member".to_string()),
                    target_id: Some(target.id.clone()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].actor_id, owner.id);
        assert_eq!(entries[0].status, ServerAuditLogStatus::Succeeded);
        assert_eq!(
            entries[0].target,
            ServerAuditLogTarget::Member { user_id: target.id }
        );
        assert_eq!(
            entries[0].changes["nickname"].after,
            Some(serde_json::json!("Renamed"))
        );
    }

    #[rocket::async_test]
    async fn member_timeout_edit_uses_timeout_audit_action() {
        let context = MemberEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            target user 2
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let timeout = "2030-01-01T00:00:00+0000";
        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "timeout": timeout }).to_string())
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::MemberTimeout),
                    target_type: Some("Member".to_string()),
                    target_id: Some(target.id.clone()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].actor_id, owner.id);
        assert_eq!(entries[0].status, ServerAuditLogStatus::Succeeded);
    }

    #[rocket::async_test]
    async fn member_cannot_remove_their_own_top_role() {
        let context = MemberEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            moderator user 1
            server server 4);

        let mut moderator_role = server
            .roles
            .values()
            .find(|role| role.name == "Moderator")
            .expect("moderator role")
            .clone();
        moderator_role
            .update(
                &context.db,
                &server.id,
                PartialRole {
                    permissions: Some(OverrideField {
                        a: ChannelPermission::AssignRoles as i64,
                        d: 0,
                    }),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("moderator can assign roles");

        let (_, moderator_session) = context.account_from_user(moderator.id.clone()).await;
        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, moderator.id))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "roles": [] }).to_string())
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);

        let updated = context
            .db
            .fetch_member(&server.id, &moderator.id)
            .await
            .expect("member fetched");

        assert_eq!(updated.roles, vec![moderator_role.id]);
    }

    #[rocket::async_test]
    async fn member_cannot_assign_their_own_lower_role() {
        let context = MemberEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            moderator user 1
            server server 4);

        let mut moderator_role = server
            .roles
            .values()
            .find(|role| role.name == "Moderator")
            .expect("moderator role")
            .clone();
        moderator_role
            .update(
                &context.db,
                &server.id,
                PartialRole {
                    permissions: Some(OverrideField {
                        a: ChannelPermission::AssignRoles as i64,
                        d: 0,
                    }),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("moderator can assign roles");
        let lower_role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower role")
            .clone();

        let (_, moderator_session) = context.account_from_user(moderator.id.clone()).await;
        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, moderator.id))
            .header(ContentType::JSON)
            .body(
                serde_json::json!({
                    "roles": [moderator_role.id, lower_role.id]
                })
                .to_string(),
            )
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);

        let updated = context
            .db
            .fetch_member(&server.id, &moderator.id)
            .await
            .expect("member fetched");

        assert_eq!(updated.roles, vec![moderator_role.id]);
    }

    #[rocket::async_test]
    async fn assigning_role_to_temporary_member_makes_membership_permanent() {
        let context = MemberEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            target user 2
            server server 4);

        let mut target_member = context
            .db
            .fetch_member(&server.id, &target.id)
            .await
            .expect("target member fetched");
        target_member
            .update(
                &context.db,
                syrnike_database::PartialMember {
                    temporary: Some(true),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("target member marked temporary");
        let role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower role");

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "roles": [role.id.clone()] }).to_string())
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);

        let updated = context
            .db
            .fetch_member(&server.id, &target.id)
            .await
            .expect("member fetched");

        assert_eq!(updated.roles, vec![role.id.clone()]);
        assert!(!updated.temporary);
    }

    #[rocket::async_test]
    async fn member_can_assign_lower_role_to_equal_ranked_target() {
        let context = MemberEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            moderator user 1
            target user 2
            server server 4);

        let mut moderator_role = server
            .roles
            .values()
            .find(|role| role.name == "Moderator")
            .expect("moderator role")
            .clone();
        moderator_role
            .update(
                &context.db,
                &server.id,
                PartialRole {
                    permissions: Some(OverrideField {
                        a: ChannelPermission::AssignRoles as i64,
                        d: 0,
                    }),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("moderator can assign roles");

        let lower_role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower role")
            .clone();

        let mut target_member = context
            .db
            .fetch_member(&server.id, &target.id)
            .await
            .expect("target member fetched");
        target_member
            .update(
                &context.db,
                syrnike_database::PartialMember {
                    roles: Some(vec![moderator_role.id.clone()]),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("target promoted");

        let (_, moderator_session) = context.account_from_user(moderator.id.clone()).await;
        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(
                serde_json::json!({
                    "roles": [moderator_role.id, lower_role.id]
                })
                .to_string(),
            )
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);

        let updated = context
            .db
            .fetch_member(&server.id, &target.id)
            .await
            .expect("member fetched");

        assert_eq!(updated.roles, vec![moderator_role.id, lower_role.id]);
    }

    #[rocket::async_test]
    async fn member_cannot_voice_mute_equal_ranked_target() {
        let context = MemberEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            moderator user 1
            target user 2
            server server 4);

        let mut moderator_role = server
            .roles
            .values()
            .find(|role| role.name == "Moderator")
            .expect("moderator role")
            .clone();
        moderator_role
            .update(
                &context.db,
                &server.id,
                PartialRole {
                    permissions: Some(OverrideField {
                        a: ChannelPermission::MuteMembers as i64,
                        d: 0,
                    }),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("moderator can mute");

        let mut target_member = context
            .db
            .fetch_member(&server.id, &target.id)
            .await
            .expect("target member fetched");
        target_member
            .update(
                &context.db,
                syrnike_database::PartialMember {
                    roles: Some(vec![moderator_role.id.clone()]),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("target promoted");

        let (_, moderator_session) = context.account_from_user(moderator.id.clone()).await;
        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "can_publish": false }).to_string())
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);

        let updated = context
            .db
            .fetch_member(&server.id, &target.id)
            .await
            .expect("member fetched");

        assert!(updated.can_publish);
    }

    #[rocket::async_test]
    async fn member_cannot_be_moved_to_text_only_channel() {
        let context = MemberEditTestContext::new_with_voice_enabled().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            target user 2
            channel channel 3
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "voice_channel": channel.id() }).to_string())
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::NotFound);
    }

    #[rocket::async_test]
    async fn member_cannot_clear_their_own_top_role() {
        let context = MemberEditTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            moderator user 1
            server server 4);

        let mut moderator_role = server
            .roles
            .values()
            .find(|role| role.name == "Moderator")
            .expect("moderator role")
            .clone();
        moderator_role
            .update(
                &context.db,
                &server.id,
                PartialRole {
                    permissions: Some(OverrideField {
                        a: ChannelPermission::AssignRoles as i64,
                        d: 0,
                    }),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("moderator can assign roles");

        let (_, moderator_session) = context.account_from_user(moderator.id.clone()).await;
        let body = serde_json::to_string(&syrnike_models::v0::DataMemberEdit {
            nickname: None,
            avatar: None,
            roles: None,
            timeout: None,
            can_publish: None,
            can_receive: None,
            voice_channel: None,
            remove: vec![syrnike_models::v0::FieldsMember::Roles],
        })
        .expect("member edit body");

        let response = context
            .client
            .patch(format!("/servers/{}/members/{}", server.id, moderator.id))
            .header(ContentType::JSON)
            .body(body)
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);

        let updated = context
            .db
            .fetch_member(&server.id, &moderator.id)
            .await
            .expect("member fetched");

        assert_eq!(updated.roles, vec![moderator_role.id]);
    }

    #[test]
    fn member_role_changes_require_voice_permission_sync() {
        assert!(super::changes_voice_permissions(
            &syrnike_models::v0::DataMemberEdit {
                nickname: None,
                avatar: None,
                roles: Some(vec!["role-a".to_string()]),
                timeout: None,
                can_publish: None,
                can_receive: None,
                voice_channel: None,
                remove: vec![],
            }
        ));

        assert!(super::changes_voice_permissions(
            &syrnike_models::v0::DataMemberEdit {
                nickname: None,
                avatar: None,
                roles: None,
                timeout: None,
                can_publish: None,
                can_receive: None,
                voice_channel: None,
                remove: vec![syrnike_models::v0::FieldsMember::Roles],
            }
        ));

        assert!(super::changes_voice_permissions(
            &syrnike_models::v0::DataMemberEdit {
                nickname: None,
                avatar: None,
                roles: None,
                timeout: Some(Timestamp::now_utc()),
                can_publish: None,
                can_receive: None,
                voice_channel: None,
                remove: vec![],
            }
        ));

        assert!(super::changes_voice_permissions(
            &syrnike_models::v0::DataMemberEdit {
                nickname: None,
                avatar: None,
                roles: None,
                timeout: None,
                can_publish: None,
                can_receive: None,
                voice_channel: None,
                remove: vec![syrnike_models::v0::FieldsMember::Timeout],
            }
        ));

        assert!(!super::changes_voice_permissions(
            &syrnike_models::v0::DataMemberEdit {
                nickname: Some("Renamed".to_string()),
                avatar: None,
                roles: None,
                timeout: None,
                can_publish: None,
                can_receive: None,
                voice_channel: None,
                remove: vec![],
            }
        ));
    }

    #[test]
    fn explicit_voice_membership_changes_are_separate_from_member_updates() {
        let voice_only = syrnike_models::v0::DataMemberEdit {
            nickname: None,
            avatar: None,
            roles: None,
            timeout: None,
            can_publish: None,
            can_receive: None,
            voice_channel: Some("voice-channel".to_string()),
            remove: vec![],
        };
        assert!(super::changes_explicit_voice_membership(&voice_only));
        assert!(!super::changes_persisted_member(&voice_only));

        let combined = syrnike_models::v0::DataMemberEdit {
            nickname: Some("Renamed".to_string()),
            ..voice_only
        };
        assert!(super::changes_explicit_voice_membership(&combined));
        assert!(super::changes_persisted_member(&combined));
    }
}
