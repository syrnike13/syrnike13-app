use revolt_okapi::openapi3::OpenApi;
use revolt_rocket_okapi::{
    r#gen::OpenApiGenerator,
    request::{OpenApiFromRequest, RequestHeaderInput},
};
use rocket::{
    request::{FromRequest, Outcome},
    Request, Route,
};
use syrnike_database::AMQP;

mod channel_ack;
mod channel_delete;
mod channel_edit;
mod channel_fetch;
mod group_add_member;
mod group_create;
mod group_remove_member;
mod invite_create;
mod members_fetch;
mod message_bulk_delete;
mod message_clear_reactions;
mod message_delete;
mod message_edit;
mod message_fetch;
mod message_pin;
mod message_query;
mod message_react;
mod message_search;
mod message_send;
mod message_unpin;
mod message_unreact;
mod permissions_set;
mod permissions_set_default;
mod permissions_set_user;
mod voice_call_cleanup;
mod voice_cancel_call;
mod voice_decline_call;
mod webhook_create;
mod webhook_fetch_all;

pub(crate) struct OptionalAmqp<'r>(Option<&'r AMQP>);

impl OptionalAmqp<'_> {
    pub(crate) fn required(&self, context: &str) -> &AMQP {
        self.0.expect(context)
    }
}

#[rocket::async_trait]
impl<'r> FromRequest<'r> for OptionalAmqp<'r> {
    type Error = ();

    async fn from_request(request: &'r Request<'_>) -> rocket::request::Outcome<Self, Self::Error> {
        Outcome::Success(Self(request.rocket().state::<AMQP>()))
    }
}

impl<'r> OpenApiFromRequest<'r> for OptionalAmqp<'r> {
    fn from_request_input(
        _gen: &mut OpenApiGenerator,
        _name: String,
        _required: bool,
    ) -> revolt_rocket_okapi::Result<RequestHeaderInput> {
        Ok(RequestHeaderInput::None)
    }
}

pub fn routes() -> (Vec<Route>, OpenApi) {
    openapi_get_routes_spec![
        channel_ack::ack,
        channel_fetch::fetch,
        members_fetch::fetch_members,
        channel_delete::delete,
        channel_edit::edit,
        invite_create::create_invite,
        message_send::message_send,
        message_query::query,
        message_search::search,
        message_pin::message_pin,
        message_fetch::fetch,
        message_edit::edit,
        message_bulk_delete::bulk_delete_messages,
        message_delete::delete,
        message_unpin::message_unpin,
        group_create::create_group,
        group_add_member::add_member,
        group_remove_member::remove_member,
        voice_cancel_call::cancel_call,
        voice_decline_call::decline_call,
        permissions_set::set_role_permissions,
        permissions_set_default::set_default_channel_permissions,
        permissions_set_user::set_user_permissions,
        message_react::react_message,
        message_unreact::unreact_message,
        message_clear_reactions::clear_reactions,
        webhook_create::create_webhook,
        webhook_fetch_all::fetch_webhooks,
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
    use syrnike_models::v0;
    use syrnike_permissions::{ChannelPermission, OverrideField};
    use ulid::Ulid;

    struct ChannelWebhookRoutesTestContext {
        client: Client,
        db: Database,
        authifier: Authifier,
    }

    async fn grant_moderator_manage_webhooks(
        context: &ChannelWebhookRoutesTestContext,
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

    impl ChannelWebhookRoutesTestContext {
        async fn new() -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let authifier = db.clone().to_authifier().await;
            let client = Client::tracked(
                rocket::build()
                    .mount(
                        "/channels",
                        routes![
                            super::webhook_create::create_webhook,
                            super::webhook_fetch_all::fetch_webhooks,
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
    async fn webhook_create_requires_manage_webhooks() {
        let context = ChannelWebhookRoutesTestContext::new().await;

        fixture!(context.db, "server_with_many_roles",
            moderator user 1
            member user 2
            channel channel 3
            server server 4);
        let mut server = server;
        grant_moderator_manage_webhooks(&context, &mut server).await;

        let (_, member_session) = context.account_from_user(member.id.clone()).await;
        let response = context
            .client
            .post(format!("/channels/{}/webhooks", channel.id()))
            .header(ContentType::JSON)
            .body(json!({ "name": "Alerts" }).to_string())
            .header(Header::new(
                "x-session-token",
                member_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);

        let (_, moderator_session) = context.account_from_user(moderator.id.clone()).await;
        let response = context
            .client
            .post(format!("/channels/{}/webhooks", channel.id()))
            .header(ContentType::JSON)
            .body(json!({ "name": "Alerts" }).to_string())
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        let webhook: v0::Webhook = response.into_json().await.expect("created webhook");
        assert_eq!(webhook.creator_id, moderator.id);
        assert_eq!(webhook.channel_id, channel.id());
    }

    #[rocket::async_test]
    async fn webhook_list_requires_manage_webhooks() {
        let context = ChannelWebhookRoutesTestContext::new().await;

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
            .get(format!("/channels/{}/webhooks", channel.id()))
            .header(Header::new(
                "x-session-token",
                member_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Forbidden);

        let (_, moderator_session) = context.account_from_user(moderator.id).await;
        let response = context
            .client
            .get(format!("/channels/{}/webhooks", channel.id()))
            .header(Header::new(
                "x-session-token",
                moderator_session.token.to_string(),
            ))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);
        let webhooks: Vec<v0::Webhook> = response.into_json().await.expect("webhook list");
        assert_eq!(webhooks.len(), 1);
        assert_eq!(webhooks[0].id, webhook.id);
    }
}
