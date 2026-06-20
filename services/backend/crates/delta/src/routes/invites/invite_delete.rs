use rocket::{State, serde::json::Json};
use rocket_empty::EmptyResponse;
use syrnike_database::{
    Database, Invite, ServerAuditLogAction, ServerAuditLogTarget, User, audit_timestamp,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
};
use syrnike_models::v0;
use syrnike_permissions::{ChannelPermission, calculate_server_permissions};
use syrnike_result::{Result, create_error};
use validator::Validate;

use crate::routes::servers::audit_mutation;

/// # Delete Invite
///
/// Delete an invite by its id.
#[openapi(tag = "Invites")]
#[delete("/<target>", data = "<data>")]
pub async fn delete(
    db: &State<Database>,
    user: User,
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

    let invite = target.as_invite(db).await?;

    match invite {
        Invite::Server {
            code,
            server,
            creator,
            revoked_at,
            revoked_by,
            ..
        } => {
            if user.id != creator {
                let server = db.fetch_server(&server).await?;
                let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
                calculate_server_permissions(&mut query)
                    .await
                    .throw_if_lacking_channel_permission(ChannelPermission::ManageServer)?;
            }

            let now = audit_timestamp();
            let changes = audit_mutation::audit_changes(vec![
                (
                    "revoked_at",
                    audit_mutation::audit_change(revoked_at, Some(now))?,
                ),
                (
                    "revoked_by",
                    audit_mutation::audit_change(revoked_by, Some(user.id.clone()))?,
                ),
            ]);
            let mut audit = audit_mutation::insert_pending_audit(
                db,
                server,
                user.id.clone(),
                ServerAuditLogAction::InviteRevoke,
                ServerAuditLogTarget::Invite { code: code.clone() },
                data.reason,
                changes,
            )
            .await?;

            if let Err(error) = db.revoke_invite(&code, now, &user.id).await {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }

            audit.mark_succeeded(db).await
        }
        Invite::Group { code, creator, .. } => {
            if user.id != creator {
                return Err(create_error!(NotOwner));
            }

            db.delete_invite(&code).await
        }
    }
    .map(|_| EmptyResponse)
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![delete]
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
        Database, DatabaseInfo, Invite, ServerAuditLogAction, ServerAuditLogQuery,
        ServerAuditLogStatus, ServerAuditLogTarget, fixture,
    };
    use ulid::Ulid;

    struct InviteDeleteTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl InviteDeleteTestContext {
        async fn new() -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let authifier = db.clone().to_authifier().await;
            let client = Client::tracked(
                rocket::build()
                    .mount("/invites", super::routes_under_test())
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
    async fn delete_server_invite_revokes_and_writes_audit_entry() {
        let context = InviteDeleteTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            channel channel 3
            server server 4);

        let code = "invite-delete-audit".to_string();
        context
            .db
            .insert_invite(&Invite::Server {
                code: code.clone(),
                server: server.id.clone(),
                creator: owner.id.clone(),
                channel: channel.id().to_string(),
                created_at: 1_000,
                expires_at: None,
                max_uses: None,
                uses: 0,
                revoked_at: None,
                revoked_by: None,
                temporary: false,
            })
            .await
            .expect("invite inserted");

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .delete(format!("/invites/{code}"))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "reason": "rotated link" }).to_string())
            .header(Header::new(
                "x-session-token",
                owner_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::NoContent);

        let invite = context.db.fetch_invite(&code).await.expect("invite");
        match invite {
            Invite::Server {
                revoked_at,
                revoked_by,
                ..
            } => {
                assert!(revoked_at.is_some());
                assert_eq!(revoked_by.as_deref(), Some(owner.id.as_str()));
            }
            _ => unreachable!("expected server invite"),
        }

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::InviteRevoke),
                    target_type: Some("Invite".to_string()),
                    target_id: Some(code.clone()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .await
            .expect("audit entries fetched");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].actor_id, owner.id);
        assert_eq!(entries[0].status, ServerAuditLogStatus::Succeeded);
        assert_eq!(entries[0].reason.as_deref(), Some("rotated link"));
        assert_eq!(entries[0].target, ServerAuditLogTarget::Invite { code });
    }
}
