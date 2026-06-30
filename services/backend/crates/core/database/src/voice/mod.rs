use std::fmt::{Display, Write};

use serde::{Deserialize, Serialize};

use crate::{
    events::client::EventV1,
    models::{Channel, Message, PartialMessage, SystemMessage, User, VoiceCallEndReason},
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, Server,
};
use iso8601_timestamp::Timestamp;
use livekit_protocol::{participant_info, ParticipantInfo, ParticipantPermission};
use redis_kiss::{
    get_connection as _get_connection,
    redis::{cmd, FromRedisValue, Pipeline, RedisError, RedisWrite, ToRedisArgs, Value},
    AsyncCommands, Conn,
};
use syrnike_config::FeaturesLimits;
use syrnike_models::v0::{self, PartialUserVoiceState, UserVoiceState};
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission, PermissionValue};
use syrnike_result::{create_error, Result, ToSyrnikeError};

pub mod call_lifecycle;
mod join;
mod session;
mod voice_client;
pub use join::*;
pub use session::*;
pub use voice_client::VoiceClient;

const DESKTOP_NATIVE_IDENTITY_SUFFIX: &str = ":desktop-native";
const MIN_CALL_NOTIFICATION_RECIPIENTS_TTL_SECONDS: usize = 120;

fn same_voice_channel(left: &UserVoiceChannel, right: &UserVoiceChannel) -> bool {
    left.id == right.id
}

pub fn desktop_native_voice_identity(
    user_id: &str,
    media_kind: &str,
    operation_id: &str,
) -> String {
    format!("{user_id}{DESKTOP_NATIVE_IDENTITY_SUFFIX}:{operation_id}:{media_kind}")
}

pub fn desktop_native_voice_identities(user_id: &str, operation_id: &str) -> [String; 3] {
    [
        desktop_native_voice_identity(user_id, "microphone", operation_id),
        desktop_native_voice_identity(user_id, "screen", operation_id),
        desktop_native_voice_identity(user_id, "camera", operation_id),
    ]
}

pub fn base_voice_identity(identity: &str) -> &str {
    identity
        .find(DESKTOP_NATIVE_IDENTITY_SUFFIX)
        .map(|suffix_index| &identity[..suffix_index])
        .unwrap_or(identity)
}

pub fn is_desktop_native_voice_identity(identity: &str) -> bool {
    identity.contains(DESKTOP_NATIVE_IDENTITY_SUFFIX)
}

pub fn desktop_native_voice_operation_id(identity: &str) -> Option<&str> {
    let suffix_index = identity.find(DESKTOP_NATIVE_IDENTITY_SUFFIX)?;
    let rest = identity[suffix_index + DESKTOP_NATIVE_IDENTITY_SUFFIX.len()..].strip_prefix(':')?;
    let (operation_id, media_kind) = rest.rsplit_once(':')?;
    if operation_id.is_empty() || media_kind.is_empty() {
        return None;
    }
    Some(operation_id)
}

