use livekit_api::{access_token::TokenVerifier, webhooks::WebhookReceiver};
use livekit_protocol::TrackType;
use rocket::{post, State};
use rocket_empty::EmptyResponse;
use syrnike_database::{
    events::client::EventV1,
    iso8601_timestamp::{Duration, Timestamp},
    util::reference::Reference,
    voice::{
        base_voice_identity,
        call_lifecycle::{
            get_channel_voice_call, mutate_channel_voice_call_if_current, voice_call_join_effect,
            voice_call_leave_effect, VoiceCallJoinEffect, VoiceCallLeaveEffect,
            VoiceCallLeavePolicy, VoiceCallLeaveReason, VoiceCallPhase, VoiceCallStateMutation,
            VoiceCallStateMutationResult, GROUP_UNANSWERED_ACTIVE_SECONDS,
        },
        cleanup_committed_voice_member_removal, commit_voice_join,
        create_voice_call_started_system_message, delete_channel_voice_state_for_room,
        delete_voice_state_for_session, finish_voice_call_started_system_message,
        get_call_notification_recipients, get_user_moved_from_voice, get_voice_channel_members,
        is_desktop_native_voice_identity, native_voice_participant_matches_current_operation,
        publish_voice_state_snapshot, reconcile_voice_channel_members_with_call_cleanup,
        update_voice_state_tracks, update_voice_state_tracks_for_session, RoomMetadata,
        UserVoiceChannel, VoiceClient, VoiceJoinCommitResult,
    },
    Channel, Database, VoiceCallEndReason, AMQP,
};
use syrnike_result::{Result, ToSyrnikeError};

use crate::{guard::AuthHeader, webhook_body::WebhookBody};

const VOICE_CALL_MUTATION_RETRY_LIMIT: usize = 8;
const TRACK_SOURCE_SCREEN_SHARE: i32 = 3;

fn room_metadata_from_webhook(metadata: &str) -> Option<RoomMetadata> {
    let metadata = metadata.trim();
    if metadata.is_empty() {
        return None;
    }

    serde_json::from_str::<RoomMetadata>(metadata).ok()
}

fn forbidden_track_removal_identity<'a>(
    participant_identity: &'a str,
    base_user_id: &'a str,
) -> &'a str {
    if is_desktop_native_voice_identity(participant_identity) {
        participant_identity
    } else {
        base_user_id
    }
}

