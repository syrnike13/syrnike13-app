use rocket::State;
use rocket_empty::EmptyResponse;
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{sync_voice_permissions, VoiceClient},
    Database, Role, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

use super::audit_mutation;

/// # Delete Role
///
/// Delete a server role by its id.
#[openapi(tag = "Server Permissions")]
#[delete("/<target>/roles/<role_id>")]
pub async fn delete(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    role_id: String,
    voice_client: &State<VoiceClient>,
) -> Result<EmptyResponse> {
    let mut server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ManageRole)?;

    let member_rank = query.get_member_rank().unwrap_or(i64::MIN);

    let role = server
        .roles
        .remove(&role_id)
        .ok_or_else(|| create_error!(NotFound))?;

    if role.rank <= member_rank {
        return Err(create_error!(NotElevated));
    }

    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::RoleDelete,
        ServerAuditLogTarget::Role {
            id: role.id.clone(),
        },
        None,
        audit_mutation::audit_changes(vec![(
            "role",
            audit_mutation::audit_change(Some(role.clone()), None::<Role>)?,
        )]),
    )
    .await?;

    if let Err(error) = role.delete(db, &server.id).await {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    if voice_client.is_enabled() {
        for channel_id in &server.channels {
            let channel = match Reference::from_unchecked(channel_id).as_channel(db).await {
                Ok(channel) => channel,
                Err(error) => {
                    return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
                }
            };

            if let Err(error) =
                sync_voice_permissions(db, voice_client, &channel, Some(&server), None).await
            {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }
        }
    }

    audit.mark_succeeded(db).await?;

    Ok(EmptyResponse)
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![delete]
}

#[cfg(test)]
mod test {
    use std::collections::HashMap;

    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::{
        fixture, voice::VoiceClient, Channel, Database, DatabaseInfo, PartialServer,
        ServerAuditLogAction, ServerAuditLogQuery, ServerAuditLogStatus, ServerAuditLogTarget,
        VoiceInformation,
    };
    use ulid::Ulid;

    struct RoleDeleteTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl RoleDeleteTestContext {
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
    async fn delete_role_with_disabled_voice_client_does_not_require_voice_sync() {
        let context = RoleDeleteTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let voice_channel_id = Ulid::new().to_string();
        let voice_channel = Channel::TextChannel {
            id: voice_channel_id.clone(),
            server: server.id.clone(),
            name: "Voice".to_string(),
            description: None,
            icon: None,
            last_message_id: None,
            default_permissions: None,
            role_permissions: Default::default(),
            user_permissions: Default::default(),
            nsfw: false,
            voice: Some(VoiceInformation::default()),
            slowmode: None,
        };
        context
            .db
            .insert_channel(&voice_channel)
            .await
            .expect("voice channel inserted");
        context
            .db
            .update_server(
                &server.id,
                &PartialServer {
                    channels: Some(vec![voice_channel_id]),
                    ..Default::default()
                },
                vec![],
            )
            .await
            .expect("server voice channel linked");

        let role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower-ranked role")
            .clone();
        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;

        let response = context
            .client
            .delete(format!("/servers/{}/roles/{}", server.id, role.id))
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::NoContent);

        let updated_server = context
            .db
            .fetch_server(&server.id)
            .await
            .expect("server fetched");
        assert!(!updated_server.roles.contains_key(&role.id));

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::RoleDelete),
                    target_type: Some("Role".to_string()),
                    target_id: Some(role.id.clone()),
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
            ServerAuditLogTarget::Role { id: role.id }
        );
    }
}