fn native_voice_operation_is_current(identity: &str, current_operation_id: Option<&str>) -> bool {
    desktop_native_voice_operation_id(identity)
        .zip(current_operation_id)
        .is_some_and(|(identity_operation_id, current_operation_id)| {
            identity_operation_id == current_operation_id
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceParticipantReconciliation {
    pub livekit_members: Vec<String>,
    pub stale_members: Vec<String>,
    pub stale_livekit_participants: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceParticipantReconciliationVerdict {
    Ready(VoiceParticipantReconciliation),
    DeadRoom,
    SkipTransient,
}

pub fn voice_participant_reconciliation(
    redis_members: &[String],
    livekit_participants: &[ParticipantInfo],
) -> VoiceParticipantReconciliation {
    voice_participant_reconciliation_with_current_operations(
        redis_members,
        livekit_participants,
        &[],
    )
}

pub fn voice_participant_reconciliation_with_current_operations(
    redis_members: &[String],
    livekit_participants: &[ParticipantInfo],
    current_operations: &[(String, String)],
) -> VoiceParticipantReconciliation {
    let mut livekit_members = Vec::new();
    let mut livekit_native_participants = Vec::new();
    for participant in livekit_participants {
        if is_desktop_native_voice_identity(&participant.identity) {
            let state = participant_info::State::try_from(participant.state)
                .unwrap_or(participant_info::State::Disconnected);
            if state != participant_info::State::Disconnected {
                livekit_native_participants.push(participant.identity.clone());
            }
            continue;
        }
        let state = participant_info::State::try_from(participant.state)
            .unwrap_or(participant_info::State::Disconnected);
        if state == participant_info::State::Disconnected {
            continue;
        }
        let user_id = base_voice_identity(&participant.identity).to_string();
        if !livekit_members.contains(&user_id) {
            livekit_members.push(user_id);
        }
    }

    let stale_members = redis_members
        .iter()
        .filter(|user_id| !livekit_members.contains(user_id))
        .cloned()
        .collect();

    let mut stale_livekit_participants: Vec<String> = livekit_members
        .iter()
        .filter(|user_id| !redis_members.contains(user_id))
        .cloned()
        .collect();

    for identity in livekit_native_participants {
        let base_user_id = base_voice_identity(&identity).to_string();
        let current_operation_id = current_operations
            .iter()
            .find(|(user_id, _)| user_id == &base_user_id)
            .map(|(_, operation_id)| operation_id.as_str());
        let native_operation_id = desktop_native_voice_operation_id(&identity);
        if !redis_members.contains(&base_user_id)
            || !livekit_members.contains(&base_user_id)
            || current_operation_id
                .zip(native_operation_id)
                .is_none_or(|(current, native)| current != native)
        {
            stale_livekit_participants.push(identity);
        }
    }

    VoiceParticipantReconciliation {
        livekit_members,
        stale_members,
        stale_livekit_participants,
    }
}

fn push_unique_identity(identities: &mut Vec<String>, identity: String) {
    if !identities.contains(&identity) {
        identities.push(identity);
    }
}

fn voice_transport_identities(user_id: &str, operation_id: &str) -> Vec<String> {
    let mut identities = Vec::with_capacity(4);
    identities.push(user_id.to_string());
    identities.extend(desktop_native_voice_identities(user_id, operation_id));
    identities
}

fn voice_transport_identities_to_remove<'a>(
    user_id: &str,
    operation_id: Option<&str>,
    livekit_participant_identities: impl IntoIterator<Item = &'a str>,
) -> Vec<String> {
    let mut identities = operation_id
        .map(|operation_id| voice_transport_identities(user_id, operation_id))
        .unwrap_or_else(|| vec![user_id.to_string()]);

    for identity in livekit_participant_identities {
        if identity == user_id
            || (is_desktop_native_voice_identity(identity)
                && base_voice_identity(identity) == user_id)
        {
            push_unique_identity(&mut identities, identity.to_string());
        }
    }

    identities
}

async fn get_connection() -> Result<Conn> {
    _get_connection()
        .await
        .map_err(|_| create_error!(InternalError))
}

pub async fn raise_if_in_voice(user: &User, _channel: &UserVoiceChannel) -> Result<()> {
    if let Some(session) = get_current_voice_session(&user.id).await? {
        let is_active_or_pending = matches!(
            session.state,
            VoiceSessionState::AwaitingLivekitJoin | VoiceSessionState::Active
        );
        if is_active_or_pending {
            return Err(create_error!(AlreadyConnected));
        }
    }

    Ok(())
}

pub async fn set_channel_node(channel_id: &str, node: &str) -> Result<()> {
    cmd("SETEX")
        .arg(voice_channel_node_key(channel_id))
        .arg(VOICE_MEMBERSHIP_TTL_SECONDS)
        .arg(node)
        .query_async::<_, ()>(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()
}

pub async fn get_channel_node(channel_id: &str) -> Result<Option<String>> {
    get_connection()
        .await?
        .get(voice_channel_node_key(channel_id))
        .await
        .to_internal_error()
}

pub async fn get_user_voice_channels(user_id: &str) -> Result<Vec<UserVoiceChannel>> {
    match get_active_voice_session_for_user(user_id).await? {
        Some(session) => Ok(vec![session.channel]),
        _ => Ok(Vec::new()),
    }
}

pub async fn is_in_voice_channel(user_id: &str, channel: &UserVoiceChannel) -> Result<bool> {
    Ok(get_active_voice_session_for_user(user_id)
        .await?
        .is_some_and(|session| same_voice_channel(&session.channel, channel)))
}

pub async fn set_current_voice_operation_id(
    channel: &UserVoiceChannel,
    user_id: &str,
    operation_id: &str,
) -> Result<()> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Err(create_error!(NotConnected));
    };

    if !same_voice_channel(&session.channel, channel) || session.state != VoiceSessionState::Active
    {
        return Err(create_error!(NotConnected));
    }

    let previous_operation_id = session.operation_id.clone();
    session.operation_id = operation_id.to_string();
    if replace_current_voice_session_operation(&previous_operation_id, &session).await? {
        Ok(())
    } else {
        Err(create_error!(NotConnected))
    }
}

pub async fn get_current_voice_operation_id(
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<Option<String>> {
    if let Some(session) = get_current_voice_session(user_id).await? {
        if same_voice_channel(&session.channel, channel)
            && matches!(
                session.state,
                VoiceSessionState::AwaitingLivekitJoin | VoiceSessionState::Active
            )
        {
            return Ok(Some(session.operation_id));
        }

        if let Some(previous_session) = get_replaced_active_voice_session(&session).await? {
            if same_voice_channel(&previous_session.channel, channel) {
                return Ok(Some(previous_session.operation_id));
            }
        }
    }

    Ok(None)
}

pub async fn native_voice_participant_matches_current_operation(
    channel: &UserVoiceChannel,
    user_id: &str,
    participant_identity: &str,
) -> Result<bool> {
    if desktop_native_voice_operation_id(participant_identity).is_none() {
        return Ok(false);
    }

    let Some(session) = get_current_voice_session(user_id).await? else {
        return Ok(false);
    };

    if same_voice_channel(&session.channel, channel)
        && matches!(
            session.state,
            VoiceSessionState::AwaitingLivekitJoin | VoiceSessionState::Active
        )
        && native_voice_operation_is_current(
            participant_identity,
            Some(session.operation_id.as_str()),
        )
    {
        return Ok(true);
    }

    Ok(get_replaced_active_voice_session(&session)
        .await?
        .is_some_and(|previous_session| {
            same_voice_channel(&previous_session.channel, channel)
                && native_voice_operation_is_current(
                    participant_identity,
                    Some(previous_session.operation_id.as_str()),
                )
        }))
}

pub async fn set_user_moved_from_voice(
    old_channel_id: &str,
    new_channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    get_connection()
        .await?
        .set_ex(
            format!("moved_from:{user_id}:{old_channel_id}"),
            new_channel,
            10,
        )
        .await
        .to_internal_error()
}

pub async fn get_user_moved_from_voice(channel_id: &str, user_id: &str) -> Result<Option<String>> {
    get_connection()
        .await?
        .get_del(format!("moved_from:{user_id}:{channel_id}"))
        .await
        .to_internal_error()
}

pub async fn set_user_moved_to_voice(
    new_channel_id: &str,
    old_channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    get_connection()
        .await?
        .set_ex(
            format!("moved_to:{user_id}:{new_channel_id}"),
            old_channel,
            10,
        )
        .await
        .to_internal_error()
}

pub async fn get_user_moved_to_voice(
    channel_id: &str,
    user_id: &str,
) -> Result<Option<UserVoiceChannel>> {
    get_connection()
        .await?
        .get_del(format!("moved_to:{user_id}:{channel_id}"))
        .await
        .to_internal_error()
}

pub async fn get_user_voice_channel_in_server(
    user_id: &str,
    server_id: &str,
) -> Result<Option<String>> {
    Ok(get_active_voice_session_for_user(user_id)
        .await?
        .filter(|session| session.channel.server_id.as_deref() == Some(server_id))
        .map(|session| session.channel.id))
}

pub fn get_allowed_sources(
    limits: &FeaturesLimits,
    permissions: PermissionValue,
) -> Vec<&'static str> {
    let mut allowed_sources = Vec::new();

    if permissions.has(ChannelPermission::Speak as u64) {
        allowed_sources.push("microphone")
    };

    if permissions.has(ChannelPermission::Video as u64) && limits.video {
        allowed_sources.extend(["camera", "screen_share", "screen_share_audio"]);
    };

    allowed_sources
}

pub async fn delete_voice_state(channel: &UserVoiceChannel, user_id: &str) -> Result<bool> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Ok(false);
    };

    if !same_voice_channel(&session.channel, channel) {
        if let Some(mut previous_session) = get_replaced_active_voice_session(&session).await? {
            if same_voice_channel(&previous_session.channel, channel) {
                previous_session.state = VoiceSessionState::Ended;
                previous_session.updated_at = Timestamp::now_utc();
                remove_active_voice_session_projection(&previous_session).await?;
                return Ok(true);
            }
        }

        return Ok(false);
    }

    session.state = VoiceSessionState::Ended;
    session.updated_at = Timestamp::now_utc();
    delete_current_voice_session(&session).await
}

