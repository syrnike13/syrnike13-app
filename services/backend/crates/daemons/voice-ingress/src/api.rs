use livekit_api::{access_token::TokenVerifier, webhooks::WebhookReceiver};
use livekit_protocol::TrackType;
use rocket::{post, State};
use rocket_empty::EmptyResponse;
use syrnike_database::{
    events::client::EventV1,
    iso8601_timestamp::{Duration, Timestamp},
    util::reference::Reference,
    voice::{
        create_voice_state, delete_channel_voice_state_for_room, delete_voice_state_for_session,
        get_user_moved_from_voice, get_user_moved_to_voice, get_user_voice_channels,
        get_voice_channel_members, remove_user_from_voice_channel,
        update_voice_state_tracks_for_session, user_voice_join_intent_matches, RoomMetadata,
        UserVoiceChannel, VoiceClient,
    },
    Database, AMQP,
};
use syrnike_result::{Result, ToSyrnikeError};

use crate::{guard::AuthHeader, webhook_body::WebhookBody};

fn room_metadata_from_webhook(metadata: &str) -> Option<RoomMetadata> {
    let metadata = metadata.trim();
    if metadata.is_empty() {
        return None;
    }

    serde_json::from_str::<RoomMetadata>(metadata).ok()
}

async fn voice_channel_from_webhook(
    db: &Database,
    channel_id: &str,
    room_metadata: Option<&str>,
) -> UserVoiceChannel {
    if let Ok(channel) = Reference::from_unchecked(channel_id).as_channel(db).await {
        return UserVoiceChannel::from_channel(&channel);
    }

    let server_id = room_metadata
        .and_then(room_metadata_from_webhook)
        .and_then(|metadata| metadata.server);

    UserVoiceChannel {
        id: channel_id.to_string(),
        server_id,
    }
}

