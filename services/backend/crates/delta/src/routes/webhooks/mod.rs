use revolt_okapi::openapi3::OpenApi;
use rocket::Route;

mod webhook_delete;
mod webhook_delete_message;
mod webhook_delete_token;
mod webhook_edit;
mod webhook_edit_message;
mod webhook_edit_token;
mod webhook_execute;
mod webhook_execute_github;
mod webhook_fetch;
mod webhook_fetch_token;

pub fn routes() -> (Vec<Route>, OpenApi) {
    openapi_get_routes_spec![
        webhook_delete_message::webhook_delete_message,
        webhook_delete_token::webhook_delete_token,
        webhook_delete::webhook_delete,
        webhook_edit_message::webhook_edit_message,
        webhook_edit_token::webhook_edit_token,
        webhook_edit::webhook_edit,
        webhook_execute_github::webhook_execute_github,
        webhook_execute::webhook_execute,
        webhook_fetch_token::webhook_fetch_token,
        webhook_fetch::webhook_fetch,
    ]
}

#[cfg(test)]
mod tests {
    use authifier::{
        models::{Account, EmailVerification, Session},
        Authifier,
    };
    use rocket::http::{ContentType, Header, Status};
    use rocket::local::asynchronous::Client;
    use serde_json::json;
    use syrnike_database::{fixture, Database, DatabaseInfo, Server, Webhook};
    use syrnike_permissions::{ChannelPermission, OverrideField};
    use ulid::Ulid;

    struct WebhookRoutesTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    async fn grant_moderator_manage_webhooks(
        context: &WebhookRoutesTestContext,
        server: &mut Server,
    ) {
        let role_id = server
            .roles
            .values()
            .find(|role| role.name == "Moderator")
            .expect("moderator role")
            .id
            .clone();

        server
            .set_role_permission(
                &context.db,
                &role_id,
                OverrideField {
                    a: ChannelPermission::ManageWebhooks as i64,
                    d: 0,
                },
            )
            .await
            .expect("moderator can manage webhooks");
    }

    impl WebhookRoutesTestContext {
        async fn new() -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let authifier = db.clone().to_authifier().await;
            let client = Client::tracked(
                rocket::build()
                    .mount(
                        "/webhooks",
                        routes![
                            super::webhook_edit::webhook_edit,
                            super::webhook_delete::webhook_delete,
                        ],
                    )
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
    async fn webhook_edit_requires_manage_webhooks() {
        let context = WebhookRoutesTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            moderator user 1
            member user 2
            channel channel 3
            server server 4);
        let mut server = server;
        grant_moderator_manage_webhooks(&context, &mut server).await;

        let webhook = Webhook {
            id: Ulid::new().to_string(),
            name: "Alerts".to_string(),
            creator_id: moderator.id.clone(),
            channel_id: channel.id().to_string(),
            permissions: 0,
            token: Some("token".to_string()),
            avatar: None,
        };
        context
            .db
            .insert_webhook(&webhook)
            .await
            .expect("webhook inserted");

        let (_, member_session) = context.account_from_user(member.id.clone()).await;
        let response = context
            .client
            .patch(format!("/webhooks/{}", webhook.id))
            .header(ContentType::JSON)
            .body(json!({ "name": "Renamed" }).to_string())
            .header(Header::new(
                "x-session-token",
                member_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);
        let fetched = context
            .db
            .fetch_webhook(&webhook.id)
            .await
            .expect("webhook fetched");
        assert_eq!(fetched.name, "Alerts");

        let (_, moderator_session) = context.account_from_user(moderator.id).await;
        let response = context
            .client
            .patch(format!("/webhooks/{}", webhook.id))
            .header(ContentType::JSON)
            .body(json!({ "name": "Renamed" }).to_string())
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        let fetched = context
            .db
            .fetch_webhook(&webhook.id)
            .await
            .expect("webhook fetched");
        assert_eq!(fetched.name, "Renamed");
    }

    #[rocket::async_test]
    async fn webhook_delete_requires_manage_webhooks() {
        let context = WebhookRoutesTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            moderator user 1
            member user 2
            channel channel 3
            server server 4);
        let mut server = server;
        grant_moderator_manage_webhooks(&context, &mut server).await;

        let webhook = Webhook {
            id: Ulid::new().to_string(),
            name: "Alerts".to_string(),
            creator_id: moderator.id.clone(),
            channel_id: channel.id().to_string(),
            permissions: 0,
            token: Some("token".to_string()),
            avatar: None,
        };
        context
            .db
            .insert_webhook(&webhook)
            .await
            .expect("webhook inserted");

        let (_, member_session) = context.account_from_user(member.id.clone()).await;
        let response = context
            .client
            .delete(format!("/webhooks/{}", webhook.id))
            .header(Header::new(
                "x-session-token",
                member_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);
        context
            .db
            .fetch_webhook(&webhook.id)
            .await
            .expect("webhook still exists");

        let (_, moderator_session) = context.account_from_user(moderator.id).await;
        let response = context
            .client
            .delete(format!("/webhooks/{}", webhook.id))
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::NoContent);
        assert!(context.db.fetch_webhook(&webhook.id).await.is_err());
    }
}
