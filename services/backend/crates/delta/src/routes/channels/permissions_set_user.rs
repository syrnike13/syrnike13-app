use std::collections::HashMap;

use log::warn;
use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{reconcile_voice_permissions, VoiceClient},
    Channel, Database, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission, Override};
use syrnike_result::{create_error, Result};

use crate::routes::servers::audit_mutation;

/// # Set Member Permission
///
/// Sets permissions for the specified member in this channel.
///
/// Channel must be a `TextChannel`.
#[openapi(tag = "Channel Permissions")]
#[put("/<target>/permissions/users/<user_id>", data = "<data>", rank = 3)]
pub async fn set_user_permissions(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
    user_id: String,
    data: Json<v0::DataSetUserPermissions>,
) -> Result<Json<v0::Channel>> {
    let channel = target.as_channel(db).await?;
    if channel.has_bot_recipient(db).await? {
        return Err(create_error!(NotFound));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    let permissions = calculate_channel_permissions(&mut query).await;
    permissions.throw_if_lacking_channel_permission(ChannelPermission::ManagePermissions)?;

    let Some(server) = query.server_ref() else {
        return Err(create_error!(InvalidOperation));
    };
    let server_id = server.id.clone();
    db.fetch_member(&server_id, &user_id).await?;

    let previous_permissions = match &channel {
        Channel::TextChannel {
            user_permissions, ..
        } => user_permissions.get(&user_id).copied().map(Override::from),
        _ => return Err(create_error!(InvalidOperation)),
    };
    let requested_permissions = data.permissions.clone();
    permissions
        .throw_permission_override(previous_permissions.clone(), &requested_permissions)
        .await?;

    let change_key = format!("user_permissions.{}", user_id);
    let changes = HashMap::from([(
        change_key,
        audit_mutation::audit_change(previous_permissions, Some(requested_permissions.clone()))?,
    )]);
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server_id,
        user.id.clone(),
        ServerAuditLogAction::ChannelPermissionUpdate,
        ServerAuditLogTarget::Channel {
            id: channel.id().to_string(),
        },
        None,
        changes,
    )
    .await?;

    let mut new_channel = channel.clone();
    if let Err(error) = new_channel
        .set_user_permission(db, &user_id, requested_permissions.into())
        .await
    {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    if let Err(error) =
        reconcile_voice_permissions(db, voice_client, &new_channel, Some(server), None).await
    {
        syrnike_config::capture_internal_error!(&error);
        warn!("Failed to reconcile voice permissions for channel {} after updating user {user_id}: {error:?}", new_channel.id());
    }

    audit_mutation::mark_succeeded_after_commit(db, &mut audit).await;

    Ok(Json(new_channel.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![set_user_permissions]
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use serde_json::json;
    use syrnike_database::{
        fixture, voice::VoiceClient, Channel, Database, DatabaseInfo, ServerAuditLogAction,
        ServerAuditLogQuery, ServerAuditLogStatus, ServerAuditLogTarget,
    };
    use ulid::Ulid;

    struct UserChannelPermissionsTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl UserChannelPermissionsTestContext {
        async fn new() -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let authifier = db.clone().to_authifier().await;
            let client = Client::tracked(
                rocket::build()
                    .mount("/channels", super::routes_under_test())
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
    async fn user_channel_permission_update_writes_audit_entry() {
        let context = UserChannelPermissionsTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            user user 2
            channel channel 3
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .put(format!(
                "/channels/{}/permissions/users/{}",
                channel.id(),
                user.id
            ))
            .header(ContentType::JSON)
            .body(
                json!({
                    "permissions": {
                        "allow": 0,
                        "deny": 1048576
                    }
                })
                .to_string(),
            )
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        drop(response);

        let updated_channel = context
            .db
            .fetch_channel(channel.id())
            .await
            .expect("channel fetched");
        match updated_channel {
            Channel::TextChannel {
                user_permissions, ..
            } => {
                assert_eq!(user_permissions[&user.id].a, 0);
                assert_eq!(user_permissions[&user.id].d, 1048576);
            }
            _ => unreachable!("fixture channel should be text"),
        }

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::ChannelPermissionUpdate),
                    target_type: Some("Channel".to_string()),
                    target_id: Some(channel.id().to_string()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.actor_id, owner.id);
        assert_eq!(entry.status, ServerAuditLogStatus::Succeeded);
        assert_eq!(
            entry.target,
            ServerAuditLogTarget::Channel {
                id: channel.id().to_string()
            }
        );
        let change_key = format!("user_permissions.{}", user.id);
        assert_eq!(entry.changes[&change_key].before, None);
        assert_eq!(
            entry.changes[&change_key].after,
            Some(json!({ "allow": 0, "deny": 1048576 }))
        );
    }
}