#[post("/<node>", data = "<body>")]
pub async fn ingress(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    _amqp: &State<AMQP>,
    node: &str,
    auth_header: AuthHeader<'_>,
    body: WebhookBody,
) -> Result<EmptyResponse> {
    log::debug!(
        "received LiveKit webhook payload with {} bytes",
        body.as_str().len()
    );

    let config = syrnike_config::config().await;

    let node_info = config
        .api
        .livekit
        .nodes
        .get(node)
        .to_internal_error()
        .inspect_err(|_| {
            log::error!("Unknown node {node}, make sure livekit has the correct node name set and matches `hosts.livekit` and `api.livekit.nodes` in the syrnike13 config.")
        })?;

    let webhook_receiver = WebhookReceiver::new(TokenVerifier::with_api_key(
        &node_info.key,
        &node_info.secret,
    ));

    let body = body.as_str();
    let event = webhook_receiver
        .receive(body, &auth_header)
        .inspect_err(|error| {
            let prefix: String = body.chars().take(160).collect();
            log::error!(
                "Failed to receive LiveKit webhook: len={}, prefix={prefix:?}, error={error}",
                body.len()
            );
        })
        .to_internal_error()?;

    let channel_id = event.room.as_ref().map(|r| &r.name);
    let room_id = event.room.as_ref().map(|r| &r.sid);
    let user_id = event.participant.as_ref().map(|r| &r.identity);
    let participant_id = event.participant.as_ref().map(|r| &r.sid);
    let room_metadata = event.room.as_ref().map(|room| room.metadata.as_str());

    match event.event.as_str() {
        // User joined a channel
        "participant_joined" => {
            let channel_id = channel_id.to_internal_error()?;
            let user_id = user_id.to_internal_error()?;
            let participant_id = participant_id.to_internal_error()?;
            let room_id = room_id.to_internal_error()?;
            let channel = voice_channel_from_webhook(db, channel_id, room_metadata).await;

            if !user_voice_join_intent_matches(user_id, &channel).await? {
                log::debug!(
                    "Removing user {user_id} from stale LiveKit join in channel {channel_id}; latest join intent targets another channel."
                );
                let _ = voice_client.remove_user(node, user_id, channel_id).await;
                return Ok(EmptyResponse);
            }

            for previous_channel in get_user_voice_channels(user_id).await? {
                if previous_channel == channel {
                    continue;
                }
                remove_user_from_voice_channel(voice_client, &previous_channel, user_id).await?;
            }

            let joined_at = Timestamp::UNIX_EPOCH
                .checked_add(Duration::seconds(event.created_at))
                .unwrap();

            let voice_state = create_voice_state(
                &channel,
                user_id,
                joined_at,
                Some(participant_id),
                Some(room_id),
            )
            .await?;

            // Only publish one event when a user is moved from one channel to another.
            if let Some(moved_from) = get_user_moved_to_voice(channel_id, user_id).await? {
                EventV1::VoiceChannelMove {
                    user: user_id.to_string(),
                    from: moved_from.id,
                    to: channel_id.to_string(),
                    state: voice_state,
                }
                .p(channel_id.to_string())
                .await;
            } else {
                EventV1::VoiceChannelJoin {
                    id: channel_id.to_string(),
                    state: voice_state,
                }
                .p(channel_id.to_string())
                .await;
            };

            // TODO: fix `num_participants` being incorrect sometimes see (#457)
            // First user who joined - send call started system message.
            // if event.room.as_ref().unwrap().num_participants == 1 {
            //     let user = Reference::from_unchecked(user_id).as_user(db).await?;

            //     let message_id =
            //         Ulid::from_datetime(DateTime::from_timestamp_secs(event.created_at).unwrap())
            //             .to_string();

            //     let mut call_started_message = SystemMessage::CallStarted {
            //         by: user_id.to_string(),
            //         finished_at: None,
            //     }
            //     .into_message(channel.id().to_string());

            //     call_started_message.id = message_id;

            //     set_channel_call_started_system_message(channel.id(), &call_started_message.id)
            //         .await?;

            //     call_started_message
            //         .send(
            //             db,
            //             Some(amqp),
            //             v0::MessageAuthor::System {
            //                 username: &user.username,
            //                 avatar: user.avatar.as_ref().map(|file| file.id.as_ref()),
            //             },
            //             None,
            //             None,
            //             &channel,
            //             false,
            //         )
            //         .await?;

            //     let recipients = get_call_notification_recipients(&channel_id, &user_id).await?;
            //     let now = joined_at.format_short().to_string();

            //     if let Err(e) = amqp
            //         .dm_call_updated(&user.id, channel.id(), Some(&now), false, recipients)
            //         .await
            //     {
            //         syrnike_config::capture_error(&e);
            //     }
            // }
        }
        // User left a channel
        "participant_left" => {
            let channel_id = channel_id.to_internal_error()?;
            let user_id = user_id.to_internal_error()?;
            let participant_id = participant_id.to_internal_error()?;
            let channel = voice_channel_from_webhook(db, channel_id, room_metadata).await;

            if !delete_voice_state_for_session(&channel, user_id, participant_id).await? {
                log::debug!(
                    "Ignoring stale participant_left for user {user_id} in channel {channel_id} from LiveKit participant {participant_id}."
                );
                return Ok(EmptyResponse);
            }

            // Dont send leave event when a user is moved
            if get_user_moved_from_voice(channel_id, user_id)
                .await?
                .is_none()
            {
                EventV1::VoiceChannelLeave {
                    id: channel_id.clone(),
                    user: user_id.clone(),
                }
                .p(channel_id.clone())
                .await;
            };

            // See above for why this is commented out

            // // Update CallStarted system message if everyone has left with the end time
            // let members = get_voice_channel_members(channel_id).await?;

            // if members.is_none_or(|m| m.is_empty()) {
            //     // The channel is empty so send out an "end" message for ringing
            //     if let Err(e) = amqp
            //         .dm_call_updated(user_id, channel_id, None, true, None)
            //         .await
            //     {
            //         syrnike_config::capture_internal_error!(&e);
            //     }

            //     if let Some(system_message_id) =
            //         take_channel_call_started_system_message(channel_id).await?
            //     {
            //         // Could have been deleted
            //         if let Ok(mut message) = Reference::from_unchecked(&system_message_id)
            //             .as_message(db)
            //             .await
            //         {
            //             if let Some(SystemMessage::CallStarted { finished_at, .. }) =
            //                 &mut message.system
            //             {
            //                 *finished_at = Some(Timestamp::now_utc());

            //                 message
            //                     .update(
            //                         db,
            //                         PartialMessage {
            //                             system: message.system.clone(),
            //                             ..Default::default()
            //                         },
            //                         Vec::new(),
            //                     )
            //                     .await?;
            //             } else {
            //                 log::error!("Broken State: Call started message ID ({}) does not contain a CallStarted system message.", &message.id)
            //             }
            //         };
            //     };
            // }
        }
        // Audio/video track was started/stopped/unmuted/muted
        "track_published" | "track_unpublished" | "track_unmuted" | "track_muted" => {
            let channel_id = channel_id.to_internal_error()?;
            let user_id = user_id.to_internal_error()?;
            let participant_id = participant_id.to_internal_error()?;
            let track = event.track.as_ref().to_internal_error()?;
            let channel = voice_channel_from_webhook(db, channel_id, room_metadata).await;

            let user = Reference::from_unchecked(user_id).as_user(db).await?;

            let user_limits = user.limits().await;

            // forbid any size which goes over the limit and also limit the aspect ratio to stop people from making too tall or too wide and bypassing the limit.
            // TODO: figure out how to track audio stream quality

            if event.event == "track_published" {
                let mut disconnect = false;

                if track.r#type == TrackType::Data as i32 {
                    log::debug!("User published data");
                    disconnect = true;
                };

                if track.r#type == TrackType::Video as i32 {
                    if user_limits.video_resolution[0] != 0
                        && user_limits.video_resolution[1] != 0
                        && track.width * track.height
                            > user_limits.video_resolution[0] * user_limits.video_resolution[1]
                    {
                        log::debug!("User published video with out of bounds resolution");
                        disconnect = true;
                    };

                    if user_limits.video_aspect_ratio[0] != user_limits.video_aspect_ratio[1]
                        && !(user_limits.video_aspect_ratio[0]..=user_limits.video_aspect_ratio[1])
                            .contains(&(track.width as f32 / track.height as f32))
                    {
                        log::debug!("User published video with out of bounds aspect ratio");
                        disconnect = true;
                    };
                };

                if disconnect {
                    log::debug!("Removing user {user_id} from channel {channel_id} {event:?} due to forbidden track.");

                    let _ = voice_client.remove_user(node, user_id, channel_id).await;
                    if delete_voice_state_for_session(&channel, user_id, participant_id).await? {
                        EventV1::VoiceChannelLeave {
                            id: channel_id.clone(),
                            user: user_id.clone(),
                        }
                        .p(channel_id.clone())
                        .await;
                    }

                    return Ok(EmptyResponse);
                };
            };

            let Some(partial) = update_voice_state_tracks_for_session(
                &channel,
                user_id,
                event.event == "track_published" || event.event == "track_unmuted", // to avoid duplicating this entire case twice
                track.source,
                participant_id,
            )
            .await?
            else {
                log::debug!(
                    "Ignoring stale {} for user {user_id} in channel {channel_id} from LiveKit participant {participant_id}.",
                    event.event
                );
                return Ok(EmptyResponse);
            };

            EventV1::UserVoiceStateUpdate {
                id: user_id.clone(),
                channel_id: channel_id.clone(),
                data: partial,
            }
            .p(channel_id.clone())
            .await;
        }
        "room_finished" => {
            let channel_id = channel_id.to_internal_error()?;
            let room_id = room_id.to_internal_error()?;
            let channel = voice_channel_from_webhook(db, channel_id, room_metadata).await;

            let members = get_voice_channel_members(&channel)
                .await?
                .unwrap_or_default();
            if !delete_channel_voice_state_for_room(&channel, &members, room_id).await? {
                log::debug!(
                    "Ignoring stale room_finished for channel {channel_id} from LiveKit room {room_id}."
                );
                return Ok(EmptyResponse);
            }

            for user_id in members {
                EventV1::VoiceChannelLeave {
                    id: channel_id.clone(),
                    user: user_id,
                }
                .p(channel_id.clone())
                .await;
            }
        }
        _ => {}
    };

    Ok(EmptyResponse)
}

#[cfg(test)]
mod tests {
    use super::room_metadata_from_webhook;

    #[test]
    fn empty_room_metadata_is_absent_not_invalid() {
        assert_eq!(room_metadata_from_webhook(""), None);
        assert_eq!(room_metadata_from_webhook("   "), None);
    }

    #[test]
    fn valid_room_metadata_is_parsed() {
        let metadata =
            room_metadata_from_webhook(r#"{"server":"server-id"}"#).expect("room metadata");

        assert_eq!(metadata.server.as_deref(), Some("server-id"));
    }

    #[test]
    fn invalid_room_metadata_is_ignored_for_fallback_resolution() {
        assert_eq!(room_metadata_from_webhook("{"), None);
    }
}
