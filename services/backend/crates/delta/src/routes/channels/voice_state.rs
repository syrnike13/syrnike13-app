use rocket::{serde::json::Json, State};
use syrnike_database::{
    events::client::EventV1,
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    voice::{get_channel_voice_state, get_voice_state, update_voice_state, UserVoiceChannel},
    Database, User,
};
use syrnike_models::v0;
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission};
use syrnike_result::{create_error, Result};

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

/// # Update Voice State
///
/// Updates the authenticated user's voice state in a channel (e.g. deafen).
#[openapi(tag = "Voice")]
#[patch("/<target>/voice_state", data = "<data>")]
pub async fn update(
    db: &State<Database>,
    user: User,
    target: Reference<'_>,
    data: Json<v0::PartialUserVoiceState>,
) -> Result<Json<v0::UserVoiceState>> {
    let channel = target.as_channel(db).await?;

    if channel.voice().is_none() {
        return Err(create_error!(NotAVoiceChannel));
    }

    let mut query = DatabasePermissionQuery::new(db, &user).channel(&channel);
    calculate_channel_permissions(&mut query)
        .await
        .throw_if_lacking_channel_permission(ChannelPermission::Connect)?;

    let user_voice_channel = UserVoiceChannel::from_channel(&channel);

    if get_voice_state(&user_voice_channel, &user.id)
        .await?
        .is_none()
    {
        return Err(create_error!(NotConnected));
    }

    let data = data.into_inner();
    let requested_publishing = data.is_publishing;
    let partial = client_voice_state_patch(&user.id, data);

    if partial.is_none() && requested_publishing.is_none() {
        return Err(create_error!(InvalidOperation));
    }

    if let Some(partial) = partial {
        update_voice_state(&user_voice_channel, &user.id, &partial).await?;

        EventV1::UserVoiceStateUpdate {
            id: user.id.clone(),
            channel_id: channel.id().to_string(),
            data: partial,
        }
        .p(channel.id().to_string())
        .await;
    }

    let updated = get_voice_state(&user_voice_channel, &user.id)
        .await?
        .ok_or_else(|| create_error!(InternalError))?;

    Ok(Json(updated))
}

fn client_voice_state_patch(
    user_id: &str,
    data: v0::PartialUserVoiceState,
) -> Option<v0::PartialUserVoiceState> {
    data.is_receiving
        .map(|is_receiving| v0::PartialUserVoiceState {
            id: Some(user_id.to_string()),
            is_receiving: Some(is_receiving),
            ..Default::default()
        })
}

