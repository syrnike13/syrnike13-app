use rocket::{serde::json::Json, State};
use syrnike_database::{Database, PartialUser, User};
use syrnike_models::v0;
use syrnike_result::Result;

/// # Fetch Privacy Settings
///
/// Retrieve who can send you direct messages and friend requests.
#[openapi(tag = "User Information")]
#[get("/@me/privacy")]
pub async fn fetch(user: User) -> Result<Json<v0::UserPrivacy>> {
    Ok(Json(user.privacy().into()))
}

/// # Edit Privacy Settings
///
/// Replace who can send you direct messages and friend requests.
#[openapi(tag = "User Information")]
#[put("/@me/privacy", data = "<data>")]
pub async fn edit(
    db: &State<Database>,
    user: User,
    data: Json<v0::UserPrivacy>,
) -> Result<Json<v0::UserPrivacy>> {
    let mut privacy: syrnike_database::UserPrivacy = data.into_inner().into();
    privacy.dm_restricted_servers.sort();
    privacy.dm_restricted_servers.dedup();

    db.update_user(
        &user.id,
        &PartialUser {
            privacy: Some(privacy.clone()),
            ..Default::default()
        },
        vec![],
    )
    .await?;

    Ok(Json(privacy.into()))
}

#[cfg(test)]
mod test {
    use rocket::http::{ContentType, Header, Status};
    use syrnike_models::v0;

    use crate::{rocket, util::test::TestHarness};

    #[rocket::async_test]
    async fn privacy_settings_round_trip() {
        let harness = TestHarness::new().await;
        let (_, session, _) = harness.new_user().await;

        let privacy = v0::UserPrivacy {
            dm_restricted_servers: vec!["server-b".to_string(), "server-a".to_string()],
            restrict_dms_in_new_servers: true,
            friend_requests: v0::FriendRequestPrivacy {
                everyone: false,
                friends_of_friends: true,
                server_members: false,
            },
        };

        let response = harness
            .client
            .put("/users/@me/privacy")
            .header(Header::new("x-session-token", session.token.to_string()))
            .header(ContentType::JSON)
            .body(json!(privacy).to_string())
            .dispatch()
            .await;
        assert_eq!(response.status(), Status::Ok);
        drop(response);

        let response = harness
            .client
            .get("/users/@me/privacy")
            .header(Header::new("x-session-token", session.token.to_string()))
            .dispatch()
            .await;
        let stored: v0::UserPrivacy = response.into_json().await.expect("privacy");
        assert_eq!(
            stored.dm_restricted_servers,
            vec!["server-a".to_string(), "server-b".to_string()]
        );
        assert!(stored.restrict_dms_in_new_servers);
        assert!(!stored.friend_requests.everyone);
    }
}
