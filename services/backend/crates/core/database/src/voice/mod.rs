use std::fmt::{Display, Write};

use serde::{Deserialize, Serialize};

use crate::{
    events::client::EventV1,
    models::{Channel, Message, PartialMessage, SystemMessage, User, VoiceCallEndReason},
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, Server,
};
use iso8601_timestamp::{Duration, Timestamp};
use livekit_protocol::{participant_info, ParticipantInfo, ParticipantPermission, TrackSource};
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
const BROWSER_VOICE_IDENTITY_SUFFIX: &str = ":browser";
const MIN_CALL_NOTIFICATION_RECIPIENTS_TTL_SECONDS: usize = 120;
const VOICE_SESSION_MUTATION_RETRY_LIMIT: usize = 8;
pub const BROWSER_VOICE_OPERATION_ID_ATTRIBUTE: &str = "voice_operation_id";
pub const VOICE_OPERATION_ID_PREFIX: &str = "voice-op-";

pub fn is_valid_voice_operation_id(operation_id: &str) -> bool {
    let Some(uuid) = operation_id.strip_prefix(VOICE_OPERATION_ID_PREFIX) else {
        return false;
    };
    uuid.len() == 36 && uuid::Uuid::try_parse(uuid).is_ok()
}

pub fn browser_voice_operation_id(participant: &ParticipantInfo) -> Option<String> {
    let operation_id = if let Some(operation_id) = participant
        .attributes
        .get(BROWSER_VOICE_OPERATION_ID_ATTRIBUTE)
    {
        operation_id.clone()
    } else {
        let metadata = participant.metadata.trim();
        if metadata.is_empty() {
            return None;
        }
        serde_json::from_str::<serde_json::Value>(metadata)
            .ok()?
            .get(BROWSER_VOICE_OPERATION_ID_ATTRIBUTE)?
            .as_str()?
            .to_string()
    };
    (is_valid_voice_operation_id(&operation_id)
        && browser_voice_operation_id_from_identity(&participant.identity)
            == Some(operation_id.as_str()))
    .then_some(operation_id)
}

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

pub fn browser_voice_identity(user_id: &str, operation_id: &str) -> String {
    format!("{user_id}{BROWSER_VOICE_IDENTITY_SUFFIX}:{operation_id}")
}

pub fn desktop_native_voice_identities(user_id: &str, operation_id: &str) -> [String; 3] {
    [
        desktop_native_voice_identity(user_id, "microphone", operation_id),
        desktop_native_voice_identity(user_id, "screen", operation_id),
        desktop_native_voice_identity(user_id, "camera", operation_id),
    ]
}

pub fn base_voice_identity(identity: &str) -> &str {
    [
        identity.find(DESKTOP_NATIVE_IDENTITY_SUFFIX),
        identity.find(BROWSER_VOICE_IDENTITY_SUFFIX),
    ]
    .into_iter()
    .flatten()
    .min()
    .map(|suffix_index| &identity[..suffix_index])
    .unwrap_or(identity)
}

pub fn is_desktop_native_voice_identity(identity: &str) -> bool {
    identity.contains(DESKTOP_NATIVE_IDENTITY_SUFFIX)
}

pub fn browser_voice_operation_id_from_identity(identity: &str) -> Option<&str> {
    let suffix_index = identity.find(BROWSER_VOICE_IDENTITY_SUFFIX)?;
    let operation_id =
        identity[suffix_index + BROWSER_VOICE_IDENTITY_SUFFIX.len()..].strip_prefix(':')?;
    is_valid_voice_operation_id(operation_id).then_some(operation_id)
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
    DeadRoom { stale_members: Vec<String> },
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
        &[],
    )
}

