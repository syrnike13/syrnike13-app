use rocket::{State, serde::json::Json};
use rocket_empty::EmptyResponse;
use syrnike_database::{
    Database, ServerAuditLogAction, ServerAuditLogTarget, User,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
};
use syrnike_models::v0;
use syrnike_permissions::{ChannelPermission, calculate_server_permissions};
use syrnike_result::{Result, create_error};
use validator::Validate;

use super::audit_mutation;

/// # Unban user
///
/// Remove a user's ban.
#[openapi(tag = "Server Members")]
#[delete("/<server>/bans/<target>", data = "<data>")]
pub async fn unban(
    db: &State<Database>,
    user: User,
    server: Reference<'_>,
    target: Reference<'_>,
    data: Option<Json<v0::DataModerationAction>>,
) -> Result<EmptyResponse> {
    let data = data
        .map(Json::into_inner)
        .unwrap_or(v0::DataModerationAction { reason: None });
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    let server = server.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::BanMembers)?;

    let ban = target.as_ban(db, &server.id).await?;
    let changes = audit_mutation::audit_changes(vec![(
        "ban",
        audit_mutation::audit_change(Some(ban.clone()), None::<syrnike_database::ServerBan>)?,
    )]);
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id,
        user.id.clone(),
        ServerAuditLogAction::MemberUnban,
        ServerAuditLogTarget::User {
            id: target.id.to_string(),
        },
        data.reason,
        changes,
    )
    .await?;

    if let Err(error) = db.delete_ban(&ban.id).await {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    audit.mark_succeeded(db).await?;
    Ok(EmptyResponse)
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![unban]
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
        ServerAuditLogTarget, ServerBan, User, fixture,
    };
    use ulid::Ulid;

    struct BanRemoveTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl BanRemoveTestContext {
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
    async fn unban_writes_audit_entry_with_reason() {
        let context = BanRemoveTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let target = User::create(&context.db, "Unbanned User".to_string(), None, None)
            .await
            .expect("target user");
        ServerBan::create(
            &context.db,
            &server,
            &target.id,
            Some("old reason".to_string()),
        )
        .await
        .expect("ban created");

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .delete(format!("/servers/{}/bans/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "reason": "appeal accepted" }).to_string())
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::NoContent);

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::MemberUnban),
                    target_type: Some("User".to_string()),
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
        assert_eq!(entries[0].reason.as_deref(), Some("appeal accepted"));
        assert_eq!(
            entries[0].target,
            ServerAuditLogTarget::User { id: target.id }
        );
    }
}