pub async fn delete_voice_state_for_session(
    channel: &UserVoiceChannel,
    user_id: &str,
    session_id: &str,
) -> Result<bool> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Ok(false);
    };

    if !same_voice_channel(&session.channel, channel) {
        if let Some(mut previous_session) = get_replaced_active_voice_session(&session).await? {
            if same_voice_channel(&previous_session.channel, channel)
                && previous_session.participant_sid.as_deref() == Some(session_id)
                && previous_session.mark_participant_left(session_id, Timestamp::now_utc())
                    == VoiceSessionTransition::Applied
            {
                remove_active_voice_session_projection(&previous_session).await?;
                return Ok(true);
            }
        }

        return Ok(false);
    }

    if session.state != VoiceSessionState::Active
        || session.participant_sid.as_deref() != Some(session_id)
    {
        return Ok(false);
    }

    let operation_id = session.operation_id.clone();
    if session.mark_participant_left(session_id, Timestamp::now_utc())
        != VoiceSessionTransition::Applied
    {
        return Ok(false);
    }
    let deleted = delete_current_voice_session(&session).await?;
    if !deleted {
        log::debug!(
            "Voice session {operation_id} for user {user_id} was not deleted because it is no longer current."
        );
    }

    Ok(deleted)
}

pub async fn delete_channel_voice_state(
    channel: &UserVoiceChannel,
    user_ids: &[String],
) -> Result<()> {
    let mut pipeline = Pipeline::new();
    pipeline.del(voice_channel_members_key(&channel.id));
    pipeline.del(voice_channel_node_key(&channel.id));
    pipeline.del(voice_room_session_key(&channel.id));
    pipeline.srem(voice_active_channels_key(), &channel.id);

    for user_id in user_ids {
        if let Some(mut session) = get_current_voice_session(user_id).await? {
            if same_voice_channel(&session.channel, channel) {
                let operation_id = session.operation_id.clone();
                session.state = VoiceSessionState::Ended;
                session.updated_at = Timestamp::now_utc();
                if delete_current_voice_session(&session).await? {
                    pipeline.del(voice_session_key(&operation_id));
                }
            }
        }
    }

    pipeline
        .query_async(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()
}

pub async fn delete_channel_voice_state_for_room(
    channel: &UserVoiceChannel,
    user_ids: &[String],
    room_id: &str,
) -> Result<bool> {
    if !voice_room_session_matches(channel, room_id).await? {
        return Ok(false);
    }

    delete_channel_voice_state(channel, user_ids).await?;
    Ok(true)
}

pub async fn update_voice_state_tracks_for_session(
    channel: &UserVoiceChannel,
    user_id: &str,
    added: bool,
    track: i32,
    session_id: &str,
) -> Result<Option<UserVoiceState>> {
    update_voice_state_tracks_matching(channel, user_id, added, track, |session| {
        voice_session_is_current(session.participant_sid.as_deref(), session_id)
    })
    .await
}

pub async fn update_voice_state_tracks_for_operation(
    channel: &UserVoiceChannel,
    user_id: &str,
    added: bool,
    track: i32,
    operation_id: &str,
) -> Result<Option<UserVoiceState>> {
    update_voice_state_tracks_matching(channel, user_id, added, track, |session| {
        session.operation_id == operation_id
    })
    .await
}

async fn update_voice_state_tracks_matching(
    channel: &UserVoiceChannel,
    user_id: &str,
    added: bool,
    track: i32,
    matches_session: impl FnOnce(&VoiceSession) -> bool,
) -> Result<Option<UserVoiceState>> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Ok(None);
    };
    if !same_voice_channel(&session.channel, channel)
        || session.state != VoiceSessionState::Active
        || !matches_session(&session)
    {
        return Ok(None);
    }

    if session.set_track_state(added, track) != VoiceSessionTransition::Applied {
        return Ok(None);
    }

    if !save_current_voice_session(&session).await? {
        return Ok(None);
    }

    Ok(Some(session.voice_state(Timestamp::UNIX_EPOCH)))
}

