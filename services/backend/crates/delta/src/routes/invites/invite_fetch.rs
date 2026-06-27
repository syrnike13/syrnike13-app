use rocket::{serde::json::Json, State};
use syrnike_database::{audit_timestamp, util::reference::Reference, Channel, Database, Invite};
use syrnike_models::v0;
use syrnike_result::{create_error, Result};

/// # Fetch Invite
///
/// Fetch an invite by its id.
#[openapi(tag = "Invites")]
#[get("/<target>")]
pub async fn fetch(
    db: &State<Database>,
    target: Reference<'_>,
) -> Result<Json<v0::InviteResponse>> {
    let invite = target.as_invite(db).await?;
    let now = audit_timestamp();
    if invite.is_revoked() || invite.is_expired(now) || invite.is_exhausted() {
        return Err(create_error!(InvalidInvite));
    }

    Ok(Json(match invite {
        Invite::Server {
            channel, creator, ..
        } => {
            let channel = db.fetch_channel(&channel).await?;
            if channel.has_bot_recipient(db).await? {
                return Err(create_error!(NotFound));
            }

            let user = db.fetch_user(&creator).await?;

            match channel {
                Channel::TextChannel {
                    id,
                    server,
                    name,
                    description,
                    ..
                } => {
                    let server = db.fetch_server(&server).await?;

                    v0::InviteResponse::Server {
                        code: target.id.to_string(),
                        member_count: db.fetch_member_count(&server.id).await? as i64,
                        server_id: server.id,
                        server_name: server.name,
                        server_icon: server.icon.map(|f| f.into()),
                        server_banner: server.banner.map(|f| f.into()),
                        server_flags: server.flags,
                        channel_id: id,
                        channel_name: name,
                        channel_description: description,
                        user_name: user.username,
                        user_avatar: user.avatar.map(|f| f.into()),
                    }
                }
                _ => unreachable!(),
            }
        }
        Invite::Group {
            channel, creator, ..
        } => {
            let channel = db.fetch_channel(&channel).await?;
            if channel.has_bot_recipient(db).await? {
                return Err(create_error!(NotFound));
            }

            let user = db.fetch_user(&creator).await?;

            match channel {
                Channel::Group {
                    id,
                    name,
                    description,
                    ..
                } => v0::InviteResponse::Group {
                    code: target.id.to_string(),
                    channel_id: id,
                    channel_name: name,
                    channel_description: description,
                    user_name: user.username,
                    user_avatar: user.avatar.map(|f| f.into()),
                },
                _ => unreachable!(),
            }
        }
    }))
}

#[cfg(test)]
fn routes_under_test() -> Vec<rocket::Route> {
    routes![fetch]
}

#[cfg(test)]
mod test {
    use crate::{rocket, util::test::TestHarness};
    use rocket::http::{ContentType, Status};
    use rocket::local::asynchronous::Client;
    use syrnike_database::{fixture, Channel, Database, DatabaseInfo, Server};
    use syrnike_models::v0::{
        DataCreateGroup, DataCreateServerChannel, Invite, InviteResponse, LegacyServerChannelType,
    };

    struct InviteFetchTestContext {
        client: Client,
        db: Database,
    }

    impl InviteFetchTestContext {
        async fn new() -> Self {
            let db = DatabaseInfo::Reference
                .connect()
                .await
                .expect("reference database");
            let client = Client::tracked(
                rocket::build()
                    .mount("/invites", super::routes_under_test())
                    .manage(db.clone()),
            )
            .await
            .expect("valid rocket instance");

            Self { client, db }
        }
    }

    #[rocket::async_test]
    async fn success_fetch_group_invite() {
        let harness = TestHarness::new().await;
        let (_, session, user) = harness.new_user().await;

        let group = Channel::create_group(
            &harness.db,
            DataCreateGroup {
                ..Default::default()
            },
            user.id.clone(),
        )
        .await
        .expect("`Channel`");
        let create_response = TestHarness::with_session(
            session,
            harness
                .client
                .post(format!("/channels/{}/invites", group.id()))
                .header(ContentType::JSON)
                .body(serde_json::json!({}).to_string()),
        )
        .await;
        assert_eq!(create_response.status(), Status::Ok);
        let invite_from_create: Invite = create_response.into_json().await.expect("`Invite`");
        let invite_code = match invite_from_create {
            Invite::Group { code, .. } => code,
            _ => unreachable!(),
        };
        let response = harness
            .client
            .get(format!("/invites/{}", invite_code))
            .dispatch()
            .await;
        assert_eq!(response.status(), Status::Ok);
        let invite_response: InviteResponse = response.into_json().await.expect("`FetchInvite`");
        match invite_response {
            InviteResponse::Group {
                code,
                channel_id,
                user_name,
                ..
            } => {
                assert_eq!(code, invite_code);
                assert_eq!(channel_id, group.id());
                assert_eq!(user_name, user.username);
            }
            _ => unreachable!(),
        }
    }

