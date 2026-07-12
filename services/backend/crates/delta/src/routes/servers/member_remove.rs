use rocket::{State, serde::json::Json};
use rocket_empty::EmptyResponse;
use syrnike_database::{
    Database, RemovalIntention, ServerAuditLogAction, ServerAuditLogTarget, User,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{
        UserVoiceChannel, cancel_current_pending_voice_join_in_server,
        get_user_voice_channel_in_server, remove_user_from_voice_channel,
    },
};
use syrnike_models::v0;
use syrnike_permissions::{ChannelPermission, calculate_server_permissions};
use syrnike_result::{Result, create_error};
use validator::Validate;

use super::audit_mutation;

/// # Kick Member
///
/// Removes a member from the server.
#[openapi(tag = "Server Members")]
#[delete("/<server_id>/members/<member_id>", data = "<data>")]
pub async fn kick(
    db: &State<Database>,
    user: User,
    server_id: Reference<'_>,
    member_id: Reference<'_>,
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

    let server = server_id.as_server(db).await?;

    if member_id.id == user.id {
        return Err(create_error!(CannotRemoveYourself));
    }

    if member_id.id == server.owner {
        return Err(create_error!(InvalidOperation));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::KickMembers)?;

    let member = member_id.as_member(db, &server.id).await?;
    if member.get_ranking(query.server_ref().as_ref().unwrap())
        <= query.get_member_rank().unwrap_or(i64::MIN)
    {
        return Err(create_error!(NotElevated));
    }

    let changes = audit_mutation::audit_changes(vec![(
        "member",
        audit_mutation::audit_change(Some(member.clone()), None::<syrnike_database::Member>)?,
    )]);
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::MemberKick,
        ServerAuditLogTarget::Member {
            user_id: member_id.id.to_string(),
        },
        data.reason,
        changes,
    )
    .await?;

    if let Err(error) = member
        .remove(db, &server, RemovalIntention::Kick, false)
        .await
    {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }

    if let Err(error) = cancel_current_pending_voice_join_in_server(member_id.id, &server.id).await
    {
        return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
    }
    let voice_channel = match get_user_voice_channel_in_server(member_id.id, &server.id).await {
        Ok(channel) => channel,
        Err(error) => {
            return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
        }
    };
    if let Some(channel_id) = voice_channel {
        if let Err(error) = remove_user_from_voice_channel(
            &UserVoiceChannel {
                id: channel_id,
                server_id: Some(server.id.clone()),
            },
            member_id.id,
        )
        .await
        {
            return audit_mutation::mark_failed_and_return(db, &mut audit, error).await;
        }
    }

    audit.mark_succeeded(db).await?;

    Ok(EmptyResponse)
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![kick]
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
        ServerAuditLogTarget, fixture,
    };
    use ulid::Ulid;

    struct MemberRemoveTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl MemberRemoveTestContext {
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
    async fn kick_writes_audit_entry_with_reason() {
        let context = MemberRemoveTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            target user 2
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;
        let response = context
            .client
            .delete(format!("/servers/{}/members/{}", server.id, target.id))
            .header(ContentType::JSON)
            .body(serde_json::json!({ "reason": "raid cleanup" }).to_string())
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
                    action: Some(ServerAuditLogAction::MemberKick),
                    target_type: Some("Member".to_string()),
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
        assert_eq!(entries[0].reason.as_deref(), Some("raid cleanup"));
        assert_eq!(
            entries[0].target,
            ServerAuditLogTarget::Member { user_id: target.id }
        );
    }
}