fn partial_voice_state_for_track(added: bool, track: i32) -> PartialUserVoiceState {
    match track {
        /* TrackSource::Unknown */ 0 => PartialUserVoiceState::default(),
        /* TrackSource::Camera */
        1 => PartialUserVoiceState {
            camera: Some(added),
            ..Default::default()
        },
        /* TrackSource::Microphone */
        2 => PartialUserVoiceState::default(),
        /* TrackSource::ScreenShare */
        3 => PartialUserVoiceState {
            screensharing: Some(added),
            ..Default::default()
        },
        /* TrackSource::ScreenShareAudio */
        4 => PartialUserVoiceState::default(),
        _ => unreachable!(),
    }
}

pub async fn update_client_voice_flags(
    channel: &UserVoiceChannel,
    user_id: &str,
    self_mute: bool,
    self_deaf: bool,
) -> Result<UserVoiceState> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Err(create_error!(NotConnected));
    };
    if !same_voice_channel(&session.channel, channel) || session.state != VoiceSessionState::Active
    {
        return Err(create_error!(NotConnected));
    }

    session.self_mute = self_mute;
    session.self_deaf = self_deaf;
    session.version += 1;
    if !save_current_voice_session(&session).await? {
        return Err(create_error!(NotConnected));
    }

    Ok(session.voice_state(Timestamp::UNIX_EPOCH))
}

pub async fn publish_voice_state_snapshot(channel_id: &str, state: &UserVoiceState) {
    EventV1::VoiceStateUpdate {
        channel_id: channel_id.to_string(),
        state: state.clone(),
    }
    .p(channel_id.to_string())
    .await;
}

pub async fn update_voice_state(
    channel: &UserVoiceChannel,
    user_id: &str,
    partial: &PartialUserVoiceState,
) -> Result<bool> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Ok(false);
    };
    if !same_voice_channel(&session.channel, channel) || session.state != VoiceSessionState::Active
    {
        return Ok(false);
    }

    if let Some(camera) = partial.camera {
        session.camera = camera;
    }
    if let Some(self_mute) = partial.self_mute {
        session.self_mute = self_mute;
    }
    if let Some(self_deaf) = partial.self_deaf {
        session.self_deaf = self_deaf;
    }
    if let Some(server_muted) = partial.server_muted {
        session.server_muted = server_muted;
    }
    if let Some(server_deafened) = partial.server_deafened {
        session.server_deafened = server_deafened;
    }
    if let Some(screensharing) = partial.screensharing {
        session.screensharing = screensharing;
    }

    save_current_voice_session(&session).await
}

async fn bump_voice_state_version(channel: &UserVoiceChannel, user_id: &str) -> Result<u64> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Err(create_error!(NotConnected));
    };
    if !same_voice_channel(&session.channel, channel) || session.state != VoiceSessionState::Active
    {
        return Err(create_error!(NotConnected));
    }
    session.version += 1;
    let version = session.version;
    if !save_current_voice_session(&session).await? {
        return Err(create_error!(NotConnected));
    }
    Ok(version)
}

pub async fn get_voice_channel_members(channel: &UserVoiceChannel) -> Result<Option<Vec<String>>> {
    get_connection()
        .await?
        .smembers::<_, Option<Vec<String>>>(voice_channel_members_key(&channel.id))
        .await
        .to_internal_error()
        .map(|opt| opt.and_then(|v| if v.is_empty() { None } else { Some(v) }))
}

