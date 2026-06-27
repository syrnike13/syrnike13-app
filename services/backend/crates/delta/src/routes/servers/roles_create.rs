use rocket::{State, serde::json::Json};
use syrnike_config::config;
use syrnike_database::{
    Database, Role, ServerAuditLogAction, ServerAuditLogTarget, User,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
};
use syrnike_models::v0;
use syrnike_permissions::{ChannelPermission, calculate_server_permissions};
use syrnike_result::{Result, create_error};
use ulid::Ulid;
use validator::Validate;

use super::audit_mutation;

/// # Create Role
///
/// Creates a new server role.
#[openapi(tag = "Server Permissions")]
#[post("/<target>/roles", data = "<data>")]
pub async fn create(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    data: Json<v0::DataCreateRole>,
) -> Result<Json<v0::NewRoleResponse>> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    let server = target.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ManageRole)?;

    let config = config().await;
    if server.roles.len() >= config.features.limits.global.server_roles {
        return Err(create_error!(TooManyRoles {
            max: config.features.limits.global.server_roles,
        }));
    };

    let changes = audit_mutation::audit_changes(vec![(
        "name",
        audit_mutation::audit_change(None::<String>, Some(data.name.clone()))?,
    )]);
    let role_id = Ulid::new().to_string();
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::RoleCreate,
        ServerAuditLogTarget::Role {
            id: role_id.clone(),
        },
        None,
        changes,
    )
    .await?;

    let role = match Role::create_with_id(db, &server, role_id, data.name).await {
        Ok(role) => role,
        Err(error) => return audit_mutation::mark_failed_and_return(db, &mut audit, error).await,
    };
    audit.mark_succeeded(db).await?;

    Ok(Json(v0::NewRoleResponse {
        id: role.id.clone(),
        role: role.into(),
    }))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![create]
}

#[cfg(test)]
mod test {
    use authifier::{
        Authifier,
        models::{Account, EmailVerification, Session},
    };
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::{
        Database, DatabaseInfo, ServerAuditLogAction, ServerAuditLogQuery, ServerAuditLogStatus,
        ServerAuditLogTarget, fixture,
    };
    use syrnike_models::v0;
    use ulid::Ulid;

    struct RoleCreateTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl RoleCreateTestContext {
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
                    .manage(db.clone()),
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
    async fn create_role_audit_targets_created_role() {
        let context = RoleCreateTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;

        let response = context
            .client
            .post(format!("/servers/{}/roles", server.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::DataCreateRole {
                    name: "Audited Created Role".to_string(),
                    rank: None,
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
        let created: v0::NewRoleResponse = response.into_json().await.expect("created role");

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::RoleCreate),
                    target_type: Some("Role".to_string()),
                    target_id: Some(created.id.clone()),
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
                id: created.id.clone()
            }
        );
        assert_eq!(entry.changes["name"].before, None);
        assert_eq!(
            entry.changes["name"].after,
            Some(json!("Audited Created Role"))
        );
    }
}