pub fn voice_participant_reconciliation_with_current_operations(
    redis_members: &[String],
    livekit_participants: &[ParticipantInfo],
    current_operations: &[(String, String)],
    prepared_users: &[String],
) -> VoiceParticipantReconciliation {
    let mut livekit_members = Vec::new();
    let mut livekit_browser_participants = Vec::new();
    let mut livekit_native_participants = Vec::new();
    let mut stale_livekit_participants = Vec::new();
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
        livekit_browser_participants.push((user_id.clone(), participant.identity.clone()));
        let allowed_operations = current_operations
            .iter()
            .filter(|(candidate_user_id, _)| candidate_user_id == &user_id)
            .map(|(_, operation_id)| operation_id.as_str())
            .collect::<Vec<_>>();
        if !allowed_operations.is_empty()
            && browser_voice_operation_id(participant)
                .as_deref()
                .is_none_or(|operation_id| !allowed_operations.contains(&operation_id))
        {
            stale_livekit_participants.push(participant.identity.clone());
        }
        if !livekit_members.contains(&user_id) {
            livekit_members.push(user_id);
        }
    }

    let stale_members = redis_members
        .iter()
        .filter(|user_id| !livekit_members.contains(user_id) && !prepared_users.contains(user_id))
        .cloned()
        .collect();

    stale_livekit_participants.extend(
        livekit_browser_participants
            .iter()
            .filter(|(user_id, _)| {
                !redis_members.contains(user_id) && !prepared_users.contains(user_id)
            })
            .map(|(_, identity)| identity.clone()),
    );
    stale_livekit_participants.sort_unstable();
    stale_livekit_participants.dedup();

    for identity in livekit_native_participants {
        let base_user_id = base_voice_identity(&identity).to_string();
        let native_operation_id = desktop_native_voice_operation_id(&identity);
        if native_operation_id.is_some_and(|native| {
            current_operations
                .iter()
                .any(|(user_id, operation_id)| user_id == &base_user_id && operation_id == native)
        }) {
            continue;
        }

        if !redis_members.contains(&base_user_id) || !livekit_members.contains(&base_user_id) {
            stale_livekit_participants.push(identity);
            continue;
        }

        stale_livekit_participants.push(identity);
    }

    VoiceParticipantReconciliation {
        livekit_members,
        stale_members,
        stale_livekit_participants,
    }
}

async fn get_connection() -> Result<Conn> {
    _get_connection()
        .await
        .map_err(|_| create_error!(InternalError))
}

pub async fn raise_if_in_voice(user: &User, _channel: &UserVoiceChannel) -> Result<()> {
    if get_current_voice_session(&user.id).await?.is_some() {
        return Err(create_error!(AlreadyConnected));
    }

    if get_current_voice_reservation(&user.id).await?.is_some() {
        return Err(create_error!(AlreadyConnected));
    }

    Ok(())
}

