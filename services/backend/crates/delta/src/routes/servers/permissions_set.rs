use rocket::{serde::json::Json, State};
use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{reconcile_server_voice_permissions, VoiceClient},
    Database, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission, Override};
use syrnike_result::{create_error, Result};

use super::{audit_mutation, hierarchy_policy};

/// # Set Role Permission
///
/// Sets permissions for the specified role in the server.
#[openapi(tag = "Server Permissions")]
#[put("/<target>/permissions/<role_id>", data = "<data>", rank = 2)]
pub async fn set_role_permission(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    target: Reference<'_>,
    role_id: String,
    data: Json<v0::DataSetServerRolePermission>,
) -> Result<Json<v0::Server>> {
    let data = data.into_inner();

    let mut server = target.as_server(db).await?;

    let (current_value, rank) = server
        .roles
        .get(&role_id)
        .map(|x| (x.permissions, x.rank))
        .ok_or_else(|| create_error!(NotFound))?;

    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    let permissions = calculate_server_permissions(&mut query).await;

    permissions.throw_if_lacking_channel_permission(ChannelPermission::ManagePermissions)?;

    hierarchy_policy::ensure_role_below_actor(&user, &server, query.get_member_rank(), rank)?;

    // Ensure we have access to grant these permissions forwards
    let current_value: Override = current_value.into();
    let requested_permissions = data.permissions.clone();
    permissions
        .throw_permission_override(current_value.clone(), &requested_permissions)
        .await?;

    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::ServerPermissionUpdate,
        ServerAuditLogTarget::Role {
            id: role_id.clone(),
        },
        None,
        audit_mutation::audit_changes(vec![(
            "permissions",
            audit_mutation::audit_change(Some(current_value), Some(requested_permissions.clone()))?,
        )]),
    )
    .await?;

    if let Err(error) = server
        .set_role_permission(db, &role_id, requested_permissions.into())
        .await
    {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    reconcile_server_voice_permissions(db, voice_client, &server, Some(&role_id)).await;

    audit_mutation::mark_succeeded_after_commit(db, &mut audit).await;

    Ok(Json(server.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![set_role_permission]
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

    struct ServerRolePermissionsTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl ServerRolePermissionsTestContext {
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
    async fn server_role_permission_update_writes_audit_entry() {
        let context = ServerRolePermissionsTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let role = server
            .roles
            .values()
            .find(|role| role.name == "Lower Rank 1")
            .expect("lower-ranked role")
            .clone();
        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .put(format!("/servers/{}/permissions/{}", server.id, role.id))
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
                    action: Some(ServerAuditLogAction::ServerPermissionUpdate),
                    target_type: Some("Role".to_string()),
                    target_id: Some(role.id.clone()),
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
            ServerAuditLogTarget::Role {
                id: role.id.clone()
            }
        );
        assert_eq!(
            entry.changes["permissions"].before,
            Some(json!({ "allow": 0, "deny": 0 }))
        );
        assert_eq!(
            entry.changes["permissions"].after,
            Some(json!({ "allow": 1048576, "deny": 0 }))
        );
    }
}