#[cfg(test)]
mod test {
    use crate::{rocket, util::test::TestHarness};
    use iso8601_timestamp::Timestamp;
    use rocket::http::{Header, Status};
    use syrnike_database::{
        voice::{
            create_voice_state, delete_channel_voice_state_for_room,
            delete_voice_state_for_session, get_voice_state, set_user_voice_join_intent,
            update_voice_state_tracks_for_session, user_voice_join_intent_matches,
            UserVoiceChannel,
        },
        Channel,
    };
    use syrnike_models::v0;

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
            None,
            None,
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
        assert!(!state.participants[0].server_muted);
        assert!(!state.participants[0].server_deafened);
        assert!(!state.participants[0].screensharing);
        assert!(!state.participants[0].camera);
    }

    #[rocket::async_test]
    async fn update_voice_state_deafen() {
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
            None,
            None,
        )
        .await
        .unwrap();

        let response = harness
            .client
            .patch(format!("/channels/{}/voice_state", group.id()))
            .header(Header::new("x-session-token", session.token.to_string()))
            .json(&v0::PartialUserVoiceState {
                is_receiving: Some(false),
                ..Default::default()
            })
            .dispatch()
            .await;

        assert_eq!(response.status(), Status::Ok);

        let updated: v0::UserVoiceState = response.into_json().await.expect("UserVoiceState");
        assert!(!updated.is_receiving);
    }

    #[test]
    fn client_voice_state_patch_ignores_publishing_state() {
        let partial = super::client_voice_state_patch(
            "user-id",
            v0::PartialUserVoiceState {
                is_publishing: Some(true),
                is_receiving: Some(false),
                ..Default::default()
            },
        )
        .expect("trusted patch");

        assert_eq!(partial.id.as_deref(), Some("user-id"));
        assert_eq!(partial.is_receiving, Some(false));
        assert_eq!(partial.is_publishing, None);

        assert!(super::client_voice_state_patch(
            "user-id",
            v0::PartialUserVoiceState {
                is_publishing: Some(true),
                ..Default::default()
            },
        )
        .is_none());
    }

    #[rocket::async_test]
    async fn latest_voice_join_intent_rejects_previous_channel() {
        let user_id = ulid::Ulid::new().to_string();
        let previous_channel = UserVoiceChannel {
            id: ulid::Ulid::new().to_string(),
            server_id: None,
        };
        let latest_channel = UserVoiceChannel {
            id: ulid::Ulid::new().to_string(),
            server_id: None,
        };

        set_user_voice_join_intent(&user_id, &latest_channel)
            .await
            .unwrap();

        assert!(user_voice_join_intent_matches(&user_id, &latest_channel)
            .await
            .unwrap());
        assert!(!user_voice_join_intent_matches(&user_id, &previous_channel)
            .await
            .unwrap());
    }

    #[rocket::async_test]
    async fn missing_voice_join_intent_allows_known_voice_reconnect() {
        let user_id = ulid::Ulid::new().to_string();
        let channel = UserVoiceChannel {
            id: ulid::Ulid::new().to_string(),
            server_id: None,
        };
        create_voice_state(
            &channel,
            &user_id,
            Timestamp::now_utc(),
            Some("PA"),
            Some("RM"),
        )
        .await
        .unwrap();

        assert!(user_voice_join_intent_matches(&user_id, &channel)
            .await
            .unwrap());
    }

    #[rocket::async_test]
    async fn voice_leave_clears_join_intent_for_stale_rejoin() {
        let user_id = ulid::Ulid::new().to_string();
        let channel = UserVoiceChannel {
            id: ulid::Ulid::new().to_string(),
            server_id: None,
        };

        set_user_voice_join_intent(&user_id, &channel)
            .await
            .unwrap();
        create_voice_state(
            &channel,
            &user_id,
            Timestamp::now_utc(),
            Some("PA"),
            Some("RM"),
        )
        .await
        .unwrap();
        delete_voice_state_for_session(&channel, &user_id, "PA")
            .await
            .unwrap();

        assert!(!user_voice_join_intent_matches(&user_id, &channel)
            .await
            .unwrap());
    }

    #[rocket::async_test]
    async fn stale_livekit_session_cannot_delete_current_voice_state() {
        let channel = UserVoiceChannel {
            id: format!("voice-session-{}", ulid::Ulid::new()),
            server_id: None,
        };
        let user_id = format!("voice-user-{}", ulid::Ulid::new());

        create_voice_state(
            &channel,
            &user_id,
            Timestamp::UNIX_EPOCH
                .checked_add(iso8601_timestamp::Duration::seconds(1))
                .unwrap(),
            Some("PA_old"),
            Some("RM_old"),
        )
        .await
        .unwrap();
        create_voice_state(
            &channel,
            &user_id,
            Timestamp::UNIX_EPOCH
                .checked_add(iso8601_timestamp::Duration::seconds(2))
                .unwrap(),
            Some("PA_current"),
            Some("RM_current"),
        )
        .await
        .unwrap();

        let deleted = delete_voice_state_for_session(&channel, &user_id, "PA_old")
            .await
            .unwrap();

        assert!(!deleted);
        assert_eq!(
            get_voice_state(&channel, &user_id)
                .await
                .unwrap()
                .expect("current state")
                .joined_at,
            Timestamp::UNIX_EPOCH
                .checked_add(iso8601_timestamp::Duration::seconds(2))
                .unwrap()
        );
    }

    #[rocket::async_test]
    async fn stale_livekit_session_cannot_update_current_voice_tracks() {
        let channel = UserVoiceChannel {
            id: format!("voice-session-{}", ulid::Ulid::new()),
            server_id: None,
        };
        let user_id = format!("voice-user-{}", ulid::Ulid::new());

        create_voice_state(
            &channel,
            &user_id,
            Timestamp::now_utc(),
            Some("PA_current"),
            Some("RM_current"),
        )
        .await
        .unwrap();
        update_voice_state_tracks_for_session(&channel, &user_id, true, 2, "PA_current")
            .await
            .unwrap()
            .expect("current session update");

        let stale_update =
            update_voice_state_tracks_for_session(&channel, &user_id, false, 2, "PA_old")
                .await
                .unwrap();

        assert!(stale_update.is_none());
        assert!(
            get_voice_state(&channel, &user_id)
                .await
                .unwrap()
                .expect("current state")
                .is_publishing
        );
    }

    #[rocket::async_test]
    async fn stale_livekit_room_cannot_delete_current_channel_voice_state() {
        let channel = UserVoiceChannel {
            id: format!("voice-room-{}", ulid::Ulid::new()),
            server_id: None,
        };
        let user_id = format!("voice-user-{}", ulid::Ulid::new());
        let members = vec![user_id.clone()];

        create_voice_state(
            &channel,
            &user_id,
            Timestamp::now_utc(),
            Some("PA_current"),
            Some("RM_current"),
        )
        .await
        .unwrap();

        let deleted = delete_channel_voice_state_for_room(&channel, &members, "RM_old")
            .await
            .unwrap();

        assert!(!deleted);
        assert!(get_voice_state(&channel, &user_id).await.unwrap().is_some());
    }
}