pub async fn set_channel_node(channel_id: &str, node: &str) -> Result<()> {
    cmd("SET")
        .arg(voice_channel_node_key(channel_id))
        .arg(node)
        .query_async::<_, ()>(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()
}

pub async fn clear_channel_node(channel_id: &str) -> Result<()> {
    get_connection()
        .await?
        .del(voice_channel_node_key(channel_id))
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

pub async fn retain_current_voice_operation_id(
    _voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
    user_id: &str,
    expected_current_operation_id: &str,
    operation_id: &str,
) -> Result<()> {
    for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
        let authority = get_voice_authority_snapshot(user_id).await?;
        let current_reservation = authority.reservation;
        let Some(session) = authority.session else {
            return Err(create_error!(NotConnected));
        };

        if !same_voice_channel(&session.channel, channel)
            || session.state != VoiceSessionState::Active
        {
            return Err(create_error!(NotConnected));
        }
        if session.operation_id != operation_id {
            return Err(create_error!(InvalidOperation));
        }

        let Some(reservation) = current_reservation else {
            if confirm_retained_voice_session(&session, expected_current_operation_id).await? {
                return Ok(());
            }
            continue;
        };
        if reservation.operation_id != expected_current_operation_id
            || reservation.expected_finalized_operation_id.as_deref() != Some(operation_id)
        {
            return Err(create_error!(InvalidOperation));
        }

        if retain_active_voice_session_from_reservation(&reservation, &session).await? {
            return Ok(());
        }
    }

    Err(create_error!(InvalidOperation))
}

pub async fn get_current_voice_operation_id(
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<Option<String>> {
    let authority = get_voice_authority_snapshot(user_id).await?;
    if let Some(reservation) = authority.reservation {
        if same_voice_channel(&reservation.channel, channel) {
            return Ok(Some(reservation.operation_id));
        }
    }

    if let Some(session) = authority.session {
        if same_voice_channel(&session.channel, channel)
            && session.state == VoiceSessionState::Active
        {
            return Ok(Some(session.operation_id));
        }
    }

    Ok(None)
}

pub async fn get_current_voice_authority(user_id: &str) -> Result<Option<(String, String)>> {
    let authority = get_voice_authority_snapshot(user_id).await?;
    if let Some(reservation) = authority.reservation {
        return Ok(Some((reservation.operation_id, reservation.channel.id)));
    }
    Ok(authority
        .session
        .filter(|session| session.state == VoiceSessionState::Active)
        .map(|session| (session.operation_id, session.channel.id)))
}

pub async fn native_voice_participant_matches_current_operation(
    channel: &UserVoiceChannel,
    user_id: &str,
    participant_identity: &str,
) -> Result<bool> {
    if desktop_native_voice_operation_id(participant_identity).is_none() {
        return Ok(false);
    }

    let authority = get_voice_authority_snapshot(user_id).await?;
    if let Some(reservation) = authority.reservation {
        if same_voice_channel(&reservation.channel, channel)
            && native_voice_operation_is_current(
                participant_identity,
                Some(reservation.operation_id.as_str()),
            )
        {
            return Ok(true);
        }
    }

    let Some(session) = authority.session else {
        return Ok(false);
    };

    if same_voice_channel(&session.channel, channel)
        && session.state == VoiceSessionState::Active
        && native_voice_operation_is_current(
            participant_identity,
            Some(session.operation_id.as_str()),
        )
    {
        return Ok(true);
    }

    Ok(false)
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

pub async fn delete_voice_state(
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<Option<String>> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Ok(None);
    };

    if !same_voice_channel(&session.channel, channel) || session.state != VoiceSessionState::Active
    {
        return Ok(None);
    }

    session.state = VoiceSessionState::Ended;
    session.updated_at = Timestamp::now_utc();
    let operation_id = session.operation_id.clone();
    Ok(delete_current_voice_session(&session)
        .await?
        .then_some(operation_id))
}

pub async fn delete_voice_state_for_session(
    channel: &UserVoiceChannel,
    user_id: &str,
    session_id: &str,
) -> Result<Option<String>> {
    let Some(mut session) = get_current_voice_session(user_id).await? else {
        return Ok(None);
    };

    if !same_voice_channel(&session.channel, channel) {
        return Ok(None);
    }

    if session.state != VoiceSessionState::Active
        || session.participant_sid.as_deref() != Some(session_id)
    {
        return Ok(None);
    }

    let operation_id = session.operation_id.clone();
    if session.mark_participant_left(session_id, Timestamp::now_utc())
        != VoiceSessionTransition::Applied
    {
        return Ok(None);
    }
    let deleted = delete_current_voice_session(&session).await?;
    if !deleted {
        log::debug!(
            "Voice session {operation_id} for user {user_id} was not deleted because it is no longer current."
        );
    }

    Ok(deleted.then_some(operation_id))
}

pub async fn delete_channel_voice_state(
    channel: &UserVoiceChannel,
    user_ids: &[String],
) -> Result<Vec<(String, String)>> {
    let mut pipeline = Pipeline::new();
    let mut deleted_sessions = Vec::new();
    pipeline.del(voice_channel_members_key(&channel.id));
    pipeline.del(voice_channel_node_key(&channel.id));
    pipeline.del(voice_room_session_key(&channel.id));
    pipeline.del(voice_channel_reservations_key(&channel.id));
    pipeline.srem(voice_active_channels_key(), &channel.id);

    for user_id in user_ids {
        if let Some(mut session) = get_current_voice_session(user_id).await? {
            if same_voice_channel(&session.channel, channel) {
                let operation_id = session.operation_id.clone();
                session.state = VoiceSessionState::Ended;
                session.updated_at = Timestamp::now_utc();
                if delete_current_voice_session(&session).await? {
                    pipeline.del(voice_session_key(&operation_id));
                    deleted_sessions.push((user_id.clone(), operation_id));
                }
            }
        }
    }

    pipeline
        .query_async::<_, ()>(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()?;
    Ok(deleted_sessions)
}

pub async fn delete_channel_voice_state_for_room(
    channel: &UserVoiceChannel,
    user_ids: &[String],
    room_id: &str,
) -> Result<Option<Vec<(String, String)>>> {
    if !delete_voice_channel_projection_for_room(channel, room_id).await? {
        return Ok(None);
    }

    let mut deleted_sessions = Vec::new();
    for user_id in user_ids {
        let Some(mut session) = get_current_voice_session(user_id).await? else {
            continue;
        };
        if same_voice_channel(&session.channel, channel)
            && session.state == VoiceSessionState::Active
            && session.room_sid.as_deref() == Some(room_id)
        {
            session.state = VoiceSessionState::Ended;
            session.updated_at = Timestamp::now_utc();
            let operation_id = session.operation_id.clone();
            if delete_current_voice_session(&session).await? {
                deleted_sessions.push((user_id.clone(), operation_id));
            }
        }
    }
    Ok(Some(deleted_sessions))
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
    for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
        let Some(previous) = get_current_voice_reservation(user_id).await? else {
            break;
        };
        if previous.operation_id != operation_id || !same_voice_channel(&previous.channel, channel)
        {
            break;
        }

        let mut next = previous.clone();
        if next.set_track_state(added, track) != VoiceSessionTransition::Applied {
            return Ok(None);
        }
        if save_current_voice_reservation(&previous, &next).await? {
            return Ok(None);
        }
    }

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
    matches_session: impl Fn(&VoiceSession) -> bool,
) -> Result<Option<UserVoiceState>> {
    for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
        let Some(previous) = get_current_voice_session(user_id).await? else {
            return Ok(None);
        };
        if !same_voice_channel(&previous.channel, channel)
            || previous.state != VoiceSessionState::Active
            || !matches_session(&previous)
        {
            return Ok(None);
        }

        let mut next = previous.clone();
        if next.set_track_state(added, track) != VoiceSessionTransition::Applied {
            return Ok(None);
        }

        if save_current_voice_session(&previous, &next).await? {
            return Ok(Some(next.voice_state(Timestamp::UNIX_EPOCH)));
        }
    }

    Ok(None)
}

fn partial_voice_state_for_track(added: bool, track: i32) -> PartialUserVoiceState {
    match TrackSource::try_from(track) {
        Ok(TrackSource::Camera) => PartialUserVoiceState {
            camera: Some(added),
            ..Default::default()
        },
        Ok(TrackSource::ScreenShare) => PartialUserVoiceState {
            screensharing: Some(added),
            ..Default::default()
        },
        Ok(TrackSource::Unknown | TrackSource::Microphone | TrackSource::ScreenShareAudio)
        | Err(_) => PartialUserVoiceState::default(),
    }
}

pub async fn update_client_voice_flags(
    channel: &UserVoiceChannel,
    user_id: &str,
    operation_id: &str,
    self_mute: bool,
    self_deaf: bool,
) -> Result<UserVoiceState> {
    for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
        let Some(previous) = get_current_voice_session(user_id).await? else {
            return Err(create_error!(NotConnected));
        };
        if !same_voice_channel(&previous.channel, channel)
            || previous.operation_id != operation_id
            || previous.state != VoiceSessionState::Active
        {
            return Err(create_error!(NotConnected));
        }

        let mut next = previous.clone();
        next.self_mute = self_mute;
        next.self_deaf = self_deaf;
        next.version += 1;
        if save_current_voice_session(&previous, &next).await? {
            return Ok(next.voice_state(Timestamp::UNIX_EPOCH));
        }
    }

    Err(create_error!(NotConnected))
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
    for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
        let Some(previous) = get_current_voice_session(user_id).await? else {
            return Ok(false);
        };
        if !same_voice_channel(&previous.channel, channel)
            || previous.state != VoiceSessionState::Active
        {
            return Ok(false);
        }

        let mut next = previous.clone();
        if let Some(camera) = partial.camera {
            next.camera = camera;
        }
        if let Some(self_mute) = partial.self_mute {
            next.self_mute = self_mute;
        }
        if let Some(self_deaf) = partial.self_deaf {
            next.self_deaf = self_deaf;
        }
        if let Some(server_muted) = partial.server_muted {
            next.server_muted = server_muted;
        }
        if let Some(server_deafened) = partial.server_deafened {
            next.server_deafened = server_deafened;
        }
        if let Some(screensharing) = partial.screensharing {
            next.screensharing = screensharing;
        }

        if next == previous {
            return Ok(false);
        }
        next.version += 1;
        if save_current_voice_session(&previous, &next).await? {
            return Ok(true);
        }
    }

    Ok(false)
}