fn video_resolution_limit_for_track_source(
    limits: &syrnike_config::FeaturesLimits,
    track_source: i32,
) -> [u32; 2] {
    if track_source == TRACK_SOURCE_SCREEN_SHARE {
        return limits.screen_share_resolution;
    }
    limits.video_resolution
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

async fn call_channel_and_recipients(
    db: &Database,
    channel_id: &str,
) -> Result<Option<(Channel, Vec<String>)>> {
    let Ok(channel) = Reference::from_unchecked(channel_id).as_channel(db).await else {
        return Ok(None);
    };
    if channel.has_bot_recipient(db).await? {
        return Ok(None);
    }

    let recipients = match &channel {
        Channel::DirectMessage { recipients, .. } | Channel::Group { recipients, .. } => {
            recipients.clone()
        }
        _ => return Ok(None),
    };

    Ok(Some((channel, recipients)))
}

async fn voice_call_leave_policy(db: &Database, channel_id: &str) -> VoiceCallLeavePolicy {
    match Reference::from_unchecked(channel_id).as_channel(db).await {
        Ok(Channel::DirectMessage { .. }) => VoiceCallLeavePolicy::EndAfterLoneMemberTimeout {
            timeout_seconds: GROUP_UNANSWERED_ACTIVE_SECONDS,
        },
        _ => VoiceCallLeavePolicy::EndWhenEmpty,
    }
}

async fn publish_voice_call_start(
    amqp: &AMQP,
    state: syrnike_database::voice::call_lifecycle::VoiceCallState,
    notify_recipients: Vec<String>,
) {
    let started_at = state.started_at.format_short().to_string();

    EventV1::VoiceCallRinging {
        channel_id: state.channel_id.clone(),
        initiator_id: state.initiator_id.clone(),
        started_at: state.started_at,
        expires_at: state.expires_at.unwrap_or(state.started_at),
        recipients: notify_recipients.clone(),
        declined_recipients: state.declined_recipients.clone(),
    }
    .p(state.channel_id.clone())
    .await;

    if let Err(error) = amqp
        .dm_call_updated(
            &state.initiator_id,
            &state.channel_id,
            Some(&started_at),
            false,
            Some(notify_recipients),
        )
        .await
    {
        syrnike_config::capture_internal_error!(&error);
    }
}

async fn publish_voice_call_active(
    amqp: &AMQP,
    state: syrnike_database::voice::call_lifecycle::VoiceCallState,
    stop_ringing_recipients: Vec<String>,
) {
    let channel_id = state.channel_id.clone();
    let initiator_id = state.initiator_id.clone();

    EventV1::VoiceCallActive {
        channel_id: channel_id.clone(),
        initiator_id: initiator_id.clone(),
        started_at: state.started_at,
        expires_at: state.expires_at,
        declined_recipients: state.declined_recipients.clone(),
    }
    .p(channel_id.clone())
    .await;

    if !stop_ringing_recipients.is_empty() {
        if let Err(error) = amqp
            .dm_call_updated(
                &initiator_id,
                &channel_id,
                None,
                true,
                Some(stop_ringing_recipients),
            )
            .await
        {
            syrnike_config::capture_internal_error!(&error);
        }
    }
}

async fn publish_voice_call_end(
    amqp: &AMQP,
    channel_id: &str,
    initiator_id: &str,
    stop_ringing_recipients: Vec<String>,
) {
    EventV1::VoiceCallEnd {
        channel_id: channel_id.to_string(),
    }
    .p(channel_id.to_string())
    .await;

    if let Err(error) = amqp
        .dm_call_updated(
            initiator_id,
            channel_id,
            None,
            true,
            (!stop_ringing_recipients.is_empty()).then_some(stop_ringing_recipients),
        )
        .await
    {
        syrnike_config::capture_internal_error!(&error);
    }
}

async fn apply_voice_call_join(
    db: &Database,
    amqp: &AMQP,
    channel_id: &str,
    user_id: &str,
    connected_members_before_join: &[String],
    requested_recipients: Option<Vec<String>>,
    joined_at: Timestamp,
    ring_duration_seconds: i64,
) -> Result<()> {
    let Some((channel, channel_recipients)) = call_channel_and_recipients(db, channel_id).await?
    else {
        return Ok(());
    };

    for _ in 0..VOICE_CALL_MUTATION_RETRY_LIMIT {
        let existing_call = get_channel_voice_call(channel_id).await?;
        let effect = voice_call_join_effect(
            existing_call.as_ref(),
            channel_id,
            user_id,
            &channel_recipients,
            connected_members_before_join,
            requested_recipients.as_deref(),
            joined_at,
            ring_duration_seconds,
        );
        let mutation = match &effect {
            VoiceCallJoinEffect::NoChange => VoiceCallStateMutation::Noop,
            VoiceCallJoinEffect::StartRinging { state, .. }
            | VoiceCallJoinEffect::MarkActive { state, .. } => {
                VoiceCallStateMutation::Set(state.clone())
            }
        };

        if let VoiceCallStateMutationResult::Conflict(_) =
            mutate_channel_voice_call_if_current(channel_id, existing_call.as_ref(), mutation)
                .await?
        {
            continue;
        }

        match effect {
            VoiceCallJoinEffect::NoChange => {}
            VoiceCallJoinEffect::StartRinging {
                state,
                notify_recipients,
                stop_previous_ringing_recipients,
            } => {
                if let Some(previous_call) = existing_call.as_ref() {
                    if let Err(error) = finish_voice_call_started_system_message(
                        db,
                        channel_id,
                        previous_call.expires_at.unwrap_or(joined_at),
                        VoiceCallEndReason::Missed,
                    )
                    .await
                    {
                        syrnike_config::capture_internal_error!(&error);
                    }

                    publish_voice_call_end(
                        amqp,
                        channel_id,
                        &previous_call.initiator_id,
                        stop_previous_ringing_recipients,
                    )
                    .await;
                }
                if let Err(error) =
                    create_voice_call_started_system_message(db, &channel, &state.initiator_id)
                        .await
                {
                    syrnike_config::capture_internal_error!(&error);
                }
                publish_voice_call_start(amqp, state, notify_recipients).await;
            }
            VoiceCallJoinEffect::MarkActive {
                state,
                stop_ringing_recipients,
            } => {
                publish_voice_call_active(amqp, state, stop_ringing_recipients).await;
            }
        }

        return Ok(());
    }

    Err(syrnike_result::create_error!(InternalError))
}

async fn apply_voice_call_leave(
    db: &Database,
    amqp: &AMQP,
    channel_id: &str,
    reason: VoiceCallLeaveReason<'_>,
    finished_at: Timestamp,
) -> Result<()> {
    for _ in 0..VOICE_CALL_MUTATION_RETRY_LIMIT {
        let existing_call = get_channel_voice_call(channel_id).await?;
        let effect = voice_call_leave_effect(existing_call.as_ref(), reason);
        let mutation = match &effect {
            VoiceCallLeaveEffect::NoChange => return Ok(()),
            VoiceCallLeaveEffect::StartActiveDeadline(state) => {
                VoiceCallStateMutation::Set(state.clone())
            }
            VoiceCallLeaveEffect::End { .. } => VoiceCallStateMutation::Delete,
        };

        if let VoiceCallStateMutationResult::Conflict(_) =
            mutate_channel_voice_call_if_current(channel_id, existing_call.as_ref(), mutation)
                .await?
        {
            continue;
        }

        let (state, stop_ringing_recipients) = match effect {
            VoiceCallLeaveEffect::NoChange => unreachable!("NoChange returned before mutation"),
            VoiceCallLeaveEffect::StartActiveDeadline(state) => {
                EventV1::VoiceCallActive {
                    channel_id: state.channel_id.clone(),
                    initiator_id: state.initiator_id.clone(),
                    started_at: state.started_at,
                    expires_at: state.expires_at,
                    declined_recipients: state.declined_recipients.clone(),
                }
                .p(state.channel_id.clone())
                .await;
                return Ok(());
            }
            VoiceCallLeaveEffect::End {
                state,
                stop_ringing_recipients,
            } => (state, stop_ringing_recipients),
        };

        let ended_reason = if state.phase == VoiceCallPhase::Active && state.expires_at.is_none() {
            VoiceCallEndReason::Completed
        } else {
            VoiceCallEndReason::Cancelled
        };
        publish_voice_call_end(
            amqp,
            channel_id,
            &state.initiator_id,
            stop_ringing_recipients,
        )
        .await;
        if let Err(error) =
            finish_voice_call_started_system_message(db, channel_id, finished_at, ended_reason)
                .await
        {
            syrnike_config::capture_internal_error!(&error);
        }

        return Ok(());
    }

    Err(syrnike_result::create_error!(InternalError))
}

#[post("/<node>", data = "<body>")]
pub async fn ingress(
    db: &State<Database>,
    voice_client: &State<VoiceClient>,
    amqp: &State<AMQP>,
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
            let participant_identity = user_id.to_internal_error()?;
            let user_id = base_voice_identity(participant_identity);
            let participant_id = participant_id.to_internal_error()?;
            let room_id = room_id.to_internal_error()?;
            let channel = voice_channel_from_webhook(db, channel_id, room_metadata).await;

            if is_desktop_native_voice_identity(participant_identity) {
                if !native_voice_participant_matches_current_operation(
                    &channel,
                    user_id,
                    participant_identity,
                )
                .await?
                {
                    log::debug!(
                        "Removing native participant {participant_identity} from stale LiveKit join in channel {channel_id}; operation is not current."
                    );
                    let _ = voice_client
                        .remove_user(node, participant_identity, channel_id)
                        .await;
                }
                return Ok(EmptyResponse);
            }

            let joined_at = Timestamp::UNIX_EPOCH
                .checked_add(Duration::seconds(event.created_at))
                .unwrap();
            let connected_members_before_join = get_voice_channel_members(&channel)
                .await?
                .unwrap_or_default();
            let requested_recipients =
                get_call_notification_recipients(channel_id, user_id).await?;

            let VoiceJoinCommitResult::Committed {
                operation_id,
                voice_state,
                previous_channels,
            } = commit_voice_join(&channel, user_id, joined_at, participant_id, room_id).await?
            else {
                log::debug!(
                    "Removing user {user_id} from stale LiveKit join in channel {channel_id}; latest join intent targets another channel."
                );
                let _ = voice_client
                    .remove_user(node, participant_identity, channel_id)
                    .await;
                return Ok(EmptyResponse);
            };

            for previous_channel in &previous_channels {
                cleanup_committed_voice_member_removal(
                    db,
                    voice_client,
                    amqp,
                    previous_channel,
                    user_id,
                )
                .await?;
            }

            // Only publish one event when a user is moved from one channel to another.
            if let Some(moved_from) = previous_channels.first() {
                EventV1::VoiceChannelMove {
                    user: user_id.to_string(),
                    from: moved_from.id.clone(),
                    to: channel_id.to_string(),
                    operation_id,
                    state: voice_state,
                }
                .p(channel_id.to_string())
                .await;
            } else {
                EventV1::VoiceChannelJoin {
                    id: channel_id.to_string(),
                    operation_id,
                    state: voice_state,
                }
                .p(channel_id.to_string())
                .await;
            };

            apply_voice_call_join(
                db,
                amqp,
                channel_id,
                user_id,
                &connected_members_before_join,
                requested_recipients,
                joined_at,
                config.api.livekit.call_ring_duration as i64,
            )
            .await?;
        }
        // User left a channel
        "participant_left" => {
            let channel_id = channel_id.to_internal_error()?;
            let participant_identity = user_id.to_internal_error()?;
            let user_id = base_voice_identity(participant_identity);
            let participant_id = participant_id.to_internal_error()?;
            let channel = voice_channel_from_webhook(db, channel_id, room_metadata).await;

            if is_desktop_native_voice_identity(participant_identity) {
                return Ok(EmptyResponse);
            }

            if !delete_voice_state_for_session(&channel, user_id, participant_id).await? {
                log::debug!(
                    "Ignoring stale participant_left for user {user_id} in channel {channel_id} from LiveKit participant {participant_id}."
                );
                reconcile_voice_channel_members_with_call_cleanup(db, voice_client, amqp, &channel)
                    .await?;
                return Ok(EmptyResponse);
            }

            // Dont send leave event when a user is moved
            if get_user_moved_from_voice(channel_id, user_id)
                .await?
                .is_none()
            {
                EventV1::VoiceChannelLeave {
                    id: channel_id.clone(),
                    user: user_id.to_string(),
                }
                .p(channel_id.clone())
                .await;
            };

            let remaining_members = get_voice_channel_members(&channel)
                .await?
                .unwrap_or_default();
            let leave_policy = voice_call_leave_policy(db, channel_id).await;
            let finished_at = Timestamp::UNIX_EPOCH
                .checked_add(Duration::seconds(event.created_at))
                .unwrap();
            apply_voice_call_leave(
                db,
                amqp,
                channel_id,
                VoiceCallLeaveReason::ParticipantLeft {
                    remaining_members_after_leave: &remaining_members,
                    leave_policy,
                    left_at: finished_at,
                },
                finished_at,
            )
            .await?;
        }
        // Audio/video track was started/stopped/unmuted/muted
        "track_published" | "track_unpublished" | "track_unmuted" | "track_muted" => {
            let channel_id = channel_id.to_internal_error()?;
            let participant_identity = user_id.to_internal_error()?;
            let user_id = base_voice_identity(participant_identity);
            let participant_id = participant_id.to_internal_error()?;
            let track = event.track.as_ref().to_internal_error()?;
            let channel = voice_channel_from_webhook(db, channel_id, room_metadata).await;
            let is_native_participant = is_desktop_native_voice_identity(participant_identity);

            if is_native_participant
                && !native_voice_participant_matches_current_operation(
                    &channel,
                    user_id,
                    participant_identity,
                )
                .await?
            {
                log::debug!(
                    "Removing native participant {participant_identity} from stale LiveKit {} in channel {channel_id}; operation is not current.",
                    event.event
                );
                let _ = voice_client
                    .remove_user(node, participant_identity, channel_id)
                    .await;
                return Ok(EmptyResponse);
            }

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
                    let has_known_video_size = track.width > 0 && track.height > 0;
                    let video_resolution_limit =
                        video_resolution_limit_for_track_source(&user_limits, track.source);
                    if video_resolution_limit[0] != 0
                        && video_resolution_limit[1] != 0
                        && track.width * track.height
                            > video_resolution_limit[0] * video_resolution_limit[1]
                    {
                        log::debug!("User published video with out of bounds resolution");
                        disconnect = true;
                    };

                    if has_known_video_size {
                        if user_limits.video_aspect_ratio[0] != user_limits.video_aspect_ratio[1]
                            && !(user_limits.video_aspect_ratio[0]
                                ..=user_limits.video_aspect_ratio[1])
                                .contains(&(track.width as f32 / track.height as f32))
                        {
                            log::debug!("User published video with out of bounds aspect ratio");
                            disconnect = true;
                        };
                    };
                };

                if disconnect {
                    let removal_identity =
                        forbidden_track_removal_identity(participant_identity, user_id);
                    log::debug!(
                        "Removing LiveKit participant {removal_identity} for base user {user_id} from channel {channel_id} {event:?} due to forbidden track."
                    );

                    let _ = voice_client
                        .remove_user(node, removal_identity, channel_id)
                        .await;
                    if !is_native_participant
                        && delete_voice_state_for_session(&channel, user_id, participant_id).await?
                    {
                        EventV1::VoiceChannelLeave {
                            id: channel_id.clone(),
                            user: user_id.to_string(),
                        }
                        .p(channel_id.clone())
                        .await;

                        let remaining_members = get_voice_channel_members(&channel)
                            .await?
                            .unwrap_or_default();
                        let leave_policy = voice_call_leave_policy(db, channel_id).await;
                        let finished_at = Timestamp::UNIX_EPOCH
                            .checked_add(Duration::seconds(event.created_at))
                            .unwrap();
                        apply_voice_call_leave(
                            db,
                            amqp,
                            channel_id,
                            VoiceCallLeaveReason::ParticipantLeft {
                                remaining_members_after_leave: &remaining_members,
                                leave_policy,
                                left_at: finished_at,
                            },
                            finished_at,
                        )
                        .await?;
                    }

                    return Ok(EmptyResponse);
                };
            };

            let added = event.event == "track_published" || event.event == "track_unmuted";
            let state = if is_native_participant {
                update_voice_state_tracks(&channel, user_id, added, track.source).await?
            } else {
                update_voice_state_tracks_for_session(
                    &channel,
                    user_id,
                    added,
                    track.source,
                    participant_id,
                )
                .await?
            };

            let Some(state) = state else {
                log::debug!(
                    "Ignoring stale {} for user {user_id} in channel {channel_id} from LiveKit participant {participant_id}.",
                    event.event
                );
                return Ok(EmptyResponse);
            };

            publish_voice_state_snapshot(channel_id, &state).await;
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
                reconcile_voice_channel_members_with_call_cleanup(db, voice_client, amqp, &channel)
                    .await?;
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

            let finished_at = Timestamp::UNIX_EPOCH
                .checked_add(Duration::seconds(event.created_at))
                .unwrap();
            apply_voice_call_leave(
                db,
                amqp,
                channel_id,
                VoiceCallLeaveReason::RoomFinished,
                finished_at,
            )
            .await?;
        }
        _ => {}
    };

    Ok(EmptyResponse)
}