pub async fn get_voice_participant_reconciliation(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
) -> Result<VoiceParticipantReconciliationVerdict> {
    let redis_members = get_voice_channel_members(channel)
        .await?
        .unwrap_or_default();
    let mut current_operations = Vec::new();
    for user_id in &redis_members {
        if let Some(session) = get_current_voice_session(user_id).await? {
            if same_voice_channel(&session.channel, channel)
                && session.state == VoiceSessionState::Active
            {
                current_operations.push((user_id.clone(), session.operation_id));
            } else if let Some(previous_session) =
                get_replaced_active_voice_session(&session).await?
            {
                if same_voice_channel(&previous_session.channel, channel) {
                    current_operations.push((user_id.clone(), previous_session.operation_id));
                }
            }
        }
    }
    let Some(node) = get_channel_node(&channel.id).await? else {
        log::warn!(
            "Skipping voice reconciliation for channel {} because no voice node is recorded",
            channel.id
        );
        return Ok(VoiceParticipantReconciliationVerdict::SkipTransient);
    };

    let livekit_participants = match voice_client
        .list_room_participants(&node, &channel.id)
        .await
    {
        Ok(Some(participants)) => participants,
        Ok(None) => return Ok(VoiceParticipantReconciliationVerdict::DeadRoom),
        Err(error) => {
            log::warn!(
                "Skipping voice reconciliation for channel {} on node {node}: {error}",
                channel.id
            );
            return Ok(VoiceParticipantReconciliationVerdict::SkipTransient);
        }
    };

    let reconciliation = voice_participant_reconciliation_with_current_operations(
        &redis_members,
        &livekit_participants,
        &current_operations,
    );

    for (user_id, operation_id) in &current_operations {
        if reconciliation.livekit_members.contains(user_id) {
            refresh_active_voice_session_projection_ttl(channel, user_id, operation_id).await?;
        }
    }

    Ok(VoiceParticipantReconciliationVerdict::Ready(reconciliation))
}

