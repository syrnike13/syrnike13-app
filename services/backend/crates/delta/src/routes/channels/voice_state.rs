use syrnike_database::{
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{get_channel_voice_state, UserVoiceChannel},
    Database, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};
use rocket::{serde::json::Json, State};

/// # Fetch Voice State
///
/// Fetches the current backend voice state for a channel.
#[openapi(tag = "Voice")]
#[get("/<target>/voice_state")]
pub async fn fetch(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
) -> Result<Json<v0::ChannelVoiceState>> {
    let channel = target.as_channel(db).await?;

    if channel.voice().is_none() {
        return Err(create_error!(NotAVoiceChannel));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    calculate_channel_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::Connect)?;

    Ok(Json(
        get_channel_voice_state(&UserVoiceChannel::from_channel(&channel))
            .await?
            .unwrap_or_else(|| v0::ChannelVoiceState {
                id: channel.id().to_string(),
                participants: Vec::new(),
            }),
    ))
}

#[cfg(test)]
mod test {
    use crate::{rocket, util::test::TestHarness};
    use iso8601_timestamp::Timestamp;
    use syrnike_database::{voice::create_voice_state, Channel};
    use syrnike_models::v0;
    use rocket::http::{Header, Status};

    #[rocket::async_test]
    async fn fetch_empty_voice_state() {
        let harness = TestHarness::new().await;
        let (_, session, user) = harness.new_user().await;

        let group = Channel::create_group(
            &harness.db,
            v0::DataCreateGroup {
                name: TestHarness::rand_string(),
                ..Default::default()
            },
            user.id.to_string(),
        )
        .await
        .unwrap();

        let response = harness
            .client
            .get(format!("/channels/{}/voice_state", group.id()))
            .header(Header::new("x-session-token", session.token.to_string()))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);

        let state: v0::ChannelVoiceState = response.into_json().await.expect("ChannelVoiceState");
        assert_eq!(state.id, group.id());
        assert!(state.participants.is_empty());
    }

    #[rocket::async_test]
    async fn fetch_voice_state_with_participant() {
        let harness = TestHarness::new().await;
        let (_, session, user) = harness.new_user().await;

        let group = Channel::create_group(
            &harness.db,
            v0::DataCreateGroup {
                name: TestHarness::rand_string(),
                ..Default::default()
            },
            user.id.to_string(),
        )
        .await
        .unwrap();

        create_voice_state(
            &syrnike_database::voice::UserVoiceChannel::from_channel(&group),
            &user.id,
            Timestamp::now_utc(),
        )
        .await
        .unwrap();

        let response = harness
            .client
            .get(format!("/channels/{}/voice_state", group.id()))
            .header(Header::new("x-session-token", session.token.to_string()))
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);

        let state: v0::ChannelVoiceState = response.into_json().await.expect("ChannelVoiceState");
        assert_eq!(state.id, group.id());
        assert_eq!(state.participants.len(), 1);
        assert_eq!(state.participants[0].id, user.id);
        assert!(state.participants[0].is_receiving);
        assert!(!state.participants[0].is_publishing);
        assert!(!state.participants[0].screensharing);
        assert!(!state.participants[0].camera);
    }
}
