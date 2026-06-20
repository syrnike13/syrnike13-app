use std::collections::HashSet;

use syrnike_database::{
    events::client::EventV1,
    util::{
        permissions::{perms, DatabasePermissionQuery},
        reference::Reference,
    },
    voice::{
        get_channel_node, get_user_voice_channel_in_server, get_voice_state,
        remove_user_from_voice_channel, set_channel_node, set_user_moved_from_voice,
        set_user_moved_to_voice, set_user_voice_join_intent, sync_user_voice_permissions,
        UserVoiceChannel, VoiceClient,
    },
    Database, File, PartialMember, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0::{self, FieldsMember};

use rocket::{form::validate::Contains, serde::json::Json, State};
use syrnike_permissions::{
    calculate_channel_permissions, calculate_server_permissions, ChannelPermission,
};
use syrnike_result::{create_error, Result};
use validator::Validate;

use super::audit_mutation;

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

    if data.can_publish.is_some() {
        permissions.throw_if_lacking_channel_permission(ChannelPermission::MuteMembers)?;
    }

    if data.can_receive.is_some() {
        permissions.throw_if_lacking_channel_permission(ChannelPermission::DeafenMembers)?;
    }

    if data.voice_channel.is_some() && data.remove.contains(&FieldsMember::VoiceChannel) {
        return Err(create_error!(InvalidOperation));
    }

    if data.voice_channel.is_some() || data.remove.contains(&FieldsMember::VoiceChannel) {
        if !voice_client.is_enabled() {
            return Err(create_error!(LiveKitUnavailable));
        };

        if member.id.user != user.id {
            permissions.throw_if_lacking_channel_permission(ChannelPermission::MoveMembers)?;
        }
    }

    let new_voice_channel = if let Some(new_channel) = &data.voice_channel {
        // ensure the channel we are moving them to is in the server and is a voice channel

        let channel = Reference::from_unchecked(new_channel)
            .as_channel(db)
            .await
            .map_err(|_| create_error!(UnknownChannel))?;

        if channel.server().is_none_or(|v| v != member.id.server) {
            Err(create_error!(UnknownChannel))?
        }

        let channel_permissions =
            calculate_channel_permissions(&mut query.clone().channel(&channel)).await;
        channel_permissions.throw_if_lacking_channel_permission(ChannelPermission::Connect)?;

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

    // Resolve our ranking
    let our_ranking = query.get_member_rank().unwrap_or(i64::MIN);

    // Check that we have permissions to act against this member
    if member.id.user != user.id
        && member.get_ranking(query.server_ref().as_ref().unwrap()) <= our_ranking
    {
        return Err(create_error!(NotElevated));
    }

    // Check permissions against roles in diff
    if let Some(roles) = &data.roles {
        let current_roles = member.roles.iter().collect::<HashSet<&String>>();
        let new_roles = roles.iter().collect::<HashSet<&String>>();

        for role_id in new_roles.symmetric_difference(&current_roles) {
            if let Some(role) = server.roles.get(*role_id) {
                if role.rank <= our_ranking {
                    return Err(create_error!(NotElevated));
                }
            } else {
                return Err(create_error!(InvalidRole));
            }
        }
    } else if data.remove.contains(&v0::FieldsMember::Roles) {
        for role_id in &member.roles {
            if let Some(role) = server.roles.get(role_id) {
                if role.rank <= our_ranking {
                    return Err(create_error!(NotElevated));
                }
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

    let mutation_result: Result<_> = async {
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

        let mut partial = PartialMember {
            nickname,
            roles,
            timeout,
            can_publish,
            can_receive,
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

        member
            .update(
                db,
                partial,
                remove.clone().into_iter().map(Into::into).collect(),
            )
            .await?;

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

                set_user_moved_from_voice(&channel, &new_user_voice_channel, &target_user.id)
                    .await?;
                set_user_moved_to_voice(
                    new_voice_channel.id(),
                    &old_user_voice_channel,
                    &target_user.id,
                )
                .await?;
                let existing_voice_state =
                    get_voice_state(&old_user_voice_channel, &target_user.id).await?;
                set_user_voice_join_intent(
                    &target_user.id,
                    &new_user_voice_channel,
                    None,
                    existing_voice_state
                        .as_ref()
                        .map(|state| state.self_mute)
                        .unwrap_or(false),
                    existing_voice_state
                        .as_ref()
                        .map(|state| state.self_deaf)
                        .unwrap_or(false),
                )
                .await?;

                let mut query = perms(db, &target_user).channel(&new_voice_channel);
                let permissions = calculate_channel_permissions(&mut query).await;

                voice_client
                    .create_room(&new_node, &new_voice_channel)
                    .await?;
                let token = voice_client
                    .create_token_for_identity(
                        &new_node,
                        db,
                        &target_user,
                        &target_user.id,
                        permissions,
                        &new_voice_channel,
                    )
                    .await?;

                voice_client
                    .remove_user(&old_node, &target_user.id, &channel)
                    .await?;

                EventV1::UserMoveVoiceChannel {
                    node: new_node,
                    from: channel,
                    to: new_voice_channel.id().to_string(),
                    token,
                }
                .private(target_user.id.clone())
                .await;
            };
        } else if voice_client.is_enabled() && should_sync_voice_permissions {
            if let Some(channel) =
                get_user_voice_channel_in_server(&target_user.id, &server.id).await?
            {
                let node = get_channel_node(&channel)
                    .await?
                    .ok_or_else(|| create_error!(UnknownNode))?;
                let channel = Reference::from_unchecked(&channel).as_channel(db).await?;

                sync_user_voice_permissions(
                    db,
                    voice_client,
                    &node,
                    &target_user,
                    &channel,
                    Some(&server),
                    None,
                )
                .await?;
            };
        };

        if remove.contains(&FieldsMember::VoiceChannel) {
            if let Some(channel) =
                get_user_voice_channel_in_server(&target_user.id, &server.id).await?
            {
                remove_user_from_voice_channel(
                    voice_client,
                    &UserVoiceChannel {
                        id: channel,
                        server_id: Some(server.id.clone()),
                    },
                    &target_user.id,
                )
                .await?;
            };
        }

        Ok(member)
    }
    .await;

    let member = match mutation_result {
        Ok(member) => member,
        Err(error) => return audit_mutation::mark_failed_and_return(db, &mut audit, error).await,
    };

    audit.mark_succeeded(db).await?;

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
                    .manage(VoiceClient::new(HashMap::new())),
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
}
