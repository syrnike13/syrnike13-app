use rocket::{State, serde::json::Json};
use syrnike_database::{
    AMQP, Channel, Database, Invite, Member, User, audit_timestamp, util::reference::Reference,
    voice::with_temporary_voice_user_lock,
};
use syrnike_models::v0::{self, InviteJoinResponse};
use syrnike_result::{Result, create_error};

use crate::routes::voice_call_member_sync::send_active_group_voice_call_to_new_member;

/// # Join Invite
///
/// Join an invite by its ID
#[openapi(tag = "Invites")]
#[post("/<target>")]
pub async fn join(
    db: &State<Database>,
    amqp: &State<AMQP>,
    user: User,
    target: Reference<'_>,
) -> Result<Json<v0::InviteJoinResponse>> {
    if user.bot.is_some() {
        return Err(create_error!(IsBot));
    }

    user.can_acquire_server(db).await?;

    let invite = target.as_invite(db).await?;
    let now = audit_timestamp();
    if invite.is_revoked() || invite.is_expired(now) || invite.is_exhausted() {
        return Err(create_error!(InvalidInvite));
    }
    let count_invite_use = db.fetch_invite(invite.code()).await.is_ok();

    let response = match &invite {
        Invite::Server {
            server, temporary, ..
        } => join_server_invite(db, &user, server, *temporary).await,
        Invite::Group {
            channel, creator, ..
        } => {
            let mut channel = db.fetch_channel(channel).await?;
            if channel.has_bot_recipient(db).await? {
                return Err(create_error!(NotFound));
            }

            channel.add_user_to_group(db, amqp, &user, creator).await?;
            send_active_group_voice_call_to_new_member(&user.id, &channel).await?;
            if let Channel::Group { recipients, .. } = &channel {
                Ok(InviteJoinResponse::Group {
                    users: User::fetch_many_ids_as_mutuals(db, &user, recipients).await?,
                    channel: channel.into(),
                })
            } else {
                unreachable!()
            }
        }
    }?;

    if count_invite_use {
        db.increment_invite_uses(invite.code()).await?;
    }

    Ok(Json(response))
}

async fn join_server_invite(
    db: &Database,
    user: &User,
    server_id: &str,
    temporary: bool,
) -> Result<InviteJoinResponse> {
    let server = db.fetch_server(server_id).await?;
    let create_member = || Member::create(db, &server, user, None, temporary);
    let (member, channels) = if temporary {
        with_temporary_voice_user_lock(db, &user.id, create_member).await?
    } else {
        create_member().await?
    };

    Ok(InviteJoinResponse::Server {
        channels: channels.into_iter().map(|c| c.into()).collect(),
        member: member.into(),
        server: server.into(),
    })
}

#[cfg(test)]
mod test {
    use crate::util::test::TestHarness;
    use rocket::http::{ContentType, Status};
    use syrnike_database::{DatabaseInfo, Invite, Server, User};
    use syrnike_models::v0;

    async fn create_server_invite(
        harness: &TestHarness,
        session: authifier::models::Session,
        channel_id: &str,
        body: serde_json::Value,
    ) -> v0::Invite {
        let response = TestHarness::with_session(
            session,
            harness
                .client
                .post(format!("/channels/{channel_id}/invites"))
                .header(ContentType::JSON)
                .body(body.to_string()),
        )
        .await;

        assert_eq!(response.status(), Status::Ok);
        response.into_json().await.expect("invite response")
    }

    fn invite_code(invite: v0::Invite) -> String {
        match invite {
            v0::Invite::Server { code, .. } | v0::Invite::Group { code, .. } => code,
        }
    }

    #[rocket::async_test]
    async fn exhausted_server_invite_cannot_be_joined() {
        let harness = TestHarness::new().await;
        let (_, owner_session, owner) = harness.new_user().await;
        let (_, channels) = harness.new_server(&owner).await;
        let channel = channels.first().expect("server channel");
        let invite = create_server_invite(
            &harness,
            owner_session,
            channel.id(),
            serde_json::json!({ "max_uses": 1 }),
        )
        .await;
        let code = invite_code(invite);

        let (_, first_session, _) = harness.new_user().await;
        let first_response = TestHarness::with_session(
            first_session,
            harness.client.post(format!("/invites/{code}")),
        )
        .await;
        assert_eq!(first_response.status(), Status::Ok);

        let (_, second_session, _) = harness.new_user().await;
        let second_response = TestHarness::with_session(
            second_session,
            harness.client.post(format!("/invites/{code}")),
        )
        .await;
        assert_eq!(second_response.status(), Status::BadRequest);
    }

    #[rocket::async_test]
    async fn expired_server_invite_cannot_be_joined() {
        let harness = TestHarness::new().await;
        let (_, _, owner) = harness.new_user().await;
        let (server, channels) = harness.new_server(&owner).await;
        let channel = channels.first().expect("server channel");
        let code = TestHarness::rand_string();

        harness
            .db
            .insert_invite(&Invite::Server {
                code: code.clone(),
                server: server.id,
                creator: owner.id,
                channel: channel.id().to_string(),
                created_at: 0,
                expires_at: Some(1),
                max_uses: None,
                uses: 0,
                revoked_at: None,
                revoked_by: None,
                temporary: false,
            })
            .await
            .expect("expired invite inserted");

        let (_, session, _) = harness.new_user().await;
        let response =
            TestHarness::with_session(session, harness.client.post(format!("/invites/{code}")))
                .await;

        assert_eq!(response.status(), Status::BadRequest);
    }

    #[rocket::async_test]
    async fn revoked_server_invite_cannot_be_joined() {
        let harness = TestHarness::new().await;
        let (_, owner_session, owner) = harness.new_user().await;
        let (_, channels) = harness.new_server(&owner).await;
        let channel = channels.first().expect("server channel");
        let invite = create_server_invite(
            &harness,
            owner_session.clone(),
            channel.id(),
            serde_json::json!({}),
        )
        .await;
        let code = invite_code(invite);

        let delete_response = TestHarness::with_session(
            owner_session,
            harness.client.delete(format!("/invites/{code}")),
        )
        .await;
        assert_eq!(delete_response.status(), Status::Ok);

        let (_, join_session, _) = harness.new_user().await;
        let join_response = TestHarness::with_session(
            join_session,
            harness.client.post(format!("/invites/{code}")),
        )
        .await;

        assert_eq!(join_response.status(), Status::BadRequest);
    }

    #[rocket::async_test]
    async fn temporary_server_invite_marks_new_member_temporary() {
        let db = DatabaseInfo::Reference
            .connect()
            .await
            .expect("reference database");
        let owner = User::create(&db, "Owner".to_string(), None, None)
            .await
            .expect("owner created");
        let joiner = User::create(&db, "Joiner".to_string(), None, None)
            .await
            .expect("joiner created");
        let (server, _) = Server::create(
            &db,
            v0::DataCreateServer {
                name: "Server".to_string(),
                ..Default::default()
            },
            &owner,
            true,
        )
        .await
        .expect("server created");

        let response = super::join_server_invite(&db, &joiner, &server.id, true)
            .await
            .expect("server invite joined");
        assert!(matches!(response, v0::InviteJoinResponse::Server { .. }));

        let member = db
            .fetch_member(&server.id, &joiner.id)
            .await
            .expect("temporary member fetched");

        assert!(member.temporary);
    }
}