    #[rocket::async_test]
    async fn fail_fetch_missing_invite() {
        let harness = TestHarness::new().await;
        let response = harness
            .client
            .get(format!("/invites/{}", TestHarness::rand_string()))
            .dispatch()
            .await;
        assert_eq!(response.status(), Status::NotFound);
    }

    #[rocket::async_test]
    async fn fail_fetch_revoked_server_invite() {
        let context = InviteFetchTestContext::new().await;
        fixture!(context.db, "server_with_many_roles",
            owner user 0
            channel channel 3
            server server 4);
        let invite_code = TestHarness::rand_string();

        context
            .db
            .insert_invite(&syrnike_database::Invite::Server {
                code: invite_code.clone(),
                server: server.id,
                creator: owner.id.clone(),
                channel: channel.id().to_string(),
                created_at: 1_000,
                expires_at: None,
                max_uses: None,
                uses: 0,
                revoked_at: Some(2_000),
                revoked_by: Some(owner.id),
                temporary: false,
            })
            .await
            .expect("revoked invite inserted");

        let response = context
            .client
            .get(format!("/invites/{}", invite_code))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::BadRequest);
    }

    #[rocket::async_test]
    async fn success_fetch_text_channel_invite() {
        let harness = TestHarness::new().await;
        let (_, session, user) = harness.new_user().await;
        let (_, channels) = harness.new_server(&user).await;
        let channel = channels.first().expect("Server Channel");
        let create_response = TestHarness::with_session(
            session,
            harness
                .client
                .post(format!("/channels/{}/invites", channel.id()))
                .header(ContentType::JSON)
                .body(serde_json::json!({}).to_string()),
        )
        .await;
        assert_eq!(create_response.status(), Status::Ok);
        let invite_from_create: Invite = create_response.into_json().await.expect("`Invite`");
        let invite_code = match invite_from_create {
            Invite::Server { code, .. } => code,
            _ => unreachable!(),
        };
        let response = harness
            .client
            .get(format!("/invites/{}", invite_code))
            .dispatch()
            .await;
        assert_eq!(response.status(), Status::Ok);
        let invite_response: InviteResponse = response.into_json().await.expect("`FetchInvite`");
        match invite_response {
            InviteResponse::Server {
                code,
                channel_id,
                user_name,
                ..
            } => {
                assert_eq!(code, invite_code);
                assert_eq!(channel_id, channel.id());
                assert_eq!(user_name, user.username);
            }
            _ => unreachable!(),
        };
    }

    #[rocket::async_test]
    async fn success_fetch_voice_channel_invite() {
        let harness = TestHarness::new().await;
        let (_, session, user) = harness.new_user().await;
        let (server, _) = harness.new_server(&user).await;
        let server_mut: &mut Server = &mut server.clone();

        let channel = Channel::create_server_channel(
            &harness.db,
            server_mut,
            ulid::Ulid::new().to_string(),
            DataCreateServerChannel {
                channel_type: LegacyServerChannelType::Voice,
                name: "Voice Channel".to_string(),
                description: None,
                nsfw: Some(false),
                voice: None,
            },
            true,
        )
        .await
        .expect("Failed to make new channel");
        let create_response = TestHarness::with_session(
            session,
            harness
                .client
                .post(format!("/channels/{}/invites", channel.id()))
                .header(ContentType::JSON)
                .body(serde_json::json!({}).to_string()),
        )
        .await;
        assert_eq!(create_response.status(), Status::Ok);
        let invite_from_create: Invite = create_response.into_json().await.expect("`Invite`");
        let invite_code = match invite_from_create {
            Invite::Server { code, .. } => code,
            _ => unreachable!(),
        };
        let response = harness
            .client
            .get(format!("/invites/{}", invite_code))
            .dispatch()
            .await;
        assert_eq!(response.status(), Status::Ok);
        let invite_response: InviteResponse = response.into_json().await.expect("`FetchInvite`");
        match invite_response {
            InviteResponse::Server {
                code,
                channel_id,
                user_name,
                ..
            } => {
                assert_eq!(code, invite_code);
                assert_eq!(channel_id, channel.id());
                assert_eq!(user_name, user.username);
            }
            _ => unreachable!(),
        };
    }
}
