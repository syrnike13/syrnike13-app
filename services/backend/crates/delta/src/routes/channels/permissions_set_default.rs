use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{sync_voice_permissions, VoiceClient},
    Channel, Database, PartialChannel, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0::{self, DataDefaultChannelPermissions};
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission, Override};
use syrnike_result::{create_error, Result};

use crate::routes::servers::audit_mutation;

/// # Set Default Permission
///
/// Sets permissions for the default role in this channel.
///
/// Channel must be a `Group` or `TextChannel`.
#[openapi(tag = "Channel Permissions")]
#[put("/<target>/permissions/default", data = "<data>", rank = 1)]
pub async fn set_default_channel_permissions(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
    data: Json<v0::DataDefaultChannelPermissions>,
) -> Result<Json<v0::Channel>> {
    let data = data.into_inner();

    let mut channel = target.as_channel(db).await?;
    if channel.has_bot_recipient(db).await? {
        return Err(create_error!(NotFound));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    let permissions = calculate_channel_permissions(&mut query).await;

    permissions.throw_if_lacking_channel_permission(ChannelPermission::ManagePermissions)?;

    let mut audit = None;

    match &channel {
        Channel::Group { .. } => {
            if let DataDefaultChannelPermissions::Value { permissions } = data {
                channel
                    .update(
                        db,
                        PartialChannel {
                            permissions: Some(permissions as i64),
                            ..Default::default()
                        },
                        vec![],
                    )
                    .await?;
            } else {
                return Err(create_error!(InvalidOperation));
            }
        }
        Channel::TextChannel {
            id,
            server,
            default_permissions,
            ..
        } => {
            if let DataDefaultChannelPermissions::Field { permissions: field } = data {
                permissions
                    .throw_permission_override(default_permissions.map(|x| x.into()), &field)
                    .await?;

                let previous_permissions: Option<Override> =
                    default_permissions.map(|permissions| permissions.into());
                let requested_permissions = field.clone();
                audit = Some(
                    audit_mutation::insert_pending_audit(
                        db,
                        server.clone(),
                        user.id.clone(),
                        ServerAuditLogAction::ChannelPermissionUpdate,
                        ServerAuditLogTarget::Channel { id: id.clone() },
                        None,
                        audit_mutation::audit_changes(vec![(
                            "default_permissions",
                            audit_mutation::audit_change(
                                previous_permissions,
                                Some(requested_permissions.clone()),
                            )?,
                        )]),
                    )
                    .await?,
                );

                if let Err(error) = channel
                    .update(
                        db,
                        PartialChannel {
                            default_permissions: Some(requested_permissions.into()),
                            ..Default::default()
                        },
                        vec![],
                    )
                    .await
                {
                    if let Some(audit) = &mut audit {
                        return audit_mutation::mark_failed_and_return(db, audit, error).await;
                    }

                    return Err(error);
                }
            } else {
                return Err(create_error!(InvalidOperation));
            }
        }
        _ => return Err(create_error!(InvalidOperation)),
    }

    let server = match channel.server() {
        Some(server_id) => match Reference::from_unchecked(server_id).as_server(db).await {
            Ok(server) => Some(server),
            Err(error) => {
                if let Some(audit) = &mut audit {
                    return audit_mutation::mark_failed_and_return(db, audit, error).await;
                }

                return Err(error);
            }
        },
        None => None,
    };

    if let Err(error) =
        sync_voice_permissions(db, voice_client, &channel, server.as_ref(), None).await
    {
        if let Some(audit) = &mut audit {
            return audit_mutation::mark_failed_and_return(db, audit, error).await;
        }

        return Err(error);
    }

    if let Some(audit) = &mut audit {
        audit.mark_succeeded(db).await?;
    }

    Ok(Json(channel.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![set_default_channel_permissions]
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
        fixture, voice::VoiceClient, Database, DatabaseInfo, ServerAuditLogAction,
        ServerAuditLogQuery, ServerAuditLogStatus, ServerAuditLogTarget,
    };
    use ulid::Ulid;

    struct DefaultChannelPermissionsTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl DefaultChannelPermissionsTestContext {
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
    async fn default_channel_permission_update_writes_audit_entry() {
        let context = DefaultChannelPermissionsTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            channel channel 3
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .put(format!("/channels/{}/permissions/default", channel.id()))
            .header(ContentType::JSON)
            .body(
                json!({
                    "permissions": {
                        "allow": 1048576,
                        "deny": 0
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
        assert_eq!(
            entry.changes["default_permissions"].before,
            Some(json!({ "allow": 0, "deny": 1048576 }))
        );
        assert_eq!(
            entry.changes["default_permissions"].after,
            Some(json!({ "allow": 1048576, "deny": 0 }))
        );
    }
}