#[cfg(test)]
mod tests {
    use super::{
        forbidden_track_removal_identity, room_metadata_from_webhook,
        video_resolution_limit_for_track_source,
    };
    use std::collections::HashMap;
    use syrnike_config::FeaturesLimits;

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

    #[test]
    fn forbidden_desktop_native_track_removes_only_native_participant() {
        assert_eq!(
            forbidden_track_removal_identity("user-a:desktop-native:op-join:screen", "user-a"),
            "user-a:desktop-native:op-join:screen"
        );
    }

    #[test]
    fn forbidden_browser_track_removes_base_participant() {
        assert_eq!(
            forbidden_track_removal_identity("user-a", "user-a"),
            "user-a"
        );
    }

    fn test_limits() -> FeaturesLimits {
        FeaturesLimits {
            outgoing_friend_requests: 0,
            bots: 0,
            message_length: 0,
            message_attachments: 0,
            servers: 0,
            voice_quality: 0,
            video: true,
            video_resolution: [1280, 720],
            video_aspect_ratio: [0.3, 2.5],
            screen_share_resolution: [1920, 1080],
            screen_share_bitrate: 8_000_000,
            file_upload_size_limit: HashMap::new(),
        }
    }

    #[test]
    fn camera_track_uses_camera_video_resolution_limit() {
        assert_eq!(
            video_resolution_limit_for_track_source(&test_limits(), 1),
            [1280, 720]
        );
    }

    #[test]
    fn screen_share_track_uses_screen_share_resolution_limit() {
        assert_eq!(
            video_resolution_limit_for_track_source(&test_limits(), 3),
            [1920, 1080]
        );
    }
}