pub async fn get_voice_channel_members(channel: &UserVoiceChannel) -> Result<Option<Vec<String>>> {
    get_connection()
        .await?
        .smembers::<_, Option<Vec<String>>>(voice_channel_members_key(&channel.id))
        .await
        .to_internal_error()
        .map(|opt| opt.and_then(|v| if v.is_empty() { None } else { Some(v) }))
}

fn consistent_voice_node<'a>(mut nodes: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let node = nodes.next()?;
    nodes.all(|candidate| candidate == node).then_some(node)
}

fn voice_session_is_within_transient_grace(expires_at: Timestamp, now: Timestamp) -> bool {
    expires_at > now
}

async fn refresh_current_voice_session_projections(sessions: &[VoiceSession]) -> Result<()> {
    for session in sessions {
        refresh_current_voice_session_projection(session).await?;
    }
    Ok(())
}

async fn refresh_current_voice_session_projection(session: &VoiceSession) -> Result<()> {
    for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
        let Some(previous) = get_current_voice_session(&session.user_id).await? else {
            return Ok(());
        };
        if previous.operation_id != session.operation_id
            || previous.state != VoiceSessionState::Active
            || !same_voice_channel(&previous.channel, &session.channel)
        {
            return Ok(());
        }

        let now = Timestamp::now_utc();
        if !voice_session_is_within_transient_grace(previous.expires_at, now) {
            return Ok(());
        }
        let mut next = previous.clone();
        next.expires_at = now
            .checked_add(Duration::seconds(VOICE_SESSION_TTL_SECONDS as i64))
            .ok_or_else(|| create_error!(InternalError))?;
        if refresh_active_voice_session_projection_ttl(&previous, &next).await? {
            return Ok(());
        }
    }
    Ok(())
}

