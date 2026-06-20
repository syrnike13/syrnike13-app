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
