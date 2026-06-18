use syrnike_database::util::permissions::DatabasePermissionQuery;
use syrnike_database::{
    util::reference::Reference, Channel, Database, ServerAuditLogAction, ServerAuditLogTarget, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

use rocket::serde::json::Json;
use rocket::State;
use validator::Validate;

use super::audit_mutation;

/// # Create Channel
///
/// Create a new Text or Voice channel.
#[openapi(tag = "Server Information")]
#[post("/<server>/channels", data = "<data>")]
pub async fn create_server_channel(
    db: &State<Database>,
    user: User,
    server: Reference<'_>,
    data: Json<v0::DataCreateServerChannel>,
) -> Result<Json<v0::Channel>> {
    let data = data.into_inner();
    data.validate().map_err(|error| {
        create_error!(FailedValidation {
            error: error.to_string()
        })
    })?;

    let mut server = server.as_server(db).await?;
    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ManageChannel)?;

    let channel_name = data.name.clone();

    let channel = Channel::create_server_channel(db, &mut server, data, true).await?;
    let mut audit = audit_mutation::insert_pending_audit(
        db,
        server.id.clone(),
        user.id.clone(),
        ServerAuditLogAction::ChannelCreate,
        ServerAuditLogTarget::Channel {
            id: channel.id().to_string(),
        },
        None,
        audit_mutation::audit_changes(vec![(
            "name",
            audit_mutation::audit_change(None::<String>, Some(channel_name))?,
        )]),
    )
    .await?;
    audit.mark_succeeded(db).await?;

    Ok(Json(channel.into()))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![create_server_channel]
}

#[cfg(test)]
mod test {
    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use serde_json::json;
    use syrnike_database::{
        fixture, Database, DatabaseInfo, ServerAuditLogAction, ServerAuditLogQuery,
        ServerAuditLogStatus, ServerAuditLogTarget,
    };
    use syrnike_models::v0;
    use ulid::Ulid;

    struct ChannelCreateTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    impl ChannelCreateTestContext {
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
    async fn server_channel_create_writes_audit_entry() {
        let context = ChannelCreateTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            owner user 0
            server server 4);

        let (_, owner_session) = context.account_from_user(owner.id.clone()).await;

        let response = context
            .client
            .post(format!("/servers/{}/channels", server.id))
            .header(ContentType::JSON)
            .body(
                json!({
                    "type": "Text",
                    "name": "audit-channel"
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
        let channel: v0::Channel = response.into_json().await.expect("created channel");
        let channel_id = channel.id().to_string();

        let entries = context
            .db
            .fetch_server_audit_logs(
                &server.id,
                ServerAuditLogQuery {
                    action: Some(ServerAuditLogAction::ChannelCreate),
                    target_type: Some("Channel".to_string()),
                    target_id: Some(channel_id.clone()),
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
            ServerAuditLogTarget::Channel { id: channel_id }
        );
        assert_eq!(entry.changes["name"].before, None);
        assert_eq!(entry.changes["name"].after, Some(json!("audit-channel")));
    }
}