pub async fn get_voice_participant_reconciliation(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
) -> Result<VoiceParticipantReconciliationVerdict> {
    let redis_members = get_voice_channel_members(channel)
        .await?
        .unwrap_or_default();
    let mut current_sessions = Vec::new();
    for user_id in &redis_members {
        if let Some(session) = get_current_voice_session(user_id).await? {
            if same_voice_channel(&session.channel, channel)
                && session.state == VoiceSessionState::Active
            {
                current_sessions.push(session);
            }
        }
    }
    let mut current_operations = current_sessions
        .iter()
        .map(|session| (session.user_id.clone(), session.operation_id.clone()))
        .collect::<Vec<_>>();
    let mut prepared_users = Vec::new();
    for session in &current_sessions {
        if let Some(reservation) = get_current_voice_reservation(&session.user_id).await? {
            if reservation.expected_finalized_operation_id.as_deref()
                == Some(session.operation_id.as_str())
            {
                prepared_users.push(session.user_id.clone());
            }
        }
    }
    for reservation in get_current_voice_reservations_for_channel(channel).await? {
        if !prepared_users.contains(&reservation.user_id) {
            prepared_users.push(reservation.user_id.clone());
        }
        if !current_operations.iter().any(|(user_id, operation_id)| {
            user_id == &reservation.user_id && operation_id == &reservation.operation_id
        }) {
            current_operations.push((reservation.user_id, reservation.operation_id));
        }
    }
    let node = match get_channel_node(&channel.id).await? {
        Some(node) => node,
        None => {
            let Some(node) =
                consistent_voice_node(current_sessions.iter().map(|session| session.node.as_str()))
            else {
                log::warn!(
                    "Skipping voice reconciliation for channel {} because no consistent voice node is recorded",
                    channel.id
                );
                return Ok(VoiceParticipantReconciliationVerdict::SkipTransient);
            };
            let node = node.to_owned();
            log::warn!(
                "Using the active voice session to probe the missing node projection for channel {}",
                channel.id
            );
            node
        }
    };

    let livekit_participants = match voice_client
        .list_room_participants(&node, &channel.id)
        .await
    {
        Ok(Some(participants)) => participants,
        Ok(None) => {
            return Ok(VoiceParticipantReconciliationVerdict::DeadRoom {
                stale_members: redis_members,
            });
        }
        Err(error) => {
            log::warn!(
                "Skipping voice reconciliation for channel {} on node {node}: {error}",
                channel.id
            );
            refresh_current_voice_session_projections(&current_sessions).await?;
            return Ok(VoiceParticipantReconciliationVerdict::SkipTransient);
        }
    };

    for participant in &livekit_participants {
        let user_id = base_voice_identity(&participant.identity);
        if let Some(reservation) = get_current_voice_reservation(user_id).await? {
            if same_voice_channel(&reservation.channel, channel) {
                if !prepared_users.contains(&reservation.user_id) {
                    prepared_users.push(reservation.user_id.clone());
                }
                if !current_operations
                    .iter()
                    .any(|(existing_user, existing_operation)| {
                        existing_user == &reservation.user_id
                            && existing_operation == &reservation.operation_id
                    })
                {
                    current_operations.push((reservation.user_id, reservation.operation_id));
                }
            }
        }
    }

    let reconciliation = voice_participant_reconciliation_with_current_operations(
        &redis_members,
        &livekit_participants,
        &current_operations,
        &prepared_users,
    );

    for session in &current_sessions {
        if reconciliation.livekit_members.contains(&session.user_id) {
            refresh_current_voice_session_projection(session).await?;
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

        let Some(active_session) = get_active_voice_session_for_user(&user.id).await? else {
            return Ok(());
        };
        if !same_voice_channel(&active_session.channel, &user_voice_channel) {
            return Ok(());
        }
        let voice_state = active_session.voice_state(Timestamp::UNIX_EPOCH);

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
                &browser_voice_identity(&user.id, &active_session.operation_id),
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
    operation_id: &str,
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
            format!("call_notification_recipients:{channel_id}:{user_id}:{operation_id}"),
            recipients,
            ttl_seconds,
        )
        .await
        .to_internal_error()
}

pub async fn get_call_notification_recipients(
    channel_id: &str,
    user_id: &str,
    operation_id: &str,
) -> Result<Option<Vec<String>>> {
    let raw: Option<String> = get_connection()
        .await?
        .get(format!(
            "call_notification_recipients:{channel_id}:{user_id}:{operation_id}"
        ))
        .await
        .to_internal_error()?;

    raw.map(|raw| serde_json::from_str(&raw).to_internal_error())
        .transpose()
}

pub async fn clear_call_notification_recipients(
    channel_id: &str,
    user_id: &str,
    operation_id: &str,
) -> Result<()> {
    get_connection()
        .await?
        .del(format!(
            "call_notification_recipients:{channel_id}:{user_id}:{operation_id}"
        ))
        .await
        .to_internal_error()
}

pub async fn remove_user_from_voice_channel(
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    cancel_current_pending_voice_join(user_id).await?;
    if let Some(operation_id) = delete_voice_state(channel, user_id).await? {
        EventV1::VoiceChannelLeave {
            id: channel.id.clone(),
            user: user_id.to_string(),
            operation_id: Some(operation_id),
        }
        .p(channel.id.clone())
        .await;
    }

    Ok(())
}

pub async fn reconcile_pending_voice_transport_cleanups(voice_client: &VoiceClient) -> Result<()> {
    for cleanup in list_voice_transport_cleanups().await? {
        let participants = match async_std::future::timeout(
            std::time::Duration::from_secs(2),
            voice_client.list_room_participants(&cleanup.node, &cleanup.channel.id),
        )
        .await
        {
            Ok(Ok(Some(participants))) => participants,
            Ok(Ok(None)) => {
                complete_voice_transport_cleanup(&cleanup).await?;
                continue;
            }
            Ok(Err(_)) | Err(_) => continue,
        };

        let identities = participants
            .iter()
            .filter(|participant| voice_cleanup_matches_participant(&cleanup, participant))
            .map(|participant| participant.identity.clone())
            .collect::<Vec<_>>();
        for identity in identities {
            let _ = async_std::future::timeout(
                std::time::Duration::from_secs(2),
                voice_client.remove_user(&cleanup.node, &identity, &cleanup.channel.id),
            )
            .await;
        }

        let remaining = match async_std::future::timeout(
            std::time::Duration::from_secs(2),
            voice_client.list_room_participants(&cleanup.node, &cleanup.channel.id),
        )
        .await
        {
            Ok(Ok(Some(participants))) => participants,
            Ok(Ok(None)) => Vec::new(),
            Ok(Err(_)) | Err(_) => continue,
        };
        if !remaining
            .iter()
            .any(|participant| voice_cleanup_matches_participant(&cleanup, participant))
        {
            complete_voice_transport_cleanup(&cleanup).await?;
        }
    }
    Ok(())
}

fn voice_cleanup_matches_participant(
    cleanup: &VoiceTransportCleanup,
    participant: &ParticipantInfo,
) -> bool {
    if is_desktop_native_voice_identity(&participant.identity) {
        return base_voice_identity(&participant.identity) == cleanup.user_id.as_str()
            && desktop_native_voice_operation_id(&participant.identity)
                == Some(cleanup.operation_id.as_str());
    }
    base_voice_identity(&participant.identity) == cleanup.user_id.as_str()
        && browser_voice_operation_id(participant).as_deref() == Some(cleanup.operation_id.as_str())
}

pub async fn cancel_current_pending_voice_join(user_id: &str) -> Result<bool> {
    for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
        let Some(reservation) = get_current_voice_reservation(user_id).await? else {
            return Ok(false);
        };
        if delete_current_voice_reservation(&reservation).await? {
            return Ok(true);
        }
    }

    Err(create_error!(InvalidOperation))
}

