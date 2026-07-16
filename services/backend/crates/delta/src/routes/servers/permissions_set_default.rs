use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{reconcile_server_voice_permissions, VoiceClient},
    Database, PartialServer, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{
    calculate_server_permissions, ChannelPermission, DataPermissionsValue, Override,
};
use syrnike_result::Result;

use super::audit_mutation;

/// # Set Default Permission
///
/// Sets permissions for the default role in this server.
#[openapi(tag = "Server Permissions")]
#[put("/<target>/permissions/default", data = "<data>", rank = 1)]
pub async fn set_default_server_permissions(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
    data: Json<DataPermissionsValue>,
) -> Result<Json<v0::Server>> {
    let data = data.into_inner();

    let mut server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    let permissions = calculate_server_permissions(&mut query).await;

    permissions.throw_if_lacking_channel_permission(ChannelPermission::ManagePermissions)?;

    // Ensure we have permissions to grant these permissions forwards
    permissions
        .throw_permission_override(
            None,
            &Override {
                allow: data.permissions,
                deny: 0,
            },
        )
        .await?;

    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::ServerPermissionUpdate,
        ServerAuditLogTarget::Server {
            id: server.id.clone(),
        },
        None,
        audit_mutation::audit_changes(vec![(
            "default_permissions",
            audit_mutation::audit_change(
                Some(server.default_permissions as u64),
                Some(data.permissions),
            )?,
        )]),
    )
    .await?;

    if let Err(error) = server
        .update(
            db,
            PartialServer {
                default_permissions: Some(data.permissions as i64),
                ..Default::default()
            },
            vec![],
        )
        .await
    {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    reconcile_server_voice_permissions(db, voice_client, &server, None).await;

    audit_mutation::mark_succeeded_after_commit(db, &mut audit).await;

    Ok(Json(server.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![set_default_server_permissions]
}

#[cfg(test)]
mod test {
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

    struct DefaultServerPermissionsTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl DefaultServerPermissionsTestContext {
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
    async fn default_server_permission_update_writes_audit_entry() {
        let context = DefaultServerPermissionsTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .put(format!("/servers/{}/permissions/default", server.id))
            .header(ContentType::JSON)
            .body(
                json!({
                    "permissions": 1048576
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
                    action: Some(ServerAuditLogAction::ServerPermissionUpdate),
                    target_type: Some("Server".to_string()),
                    target_id: Some(server.id.clone()),
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
            ServerAuditLogTarget::Server {
                id: server.id.clone()
            }
        );
        assert_eq!(
            entry.changes["default_permissions"].before,
            Some(json!(server.default_permissions as u64))
        );
        assert_eq!(
            entry.changes["default_permissions"].after,
            Some(json!(1048576))
        );
    }
}