pub async fn get_voice_state(
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<Option<UserVoiceState>> {
    Ok(get_active_voice_session_for_user(user_id)
        .await?
        .filter(|session| same_voice_channel(&session.channel, channel))
        .map(|session| session.voice_state(Timestamp::UNIX_EPOCH)))
}

fn voice_session_is_current(current: Option<&str>, session_id: &str) -> bool {
    current.is_some_and(|current| current == session_id)
}

async fn voice_room_session_matches(channel: &UserVoiceChannel, room_id: &str) -> Result<bool> {
    let current: Option<String> = get_connection()
        .await?
        .get(voice_room_session_key(&channel.id))
        .await
        .to_internal_error()?;

    Ok(current.as_deref().is_none_or(|current| current == room_id))
}

pub async fn get_channel_voice_state(
    channel: &UserVoiceChannel,
) -> Result<Option<v0::ChannelVoiceState>> {
    let members = get_voice_channel_members(channel).await?;

    if let Some(members) = members {
        let mut participants = Vec::with_capacity(members.len());

        for user_id in members {
            if let Some(voice_state) = get_voice_state(channel, &user_id).await? {
                participants.push(voice_state);
            } else {
                log::info!("Voice state not found but member in voice channel members, removing.");

                let _ = delete_voice_state(channel, &user_id).await?;
            }
        }

        // In case a user voice state failed to be fetched, the vec's capacity will be larger than the length, shrink it
        participants.shrink_to_fit();

        Ok(Some(v0::ChannelVoiceState {
            id: channel.id.clone(),
            participants,
        }))
    } else {
        Ok(None)
    }
}

pub async fn sync_voice_permissions(
    db: &Database,
    voice_client: &VoiceClient,
    channel: &Channel,
    server: Option<&Server>,
    role_id: Option<&str>,
) -> Result<()> {
    let user_voice_channel = UserVoiceChannel::from_channel(channel);

    let Some(node) = get_channel_node(channel.id()).await? else {
        return Ok(());
    };

    for user_id in get_voice_channel_members(&user_voice_channel)
        .await?
        .iter()
        .flatten()
    {
        let user = Reference::from_unchecked(user_id).as_user(db).await?;

        sync_user_voice_permissions(db, voice_client, &node, &user, channel, server, role_id)
            .await?;
    }

    Ok(())
}

pub async fn sync_user_voice_permissions(
    db: &Database,
    voice_client: &VoiceClient,
    node: &str,
    user: &User,
    channel: &Channel,
    server: Option<&Server>,
    role_id: Option<&str>,
) -> Result<()> {
    let channel_id = channel.id();
    let server_id = server.as_ref().map(|s| s.id.as_str());

    let member = match server_id {
        Some(server_id) => Some(
            Reference::from_unchecked(&user.id)
                .as_member(db, server_id)
                .await?,
        ),
        None => None,
    };

    if role_id.is_none_or(|role_id| {
        member
            .as_ref()
            .is_none_or(|member| member.roles.iter().any(|r| r == role_id))
    }) {
        let user_voice_channel = UserVoiceChannel::from_channel(channel);

        let Some(voice_state) = get_voice_state(&user_voice_channel, &user.id).await? else {
            return Ok(());
        };

        let mut query = DatabasePermissionQuery::new(db, user)
            .channel(channel)
            .user(user);

        if let (Some(server), Some(member)) = (server, member.as_ref()) {
            query = query.member(member).server(server)
        }

        let permissions = calculate_channel_permissions(&mut query).await;
        let limits = user.limits().await;

        let mut update_event = PartialUserVoiceState {
            id: Some(user.id.clone()),
            ..Default::default()
        };

        let before = update_event.clone();

        let can_video =
            limits.video && permissions.has_channel_permission(ChannelPermission::Video);
        let can_speak = permissions.has_channel_permission(ChannelPermission::Speak);
        let can_listen = permissions.has_channel_permission(ChannelPermission::Listen);

        update_event.camera = voice_state.camera.then_some(can_video);
        update_event.screensharing = voice_state.screensharing.then_some(can_video);
        update_event.server_muted = (voice_state.server_muted != !can_speak).then_some(!can_speak);
        update_event.server_deafened =
            (voice_state.server_deafened != !can_listen).then_some(!can_listen);

        let updated = update_voice_state(&user_voice_channel, &user.id, &update_event).await?;

        voice_client
            .update_permissions(
                node,
                user,
                channel_id,
                ParticipantPermission {
                    can_subscribe: can_listen,
                    can_publish: can_speak,
                    can_publish_data: can_speak,
                    ..Default::default()
                },
            )
            .await?;

        if updated && update_event != before {
            bump_voice_state_version(&user_voice_channel, &user.id).await?;

            if let Some(state) = get_voice_state(&user_voice_channel, &user.id).await? {
                publish_voice_state_snapshot(channel_id, &state).await;
            }
        };
    };

    Ok(())
}

pub async fn set_channel_call_started_system_message(
    channel_id: &str,
    message_id: &str,
) -> Result<()> {
    get_connection()
        .await?
        .set(format!("call_started_message:{channel_id}"), message_id)
        .await
        .to_internal_error()
}

pub async fn create_voice_call_started_system_message(
    db: &Database,
    channel: &Channel,
    initiator_id: &str,
) -> Result<()> {
    let mut message = voice_call_started_system_message(channel.id(), initiator_id);
    message
        .send_without_notifications(
            db,
            None,
            None,
            matches!(channel, Channel::DirectMessage { .. }),
            false,
            false,
        )
        .await?;
    set_channel_call_started_system_message(channel.id(), &message.id).await
}

pub async fn take_channel_call_started_system_message(channel_id: &str) -> Result<Option<String>> {
    get_connection()
        .await?
        .get_del(format!("call_started_message:{channel_id}"))
        .await
        .to_internal_error()
}

pub async fn finish_voice_call_started_system_message(
    db: &Database,
    channel_id: &str,
    finished_at: Timestamp,
    ended_reason: VoiceCallEndReason,
) -> Result<()> {
    let Some(message_id) = take_channel_call_started_system_message(channel_id).await? else {
        return Ok(());
    };

    let Ok(mut message) = Reference::from_unchecked(&message_id).as_message(db).await else {
        return Ok(());
    };

    let Some(SystemMessage::CallStarted { by, .. }) = &message.system else {
        log::error!(
            "Broken state: Call started message ID ({message_id}) does not contain a CallStarted system message."
        );
        return Ok(());
    };

    message
        .update(
            db,
            voice_call_finished_system_partial(by, finished_at, ended_reason),
            Vec::new(),
        )
        .await
}

fn voice_call_started_system_message(channel_id: &str, initiator_id: &str) -> Message {
    SystemMessage::CallStarted {
        by: initiator_id.to_string(),
        finished_at: None,
        ended_reason: None,
    }
    .into_message(channel_id.to_string())
}

fn voice_call_finished_system_partial(
    initiator_id: &str,
    finished_at: Timestamp,
    ended_reason: VoiceCallEndReason,
) -> PartialMessage {
    PartialMessage {
        system: Some(SystemMessage::CallStarted {
            by: initiator_id.to_string(),
            finished_at: Some(finished_at),
            ended_reason: Some(ended_reason),
        }),
        ..Default::default()
    }
}

pub async fn set_call_notification_recipients(
    channel_id: &str,
    user_id: &str,
    recipients: &[String],
) -> Result<()> {
    let ttl_seconds = std::cmp::max(
        syrnike_config::config()
            .await
            .api
            .livekit
            .call_ring_duration
            + 60,
        MIN_CALL_NOTIFICATION_RECIPIENTS_TTL_SECONDS,
    );

    let recipients = serde_json::to_string(recipients).to_internal_error()?;

    get_connection()
        .await?
        .set_ex(
            format!("call_notification_recipients:{channel_id}-{user_id}"),
            recipients,
            ttl_seconds,
        )
        .await
        .to_internal_error()
}

pub async fn get_call_notification_recipients(
    channel_id: &str,
    user_id: &str,
) -> Result<Option<Vec<String>>> {
    let raw: Option<String> = get_connection()
        .await?
        .get_del(format!(
            "call_notification_recipients:{channel_id}-{user_id}"
        ))
        .await
        .to_internal_error()?;

    raw.map(|raw| serde_json::from_str(&raw).to_internal_error())
        .transpose()
}

pub async fn remove_user_from_voice_channels(
    voice_client: &VoiceClient,
    user_id: &str,
) -> Result<()> {
    for channel in get_user_voice_channels(user_id).await? {
        remove_user_from_voice_channel(voice_client, &channel, user_id).await?;
    }
    cancel_current_pending_voice_join(voice_client, user_id).await?;

    Ok(())
}

pub async fn remove_user_from_voice_channel(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    remove_user_voice_transport(voice_client, channel, user_id).await?;
    if delete_voice_state(channel, user_id).await? {
        EventV1::VoiceChannelLeave {
            id: channel.id.clone(),
            user: user_id.to_string(),
        }
        .p(channel.id.clone())
        .await;
    }

    Ok(())
}

pub async fn remove_user_voice_transport(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    let current_operation_id = get_current_voice_operation_id(channel, user_id).await?;
    remove_user_voice_transport_for_operation(
        voice_client,
        channel,
        user_id,
        current_operation_id.as_deref(),
    )
    .await
}

async fn remove_user_voice_transport_for_operation(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
    user_id: &str,
    operation_id: Option<&str>,
) -> Result<()> {
    if let Some(node) = get_channel_node(&channel.id).await? {
        let livekit_participants = voice_client
            .list_room_participants(&node, &channel.id)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        let livekit_identities = livekit_participants
            .iter()
            .map(|participant| participant.identity.as_str());

        for identity in
            voice_transport_identities_to_remove(user_id, operation_id, livekit_identities)
        {
            let _ = voice_client
                .remove_user(&node, &identity, &channel.id)
                .await;
        }
    }

    Ok(())
}

pub async fn cancel_current_pending_voice_join(
    voice_client: &VoiceClient,
    user_id: &str,
) -> Result<bool> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Ok(false);
    };

    if session.state != VoiceSessionState::AwaitingLivekitJoin {
        return Ok(false);
    }

    remove_user_voice_transport_for_operation(
        voice_client,
        &session.channel,
        user_id,
        Some(session.operation_id.as_str()),
    )
    .await?;

    session.state = VoiceSessionState::Ended;
    session.updated_at = Timestamp::now_utc();
    delete_current_voice_session(&session).await
}

