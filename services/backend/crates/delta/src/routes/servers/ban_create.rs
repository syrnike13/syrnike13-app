use std::time::{Duration, SystemTime};
use syrnike_database::{
    Database, Message, RemovalIntention, ServerAuditLogAction, ServerAuditLogTarget, ServerBan,
    User,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{
        UserVoiceChannel, VoiceClient, get_user_voice_channel_in_server,
        remove_user_from_voice_channel,
    },
};
use syrnike_models::v0;

use rocket::{State, serde::json::Json};
use syrnike_permissions::{ChannelPermission, calculate_server_permissions};
use syrnike_result::{Result, create_error};
use validator::Validate;

use super::audit_mutation;

/// # Ban User
///
/// Ban a user by their id.
#[openapi(tag = "Server Members")]
#[put("/<server>/bans/<target>", data = "<data>")]
pub async fn ban(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    user: User,
    server: Reference<'_>,
    target: Reference<'_>,
    data: Json<v0::DataBanCreate>,
) -> Result<Json<v0::ServerBan>> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    let server = server.as_server(db).await?;

    if target.id == user.id {
        return Err(create_error!(CannotRemoveYourself));
    }

    if target.id == server.owner {
        return Err(create_error!(InvalidOperation));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::BanMembers)?;

    // If member exists, check privileges against them
    let member = target.as_member(db, &server.id).await.ok();
    if let Some(member) = &member {
        if member.get_ranking(query.server_ref().as_ref().unwrap())
            <= query.get_member_rank().unwrap_or(i64::MIN)
        {
            return Err(create_error!(NotElevated));
        }
    }

    let changes = audit_mutation::audit_changes(vec![
        (
            "reason",
            audit_mutation::audit_change(None::<String>, data.reason.clone())?,
        ),
        (
            "delete_message_seconds",
            audit_mutation::audit_change(None::<i64>, data.delete_message_seconds)?,
        ),
    ]);
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::MemberBan,
        ServerAuditLogTarget::User {
            id: target.id.to_string(),
        },
        data.reason.clone(),
        changes,
    )
    .await?;

    if let Some(member) = member {
        if let Err(error) = member
            .remove(db, &server, RemovalIntention::Ban, false)
            .await
        {
            return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
        }

        // If the member is in a voice channel while banned kick them from the voice channel
        if voice_client.is_enabled() {
            match get_user_voice_channel_in_server(target.id, &server.id).await {
                Ok(Some(channel_id)) => {
                    if let Err(error) = remove_user_from_voice_channel(
                        voice_client,
                        &UserVoiceChannel {
                            id: channel_id,
                            server_id: Some(server.id.clone()),
                        },
                        target.id,
                    )
                    .await
                    {
                        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
                }
            }
        }
    }
    // We do this outside the member check so we can sweep hit-and-run spammers who already left.
    if let Some(seconds) = data.delete_message_seconds {
        if seconds > 0 {
            let threshold_time = SystemTime::now() - Duration::from_secs(seconds as u64);

            if let Err(error) = Message::bulk_delete_by_author_since(
                db,
                &server.channels,
                target.id,
                threshold_time,
            )
            .await
            {
                return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
            }
        }
    }
    let ban = match ServerBan::create(db, &server, target.id, data.reason).await {
        Ok(ban) => ban,
        Err(error) => return audit_mutation::mark_failed_and_return(db, &mut audit, error).await,
    };

    audit.mark_succeeded(db).await?;

    Ok(Json(ban.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![ban]
}

#[cfg(test)]
mod test {
    use std::collections::HashMap;

    use authifier::{
        Authifier,
        models::{Account, EmailVerification, Session},
    };
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::voice::VoiceClient;
    use syrnike_database::{
        Database, DatabaseInfo, ServerAuditLogAction, ServerAuditLogQuery, ServerAuditLogStatus,
        ServerAuditLogTarget, User, fixture,
    };
    use ulid::Ulid;

    struct BanCreateTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl BanCreateTestContext {
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
    async fn ban_writes_audit_entry_with_reason() {
        let context = BanCreateTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let target = User::create(&context.db, "Banned User".to_string(), None, None)
            .await
            .expect("target user");
        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .put(format!("/servers/{}/bans/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(
                serde_json::json!({
                    "reason": "spam",
                    "delete_message_seconds": 0
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

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::MemberBan),
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
        assert_eq!(entries[0].reason.as_deref(), Some("spam"));
        assert_eq!(
            entries[0].target,
            ServerAuditLogTarget::User { id: target.id }
        );
    }
}