pub async fn cancel_current_pending_voice_join_in_server(
    user_id: &str,
    server_id: &str,
) -> Result<bool> {
    for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
        let Some(reservation) = get_current_voice_reservation(user_id).await? else {
            return Ok(false);
        };
        if reservation.channel.server_id.as_deref() != Some(server_id) {
            return Ok(false);
        }
        if delete_current_voice_reservation(&reservation).await? {
            return Ok(true);
        }
    }

    Err(create_error!(InvalidOperation))
}

pub async fn delete_voice_channel(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
) -> Result<()> {
    for reservation in get_current_voice_reservations_for_channel(channel).await? {
        let mut current = reservation;
        let mut canceled = false;
        for _ in 0..VOICE_SESSION_MUTATION_RETRY_LIMIT {
            if delete_current_voice_reservation(&current).await? {
                canceled = true;
                break;
            }
            let Some(next) = get_current_voice_reservation(&current.user_id).await? else {
                canceled = true;
                break;
            };
            if !same_voice_channel(&next.channel, channel) {
                canceled = true;
                break;
            }
            current = next;
        }
        if !canceled {
            return Err(create_error!(InvalidOperation));
        }
    }

    if let Some(node) = get_channel_node(&channel.id).await? {
        let _ = voice_client.delete_room(&node, &channel.id).await;
    }

    let users = get_voice_channel_members(channel)
        .await?
        .unwrap_or_default();
    let deleted_sessions = delete_channel_voice_state(channel, &users).await?;

    for (user_id, operation_id) in deleted_sessions {
        EventV1::VoiceChannelLeave {
            id: channel.id.clone(),
            user: user_id,
            operation_id: Some(operation_id),
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
    use iso8601_timestamp::{Duration, Timestamp};
    use std::collections::HashMap;
    use syrnike_models::v0::PartialUserVoiceState;

    #[test]
    fn consistent_voice_node_requires_one_shared_node() {
        assert_eq!(
            super::consistent_voice_node(std::iter::empty::<&str>()),
            None
        );
        assert_eq!(
            super::consistent_voice_node(["node-a", "node-a"].into_iter()),
            Some("node-a")
        );
        assert_eq!(
            super::consistent_voice_node(["node-a", "node-b"].into_iter()),
            None
        );
    }

    #[test]
    fn transient_projection_refresh_has_a_fixed_session_deadline() {
        let now = Timestamp::UNIX_EPOCH + Duration::seconds(60);

        assert!(super::voice_session_is_within_transient_grace(
            Timestamp::UNIX_EPOCH + Duration::seconds(61),
            now,
        ));
        assert!(!super::voice_session_is_within_transient_grace(
            Timestamp::UNIX_EPOCH + Duration::seconds(60),
            now,
        ));
        assert!(!super::voice_session_is_within_transient_grace(
            Timestamp::UNIX_EPOCH + Duration::seconds(59),
            now,
        ));
    }

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
        let browser_operation = "voice-op-550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(
            super::browser_voice_identity("user-a", browser_operation),
            format!("user-a:browser:{browser_operation}")
        );
        assert_eq!(
            super::base_voice_identity(&super::browser_voice_identity("user-a", browser_operation)),
            "user-a"
        );
        assert_eq!(
            super::browser_voice_operation_id_from_identity(&super::browser_voice_identity(
                "user-a",
                browser_operation
            )),
            Some(browser_operation)
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

    #[ignore = "requires Redis"]
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

    #[ignore]
    #[async_std::test]
    async fn retained_restore_keeps_signed_operation_and_clears_pending_reservation() {
        let user_id = "user-retained";
        let active_channel = super::UserVoiceChannel {
            id: "voice-retained".to_string(),
            server_id: Some("server-a".to_string()),
        };
        let pending_channel = super::UserVoiceChannel {
            id: "voice-pending".to_string(),
            server_id: Some("server-a".to_string()),
        };
        let joined_at = Timestamp::UNIX_EPOCH + Duration::seconds(1);
        let now = Timestamp::UNIX_EPOCH + Duration::seconds(2);

        let mut conn = super::get_connection()
            .await
            .expect("redis connection")
            .into_inner();
        let _: () = redis_kiss::redis::pipe()
            .del(super::voice_current_key(user_id))
            .del(super::voice_reservation_current_key(user_id))
            .del(super::voice_session_key("op-active"))
            .del(super::voice_session_key("op-restored"))
            .del(super::voice_reservation_key("op-pending"))
            .query_async(&mut conn)
            .await
            .expect("cleanup");

        let active = super::VoiceSession {
            operation_id: "op-active".to_string(),
            replaces_operation_id: None,
            user_id: user_id.to_string(),
            channel: active_channel.clone(),
            node: "node-a".to_string(),
            room_sid: Some("room-a".to_string()),
            participant_sid: Some("participant-a".to_string()),
            state: super::VoiceSessionState::Active,
            self_mute: true,
            self_deaf: false,
            server_muted: false,
            server_deafened: false,
            screensharing: true,
            camera: false,
            version: 7,
            joined_at: Some(joined_at),
            created_at: Timestamp::UNIX_EPOCH,
            updated_at: joined_at,
            expires_at: now + Duration::seconds(120),
            failure_reason: None,
        };
        assert!(super::create_voice_session_if_current(&active, None)
            .await
            .expect("prepare active"));
        assert!(super::save_current_voice_session(&active, &active)
            .await
            .expect("save active"));

        let pending = super::VoiceSession::new_awaiting_join(super::VoiceSessionCreate {
            operation_id: "op-pending".to_string(),
            user_id: user_id.to_string(),
            channel: pending_channel,
            node: "node-b".to_string(),
            self_mute: false,
            self_deaf: false,
            created_at: now,
            expires_at: now + Duration::seconds(120),
        });
        assert!(
            super::create_voice_session_if_current(&pending, Some("op-active"))
                .await
                .expect("prepare pending replacement")
        );

        super::retain_current_voice_operation_id(
            &super::VoiceClient::new(HashMap::new()),
            &active_channel,
            user_id,
            "op-pending",
            "op-active",
        )
        .await
        .expect("retained restore");

        let current = super::get_current_voice_session(user_id)
            .await
            .expect("current")
            .expect("active session");
        assert_eq!(current.operation_id, "op-active");
        assert_eq!(current.room_sid.as_deref(), Some("room-a"));
        assert_eq!(current.participant_sid.as_deref(), Some("participant-a"));
        assert_eq!(current.version, 7);
        assert_eq!(
            super::get_current_voice_reservation(user_id)
                .await
                .expect("current reservation"),
            None
        );
    }

    #[ignore]
    #[async_std::test]
    async fn retained_restore_rejects_stale_expected_reservation_operation() {
        let user_id = "user-retained-stale";
        let active_channel = super::UserVoiceChannel {
            id: "voice-retained-stale".to_string(),
            server_id: Some("server-a".to_string()),
        };
        let pending_channel = super::UserVoiceChannel {
            id: "voice-pending-stale".to_string(),
            server_id: Some("server-a".to_string()),
        };
        let now = Timestamp::UNIX_EPOCH + Duration::seconds(2);

        let mut conn = super::get_connection()
            .await
            .expect("redis connection")
            .into_inner();
        let _: () = redis_kiss::redis::pipe()
            .del(super::voice_current_key(user_id))
            .del(super::voice_reservation_current_key(user_id))
            .del(super::voice_session_key("op-active"))
            .del(super::voice_reservation_key("op-pending"))
            .query_async(&mut conn)
            .await
            .expect("cleanup");

        let active = super::VoiceSession {
            operation_id: "op-active".to_string(),
            replaces_operation_id: None,
            user_id: user_id.to_string(),
            channel: active_channel.clone(),
            node: "node-a".to_string(),
            room_sid: Some("room-a".to_string()),
            participant_sid: Some("participant-a".to_string()),
            state: super::VoiceSessionState::Active,
            self_mute: true,
            self_deaf: false,
            server_muted: false,
            server_deafened: false,
            screensharing: true,
            camera: false,
            version: 7,
            joined_at: Some(now),
            created_at: Timestamp::UNIX_EPOCH,
            updated_at: now,
            expires_at: now + Duration::seconds(120),
            failure_reason: None,
        };
        assert!(super::create_voice_session_if_current(&active, None)
            .await
            .expect("prepare active"));
        assert!(super::save_current_voice_session(&active, &active)
            .await
            .expect("save active"));

        let pending = super::VoiceSession::new_awaiting_join(super::VoiceSessionCreate {
            operation_id: "op-pending".to_string(),
            user_id: user_id.to_string(),
            channel: pending_channel,
            node: "node-b".to_string(),
            self_mute: false,
            self_deaf: false,
            created_at: now,
            expires_at: now + Duration::seconds(120),
        });
        assert!(
            super::create_voice_session_if_current(&pending, Some("op-active"))
                .await
                .expect("prepare pending replacement")
        );

        let error = super::retain_current_voice_operation_id(
            &super::VoiceClient::new(HashMap::new()),
            &active_channel,
            user_id,
            "op-stale",
            "op-active",
        )
        .await
        .expect_err("stale expected reservation must fail");

        assert!(matches!(
            error.error_type,
            syrnike_result::ErrorType::InvalidOperation
        ));
        assert_eq!(
            super::get_current_voice_session(user_id)
                .await
                .expect("current session")
                .map(|session| session.operation_id),
            Some("op-active".to_string())
        );
        assert_eq!(
            super::get_current_voice_reservation(user_id)
                .await
                .expect("current reservation")
                .map(|reservation| reservation.operation_id),
            Some("op-pending".to_string())
        );
    }
}