pub async fn cancel_current_pending_voice_join_in_server(
    voice_client: &VoiceClient,
    user_id: &str,
    server_id: &str,
) -> Result<bool> {
    let Some(session) = get_current_voice_session(user_id).await? else {
        return Ok(false);
    };

    if session.state != VoiceSessionState::AwaitingLivekitJoin
        || session.channel.server_id.as_deref() != Some(server_id)
    {
        return Ok(false);
    }

    cancel_current_pending_voice_join(voice_client, user_id).await
}

pub async fn delete_voice_channel(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
) -> Result<()> {
    if let Some(node) = get_channel_node(&channel.id).await? {
        let _ = voice_client.delete_room(&node, &channel.id).await;
    }

    let users = get_voice_channel_members(channel)
        .await?
        .unwrap_or_default();
    delete_channel_voice_state(channel, &users).await?;

    for user_id in users {
        EventV1::VoiceChannelLeave {
            id: channel.id.clone(),
            user: user_id,
        }
        .p(channel.id.clone())
        .await;
    }

    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomMetadata {
    pub server: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserVoiceChannel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
}

impl UserVoiceChannel {
    pub fn from_string(input: String) -> Self {
        let mut parts = input.splitn(2, '-');

        Self {
            id: parts.next().unwrap().to_string(),
            server_id: parts.next().map(ToString::to_string),
        }
    }

    pub fn from_channel(channel: &Channel) -> Self {
        Self {
            id: channel.id().to_string(),
            server_id: channel.server().map(ToString::to_string),
        }
    }
}

impl Display for UserVoiceChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.id)?;

        if let Some(server_id) = &self.server_id {
            f.write_char('-')?;
            f.write_str(server_id)?
        };

        Ok(())
    }
}

impl ToRedisArgs for UserVoiceChannel {
    fn write_redis_args<W: ?Sized + RedisWrite>(&self, out: &mut W) {
        out.write_arg_fmt(self);
    }
}

impl FromRedisValue for UserVoiceChannel {
    fn from_redis_value(v: &Value) -> Result<Self, RedisError> {
        String::from_redis_value(v).map(UserVoiceChannel::from_string)
    }
}

#[cfg(test)]
mod tests {
    use super::partial_voice_state_for_track;
    use crate::{SystemMessage, VoiceCallEndReason};
    use iso8601_timestamp::Timestamp;
    use std::collections::HashMap;
    use syrnike_models::v0::PartialUserVoiceState;

    #[test]
    fn screen_share_video_updates_streaming_state() {
        let partial = partial_voice_state_for_track(true, 3);

        assert_eq!(partial.screensharing, Some(true));
        assert_eq!(partial.camera, None);
        assert_eq!(partial.self_mute, None);
        assert_eq!(partial.self_deaf, None);
        assert_eq!(partial.server_muted, None);
        assert_eq!(partial.server_deafened, None);
    }

    #[test]
    fn microphone_track_does_not_affect_voice_flags() {
        let partial = partial_voice_state_for_track(true, 2);

        assert_eq!(partial, PartialUserVoiceState::default());
    }

