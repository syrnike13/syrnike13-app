use rocket::State;
use syrnike_database::util::permissions::DatabasePermissionQuery;
use syrnike_database::Member;
use syrnike_database::{util::reference::Reference, Database, User};
use syrnike_models::v0;
use syrnike_permissions::{calculate_server_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

use rocket::serde::json::Json;
use rocket_empty::EmptyResponse;

/// # Invite Bot
///
/// Invite a bot to a server by its id.
#[openapi(tag = "Bots")]
#[post("/<target>/invite", data = "<dest>")]
pub async fn invite_bot(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    dest: Json<v0::InviteBotDestination>,
) -> Result<EmptyResponse> {
    if user.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    let bot = target.as_bot(db).await?;
    if !bot.public && bot.owner != user.id {
        return Err(create_error!(BotIsPrivate));
    }

    let bot_user = db.fetch_user(&bot.id).await?;
    let dest = dest.into_inner();
    let server = db.fetch_server(&dest.server).await?;

    let mut query = DatabasePermissionQuery::new(db, &user).server(&server);
    calculate_server_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::ManageServer)?;

    Member::create(db, &server, &bot_user, None, false)
        .await
        .map(|_| EmptyResponse)
}

#[cfg(test)]
mod test {
    use crate::{rocket, util::test::TestHarness};
    use rocket::http::{ContentType, Header, Status};
    use syrnike_database::{events::client::EventV1, Bot, Server};
    use syrnike_models::v0::{self, DataCreateServer};

    #[rocket::async_test]
    async fn invite_bot_to_server() {
        let mut harness = TestHarness::new().await;
        let (_, session, user) = harness.new_user().await;

        let (bot, _) = Bot::create(&harness.db, TestHarness::rand_string(), &user, None)
            .await
            .expect("`Bot`");

        let (server, _) = Server::create(
            &harness.db,
            DataCreateServer {
                name: TestHarness::rand_string(),
                ..Default::default()
            },
            &user,
            false,
        )
        .await
        .unwrap();

        let response = harness
            .client
            .post(format!("/bots/{}/invite", bot.id))
            .header(ContentType::JSON)
            .body(
                json!(v0::InviteBotDestination {
                    server: server.id.to_string()
                })
                .to_string(),
            )
            .header(Header::new("x-session-token", session.token.to_string()))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::NoContent);
        drop(response);

        let event = harness
            .wait_for_event(&server.id, |event| match event {
                EventV1::ServerMemberJoin { id, .. } => id == &server.id,
                _ => false,
            })
            .await;

        match event {
            EventV1::ServerMemberJoin { member, .. } => {
                assert_eq!(bot.id, member.id.user);
            }
            _ => unreachable!(),
        }
    }
}
