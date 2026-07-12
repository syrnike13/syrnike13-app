use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, Invite, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};

use rocket::{serde::json::Json, State};
use syrnike_result::{create_error, Result};
use validator::Validate;

use crate::routes::servers::audit_mutation;

/// # Create Invite
///
/// Creates an invite to this channel.
///
/// Channel must be a `TextChannel`.
#[openapi(tag = "Channel Invites")]
#[post("/<target>/invites", data = "<data>")]
pub async fn create_invite(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    data: Json<v0::DataCreateInvite>,
) -> Result<Json<v0::Invite>> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    if user.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    let channel = target.as_channel(db).await?;
    if channel.has_bot_recipient(db).await? {
        return Err(create_error!(NotFound));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    calculate_channel_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::InviteOthers)?;

    let invite = Invite::create_channel_invite(
        &user,
        &channel,
        data.max_age_seconds,
        data.max_uses,
        data.temporary.unwrap_or(false),
    )?;

    if let Invite::Server {
        code,
        server,
        channel,
        expires_at,
        max_uses,
        temporary,
        ..
    } = &invite
    {
        let changes = audit_mutation::audit_changes(vec![
            (
                "channel",
                audit_mutation::audit_change(None::<String>, Some(channel.clone()))?,
            ),
            (
                "expires_at",
                audit_mutation::audit_change(None::<u64>, *expires_at)?,
            ),
            (
                "max_uses",
                audit_mutation::audit_change(None::<u64>, *max_uses)?,
            ),
            (
                "temporary",
                audit_mutation::audit_change(None::<bool>, Some(*temporary))?,
            ),
        ]);
        let mut audit = audit_mutation::insert_pending_audit(
            db,
            server.clone(),
            user.id.clone(),
            ServerAuditLogAction::InviteCreate,
            ServerAuditLogTarget::Invite { code: code.clone() },
            data.reason,
            changes,
        )
        .await?;

        if let Err(error) = db.insert_invite(&invite).await {
            return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
        }

        audit_mutation::mark_succeeded_after_commit(db, &mut audit).await;
    } else {
        db.insert_invite(&invite).await?;
    }

    Ok(Json(invite.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![create_invite]
}

#[cfg(test)]
mod test {
    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::{
        fixture, Database, DatabaseInfo, ServerAuditLogAction, ServerAuditLogQuery,
        ServerAuditLogStatus, ServerAuditLogTarget,
    };
    use syrnike_models::v0;
    use ulid::Ulid;

    struct InviteCreateTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl InviteCreateTestContext {
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
    async fn create_server_invite_writes_audit_entry() {
        let context = InviteCreateTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            channel channel 3
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .post(format!("/channels/{}/invites", channel.id()))
            .header(ContentType::JSON)
            .body(
                serde_json::json!({
                    "max_uses": 1,
                    "reason": "short campaign"
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
        let invite: v0::Invite = response.into_json().await.expect("invite");
        let code = match invite {
            v0::Invite::Server { code, .. } => code,
            _ => unreachable!("expected server invite"),
        };

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::InviteCreate),
                    target_type: Some("Invite".to_string()),
                    target_id: Some(code.clone()),
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
        assert_eq!(entry.reason.as_deref(), Some("short campaign"));
        assert_eq!(entry.target, ServerAuditLogTarget::Invite { code });
        assert_eq!(entry.changes["max_uses"].after, Some(serde_json::json!(1)));
    }
}