    #[test]
    fn screen_share_audio_does_not_clear_streaming_state() {
        let partial = partial_voice_state_for_track(false, 4);

        assert_eq!(partial.screensharing, None);
        assert_eq!(partial.camera, None);
        assert_eq!(partial.self_mute, None);
        assert_eq!(partial.self_deaf, None);
        assert_eq!(partial.server_muted, None);
        assert_eq!(partial.server_deafened, None);
    }

    #[test]
    fn desktop_native_voice_identity_maps_to_base_user() {
        assert_eq!(
            super::desktop_native_voice_identity("user-a", "microphone", "op-join"),
            "user-a:desktop-native:op-join:microphone"
        );
        assert_eq!(
            super::desktop_native_voice_identities("user-a", "op-join"),
            [
                "user-a:desktop-native:op-join:microphone".to_string(),
                "user-a:desktop-native:op-join:screen".to_string(),
                "user-a:desktop-native:op-join:camera".to_string()
            ]
        );
        assert_eq!(
            super::base_voice_identity("user-a:desktop-native:op-join:microphone"),
            "user-a"
        );
        assert_eq!(
            super::base_voice_identity("user-a:desktop-native"),
            "user-a"
        );
        assert_eq!(super::base_voice_identity("user-a"), "user-a");
        assert!(super::is_desktop_native_voice_identity(
            "user-a:desktop-native:op-join:screen"
        ));
        assert!(super::is_desktop_native_voice_identity(
            "user-a:desktop-native"
        ));
        assert!(!super::is_desktop_native_voice_identity("user-a"));
        assert_eq!(
            super::desktop_native_voice_operation_id("user-a:desktop-native:op-join:screen"),
            Some("op-join")
        );
        assert_eq!(
            super::desktop_native_voice_operation_id("user-a:desktop-native:screen"),
            None
        );
    }

    #[test]
    fn voice_transport_identities_include_base_and_current_desktop_native_participants() {
        assert_eq!(
            super::voice_transport_identities("user-a", "op-join"),
            vec![
                "user-a".to_string(),
                "user-a:desktop-native:op-join:microphone".to_string(),
                "user-a:desktop-native:op-join:screen".to_string(),
                "user-a:desktop-native:op-join:camera".to_string(),
            ]
        );
    }

    #[test]
    fn voice_transport_removal_includes_live_native_participants_for_base_user() {
        assert_eq!(
            super::voice_transport_identities_to_remove(
                "user-a",
                Some("op-new"),
                [
                    "user-a",
                    "user-a:desktop-native:op-old:screen",
                    "user-b:desktop-native:op-new:screen",
                ],
            ),
            vec![
                "user-a".to_string(),
                "user-a:desktop-native:op-new:microphone".to_string(),
                "user-a:desktop-native:op-new:screen".to_string(),
                "user-a:desktop-native:op-new:camera".to_string(),
                "user-a:desktop-native:op-old:screen".to_string(),
            ]
        );
    }

    #[test]
    fn native_voice_operation_match_requires_current_operation() {
        assert!(super::native_voice_operation_is_current(
            "user-a:desktop-native:op-new:screen",
            Some("op-new")
        ));
        assert!(!super::native_voice_operation_is_current(
            "user-a:desktop-native:op-old:screen",
            Some("op-new")
        ));
        assert!(!super::native_voice_operation_is_current(
            "user-a:desktop-native:screen",
            Some("op-new")
        ));
        assert!(!super::native_voice_operation_is_current(
            "user-a:desktop-native:op-new:screen",
            None
        ));
    }

    #[test]
    fn participant_left_session_match_requires_current_session() {
        assert!(super::voice_session_is_current(
            Some("session-new"),
            "session-new",
        ));
        assert!(!super::voice_session_is_current(
            Some("session-new"),
            "session-old",
        ));
        assert!(!super::voice_session_is_current(None, "session-old"));
    }

    #[test]
    fn voice_call_started_system_message_records_initiator_without_finished_time() {
        let message = super::voice_call_started_system_message("channel-a", "caller-a");

        assert_eq!(message.channel, "channel-a");
        assert_eq!(
            message.system,
            Some(SystemMessage::CallStarted {
                by: "caller-a".to_string(),
                finished_at: None,
                ended_reason: None,
            })
        );
    }

    #[test]
    fn voice_call_finished_system_partial_preserves_initiator_time_and_end_reason() {
        let finished_at = Timestamp::UNIX_EPOCH;

        let partial = super::voice_call_finished_system_partial(
            "caller-a",
            finished_at,
            VoiceCallEndReason::Completed,
        );

        assert_eq!(
            partial.system,
            Some(SystemMessage::CallStarted {
                by: "caller-a".to_string(),
                finished_at: Some(finished_at),
                ended_reason: Some(VoiceCallEndReason::Completed),
            })
        );
    }

    #[async_std::test]
    async fn delete_voice_channel_clears_channel_metadata_without_members() {
        let channel = super::UserVoiceChannel {
            id: format!("test-empty-{}", ulid::Ulid::new()),
            server_id: None,
        };
        super::set_channel_node(&channel.id, "missing-node")
            .await
            .expect("set channel node");

        let voice_client = super::VoiceClient::new(HashMap::new());
        super::delete_voice_channel(&voice_client, &channel)
            .await
            .expect("delete voice channel");

        assert_eq!(
            super::get_channel_node(&channel.id)
                .await
                .expect("get channel node"),
            None
        );
    }
}
