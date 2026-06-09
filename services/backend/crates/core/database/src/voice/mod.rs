use std::fmt::{Display, Write};

use serde::{Deserialize, Serialize};

use crate::{
    events::client::EventV1,
    models::{Channel, User},
    util::{permissions::DatabasePermissionQuery, reference::Reference},
    Database, Server,
};
use iso8601_timestamp::{Duration, Timestamp};
use livekit_protocol::ParticipantPermission;
use redis_kiss::{
    get_connection as _get_connection,
    redis::{FromRedisValue, Pipeline, RedisError, RedisWrite, ToRedisArgs, Value},
    AsyncCommands, Conn,
};
use syrnike_config::FeaturesLimits;
use syrnike_models::v0::{self, PartialUserVoiceState, UserVoiceState};
use syrnike_permissions::{calculate_channel_permissions, ChannelPermission, PermissionValue};
use syrnike_result::{create_error, Result, ToSyrnikeError};

mod join;
mod voice_client;
pub use join::*;
pub use voice_client::VoiceClient;

/// Client join intent stored until LiveKit `participant_joined` webhook confirms membership.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceJoinIntent {
    pub channel: UserVoiceChannel,
    pub self_mute: bool,
    pub self_deaf: bool,
}

const DESKTOP_NATIVE_IDENTITY_SUFFIX: &str = ":desktop-native";

pub fn desktop_native_voice_identity(user_id: &str, media_kind: &str) -> String {
    format!("{user_id}{DESKTOP_NATIVE_IDENTITY_SUFFIX}:{media_kind}")
}

pub fn desktop_native_voice_identities(user_id: &str) -> [String; 3] {
    [
        desktop_native_voice_identity(user_id, "microphone"),
        desktop_native_voice_identity(user_id, "screen"),
        desktop_native_voice_identity(user_id, "camera"),
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

async fn get_connection() -> Result<Conn> {
    _get_connection()
        .await
        .map_err(|_| create_error!(InternalError))
}

pub async fn raise_if_in_voice(user: &User, channel: &UserVoiceChannel) -> Result<()> {
    let mut conn = get_connection().await?;

    if user.bot.is_some() {
        // bots can be in as many voice channels as it wants so we just check if its already connected to the one its trying to connect to
        if conn
            .sismember(format!("vc:{}", &user.id), channel)
            .await
            .to_internal_error()?
        {
            return Err(create_error!(AlreadyConnected));
        };
    } else if conn
        .scard::<_, u32>(format!("vc:{}", &user.id)) // check if the current vc set is empty
        .await
        .to_internal_error()?
        > 0
    {
        return Err(create_error!(AlreadyConnected));
    };

    Ok(())
}

pub async fn set_channel_node(channel_id: &str, node: &str) -> Result<()> {
    get_connection()
        .await?
        .set(format!("node:{channel_id}"), node)
        .await
        .to_internal_error()
}

pub async fn get_channel_node(channel_id: &str) -> Result<Option<String>> {
    get_connection()
        .await?
        .get(format!("node:{channel_id}"))
        .await
        .to_internal_error()
}

pub async fn delete_channel_node(channel_id: &str) -> Result<()> {
    get_connection()
        .await?
        .del(format!("node:{channel_id}"))
        .await
        .to_internal_error()
}

pub async fn get_user_voice_channels(user_id: &str) -> Result<Vec<UserVoiceChannel>> {
    get_connection()
        .await?
        .smembers(format!("vc:{user_id}"))
        .await
        .to_internal_error()
}

pub async fn set_user_voice_join_intent(
    user_id: &str,
    channel: &UserVoiceChannel,
    self_mute: bool,
    self_deaf: bool,
) -> Result<()> {
    let intent = VoiceJoinIntent {
        channel: channel.clone(),
        self_mute,
        self_deaf,
    };

    get_connection()
        .await?
        .set_ex(format!("voice_join_intent:{user_id}"), intent, 30)
        .await
        .to_internal_error()
}

pub async fn get_user_voice_join_intent(user_id: &str) -> Result<Option<VoiceJoinIntent>> {
    get_connection()
        .await?
        .get(format!("voice_join_intent:{user_id}"))
        .await
        .to_internal_error()
}

pub async fn user_voice_join_intent_matches(
    user_id: &str,
    channel: &UserVoiceChannel,
) -> Result<bool> {
    let latest = get_user_voice_join_intent(user_id).await?;

    match latest {
        Some(latest) => Ok(latest.channel == *channel),
        None => is_in_voice_channel(user_id, channel).await,
    }
}

pub async fn clear_user_voice_join_intent_if_matches(
    user_id: &str,
    channel: &UserVoiceChannel,
) -> Result<()> {
    let key = format!("voice_join_intent:{user_id}");
    let latest = get_user_voice_join_intent(user_id).await?;

    if latest
        .as_ref()
        .is_some_and(|latest| latest.channel == *channel)
    {
        get_connection()
            .await?
            .del::<_, ()>(key)
            .await
            .to_internal_error()?;
    }

    Ok(())
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

pub async fn is_in_voice_channel(user_id: &str, channel: &UserVoiceChannel) -> Result<bool> {
    get_connection()
        .await?
        .sismember(format!("vc:{user_id}"), channel)
        .await
        .to_internal_error()
}

pub async fn get_user_voice_channel_in_server(
    user_id: &str,
    server_id: &str,
) -> Result<Option<String>> {
    let mut conn = get_connection().await?;

    let unique_key = format!("{user_id}:{server_id}");

    conn.get(&unique_key).await.to_internal_error()
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

pub async fn create_voice_state(
    channel: &UserVoiceChannel,
    user_id: &str,
    joined_at: Timestamp,
    session_id: Option<&str>,
    room_id: Option<&str>,
) -> Result<UserVoiceState> {
    let unique_key = voice_state_unique_key(channel, user_id);

    let join_intent = get_user_voice_join_intent(user_id).await?;

    let mut conn = get_connection().await?;
    let (
        existing_joined_at,
        self_mute,
        self_deaf,
        server_muted,
        server_deafened,
        screensharing,
        camera,
        version,
    ): (
        Option<i64>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<u64>,
    ) = conn
        .mget(&[
            format!("joined_at:{unique_key}"),
            format!("self_mute:{unique_key}"),
            format!("self_deaf:{unique_key}"),
            format!("server_muted:{unique_key}"),
            format!("server_deafened:{unique_key}"),
            format!("screensharing:{unique_key}"),
            format!("camera:{unique_key}"),
            format!("version:{unique_key}"),
        ])
        .await
        .to_internal_error()?;

    let pending_track_state = existing_joined_at.is_none();
    let intent_flags = join_intent
        .as_ref()
        .filter(|intent| intent.channel == *channel)
        .map(|intent| (intent.self_mute, intent.self_deaf));

    let voice_state = UserVoiceState {
        joined_at,
        id: user_id.to_string(),
        self_mute: if pending_track_state {
            intent_flags
                .map(|(mute, _)| mute)
                .or(self_mute)
                .unwrap_or(false)
        } else {
            self_mute.unwrap_or(false)
        },
        self_deaf: if pending_track_state {
            intent_flags
                .map(|(_, deaf)| deaf)
                .or(self_deaf)
                .unwrap_or(false)
        } else {
            self_deaf.unwrap_or(false)
        },
        server_muted: server_muted.unwrap_or(false),
        server_deafened: server_deafened.unwrap_or(false),
        screensharing: if pending_track_state {
            screensharing.unwrap_or(false)
        } else {
            false
        },
        camera: if pending_track_state {
            camera.unwrap_or(false)
        } else {
            false
        },
        version: if pending_track_state {
            1
        } else {
            version.unwrap_or(1)
        },
    };

    let mut pipeline = Pipeline::new();
    pipeline
        .sadd(format!("vc_members:{}", &channel.id), user_id)
        .sadd(format!("vc:{user_id}"), channel)
        .set(&unique_key, &channel.id)
        .set(
            format!("joined_at:{unique_key}"),
            joined_at
                .duration_since(Timestamp::UNIX_EPOCH)
                .whole_milliseconds() as i64,
        )
        .set(format!("self_mute:{unique_key}"), voice_state.self_mute)
        .set(format!("self_deaf:{unique_key}"), voice_state.self_deaf)
        .set(
            format!("server_muted:{unique_key}"),
            voice_state.server_muted,
        )
        .set(
            format!("server_deafened:{unique_key}"),
            voice_state.server_deafened,
        )
        .set(
            format!("screensharing:{unique_key}"),
            voice_state.screensharing,
        )
        .set(format!("camera:{unique_key}"), voice_state.camera)
        .set(format!("version:{unique_key}"), voice_state.version);

    if let Some(session_id) = session_id.filter(|session_id| !session_id.is_empty()) {
        pipeline.set(voice_session_key(&unique_key), session_id);
    }

    if let Some(room_id) = room_id.filter(|room_id| !room_id.is_empty()) {
        pipeline.set(voice_room_session_key(&channel.id), room_id);
    }

    pipeline
        .query_async::<_, ()>(&mut conn.into_inner())
        .await
        .to_internal_error()?;

    Ok(voice_state)
}

pub async fn delete_voice_state(channel: &UserVoiceChannel, user_id: &str) -> Result<()> {
    let unique_key = voice_state_unique_key(channel, user_id);

    Pipeline::new()
        .srem(format!("vc_members:{}", &channel.id), user_id)
        .srem(format!("vc:{user_id}"), channel)
        .del(&[
            format!("joined_at:{unique_key}"),
            format!("self_mute:{unique_key}"),
            format!("self_deaf:{unique_key}"),
            format!("server_muted:{unique_key}"),
            format!("server_deafened:{unique_key}"),
            format!("screensharing:{unique_key}"),
            format!("camera:{unique_key}"),
            format!("version:{unique_key}"),
            voice_session_key(&unique_key),
            unique_key.clone(),
        ])
        .query_async::<_, ()>(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()?;

    clear_user_voice_join_intent_if_matches(user_id, channel).await
}

pub async fn delete_voice_state_for_session(
    channel: &UserVoiceChannel,
    user_id: &str,
    session_id: &str,
) -> Result<bool> {
    if !voice_session_matches(channel, user_id, session_id).await? {
        return Ok(false);
    }

    delete_voice_state(channel, user_id).await?;
    Ok(true)
}

pub async fn delete_channel_voice_state(
    channel: &UserVoiceChannel,
    user_ids: &[String],
) -> Result<()> {
    let parent_id = channel.server_id.as_ref().unwrap_or(&channel.id);

    let mut pipeline = Pipeline::new();
    pipeline.del(format!("vc_members:{}", &channel.id));
    pipeline.del(format!("node:{}", &channel.id));
    pipeline.del(voice_room_session_key(&channel.id));

    for user_id in user_ids {
        let unique_key = format!("{user_id}:{parent_id}");

        pipeline.srem(format!("vc:{user_id}"), channel).del(&[
            format!("joined_at:{unique_key}"),
            format!("self_mute:{unique_key}"),
            format!("self_deaf:{unique_key}"),
            format!("server_muted:{unique_key}"),
            format!("server_deafened:{unique_key}"),
            format!("screensharing:{unique_key}"),
            format!("camera:{unique_key}"),
            format!("version:{unique_key}"),
            voice_session_key(&unique_key),
            unique_key.clone(),
        ]);
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

pub async fn update_voice_state_tracks(
    channel: &UserVoiceChannel,
    user_id: &str,
    added: bool,
    track: i32,
) -> Result<Option<UserVoiceState>> {
    let partial = partial_voice_state_for_track(added, track);
    if partial == PartialUserVoiceState::default() {
        return Ok(None);
    }

    update_voice_state(channel, user_id, &partial).await?;
    bump_voice_state_version(channel, user_id).await?;
    get_voice_state(channel, user_id).await
}

pub async fn update_voice_state_tracks_for_session(
    channel: &UserVoiceChannel,
    user_id: &str,
    added: bool,
    track: i32,
    session_id: &str,
) -> Result<Option<UserVoiceState>> {
    if !voice_session_matches(channel, user_id, session_id).await? {
        return Ok(None);
    }

    update_voice_state_tracks(channel, user_id, added, track).await
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
    let unique_key = voice_state_unique_key(channel, user_id);

    get_voice_state(channel, user_id)
        .await?
        .ok_or_else(|| create_error!(NotConnected))?;

    let mut pipeline = Pipeline::new();
    pipeline
        .atomic()
        .set(format!("self_mute:{unique_key}"), self_mute)
        .set(format!("self_deaf:{unique_key}"), self_deaf)
        .incr(format!("version:{unique_key}"), 1)
        .query_async(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()?;

    get_voice_state(channel, user_id)
        .await?
        .ok_or_else(|| create_error!(InternalError))
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
) -> Result<()> {
    let unique_key = voice_state_unique_key(channel, user_id);

    let mut pipeline = Pipeline::new();

    if let Some(camera) = &partial.camera {
        pipeline.set(format!("camera:{unique_key}"), camera);
    };

    if let Some(self_mute) = &partial.self_mute {
        pipeline.set(format!("self_mute:{unique_key}"), self_mute);
    }

    if let Some(self_deaf) = &partial.self_deaf {
        pipeline.set(format!("self_deaf:{unique_key}"), self_deaf);
    }

    if let Some(server_muted) = &partial.server_muted {
        pipeline.set(format!("server_muted:{unique_key}"), server_muted);
    }

    if let Some(server_deafened) = &partial.server_deafened {
        pipeline.set(format!("server_deafened:{unique_key}"), server_deafened);
    }

    if let Some(screensharing) = &partial.screensharing {
        pipeline.set(format!("screensharing:{unique_key}"), screensharing);
    }

    pipeline
        .query_async(&mut get_connection().await?.into_inner())
        .await
        .to_internal_error()
}

async fn bump_voice_state_version(channel: &UserVoiceChannel, user_id: &str) -> Result<u64> {
    let unique_key = voice_state_unique_key(channel, user_id);
    let version_key = format!("version:{unique_key}");

    get_connection()
        .await?
        .incr::<_, u64>(&version_key, 1)
        .await
        .to_internal_error()
}

pub async fn get_voice_channel_members(channel: &UserVoiceChannel) -> Result<Option<Vec<String>>> {
    get_connection()
        .await?
        .smembers::<_, Option<Vec<String>>>(format!("vc_members:{}", &channel.id))
        .await
        .to_internal_error()
        .map(|opt| opt.and_then(|v| if v.is_empty() { None } else { Some(v) }))
}

pub async fn get_voice_state(
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<Option<UserVoiceState>> {
    let unique_key = voice_state_unique_key(channel, user_id);

    let (
        joined_at,
        self_mute,
        self_deaf,
        server_muted,
        server_deafened,
        screensharing,
        camera,
        version,
    ): (
        Option<i64>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<bool>,
        Option<u64>,
    ) = get_connection()
        .await?
        .mget(&[
            format!("joined_at:{unique_key}"),
            format!("self_mute:{unique_key}"),
            format!("self_deaf:{unique_key}"),
            format!("server_muted:{unique_key}"),
            format!("server_deafened:{unique_key}"),
            format!("screensharing:{unique_key}"),
            format!("camera:{unique_key}"),
            format!("version:{unique_key}"),
        ])
        .await
        .to_internal_error()?;

    match (
        joined_at,
        self_mute,
        self_deaf,
        server_muted,
        server_deafened,
        screensharing,
        camera,
        version,
    ) {
        (
            Some(joined_at),
            Some(self_mute),
            Some(self_deaf),
            server_muted,
            server_deafened,
            Some(screensharing),
            Some(camera),
            version,
        ) => Ok(Some(v0::UserVoiceState {
            joined_at: Timestamp::UNIX_EPOCH
                .checked_add(Duration::milliseconds(joined_at))
                .unwrap(),
            id: user_id.to_string(),
            self_mute,
            self_deaf,
            server_muted: server_muted.unwrap_or(false),
            server_deafened: server_deafened.unwrap_or(false),
            screensharing,
            camera,
            version: version.unwrap_or(1),
        })),
        _ => Ok(None),
    }
}

fn voice_state_unique_key(channel: &UserVoiceChannel, user_id: &str) -> String {
    format!(
        "{}:{}",
        user_id,
        channel.server_id.as_ref().unwrap_or(&channel.id)
    )
}

fn voice_session_key(unique_key: &str) -> String {
    format!("session:{unique_key}")
}

fn voice_room_session_key(channel_id: &str) -> String {
    format!("room_session:{channel_id}")
}

async fn voice_session_matches(
    channel: &UserVoiceChannel,
    user_id: &str,
    session_id: &str,
) -> Result<bool> {
    let unique_key = voice_state_unique_key(channel, user_id);
    let current: Option<String> = get_connection()
        .await?
        .get(voice_session_key(&unique_key))
        .await
        .to_internal_error()?;

    Ok(current
        .as_deref()
        .is_none_or(|current| current == session_id))
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

                delete_voice_state(channel, &user_id).await?;
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

pub async fn move_user(user: &str, from_channel_id: &str, to_channel_id: &str) -> Result<()> {
    get_connection()
        .await?
        .smove(
            format!("vc_members:{from_channel_id}"),
            format!("vc_members:{to_channel_id}"),
            user,
        )
        .await
        .to_internal_error()
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

        update_voice_state(&user_voice_channel, &user.id, &update_event).await?;

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

        if update_event != before {
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

pub async fn take_channel_call_started_system_message(channel_id: &str) -> Result<Option<String>> {
    get_connection()
        .await?
        .get_del(format!("call_started_message:{channel_id}"))
        .await
        .to_internal_error()
}

pub async fn set_call_notification_recipients(
    channel_id: &str,
    user_id: &str,
    recipients: &[String],
) -> Result<()> {
    get_connection()
        .await?
        .set_ex(
            format!("call_notification_recipients:{channel_id}-{user_id}"),
            recipients,
            10,
        )
        .await
        .to_internal_error()
}

pub async fn get_call_notification_recipients(
    channel_id: &str,
    user_id: &str,
) -> Result<Option<Vec<String>>> {
    get_connection()
        .await?
        .get_del(format!(
            "call_notification_recipients:{channel_id}-{user_id}"
        ))
        .await
        .to_internal_error()
}

pub async fn remove_user_from_voice_channels(
    voice_client: &VoiceClient,
    user_id: &str,
) -> Result<()> {
    for channel in get_user_voice_channels(user_id).await? {
        remove_user_from_voice_channel(voice_client, &channel, user_id).await?;
    }

    Ok(())
}

pub async fn remove_user_from_voice_channel(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
    user_id: &str,
) -> Result<()> {
    if let Some(node) = get_channel_node(&channel.id).await? {
        let _ = voice_client.remove_user(&node, user_id, &channel.id).await;
    }

    delete_voice_state(channel, user_id).await?;
    EventV1::VoiceChannelLeave {
        id: channel.id.clone(),
        user: user_id.to_string(),
    }
    .p(channel.id.clone())
    .await;

    Ok(())
}

pub async fn delete_voice_channel(
    voice_client: &VoiceClient,
    channel: &UserVoiceChannel,
) -> Result<()> {
    if let Some(users) = get_voice_channel_members(channel).await? {
        if let Some(node) = get_channel_node(&channel.id).await? {
            let _ = voice_client.delete_room(&node, &channel.id).await;
        }

        delete_channel_voice_state(channel, &users).await?;

        for user_id in users {
            EventV1::VoiceChannelLeave {
                id: channel.id.clone(),
                user: user_id,
            }
            .p(channel.id.clone())
            .await;
        }
    };

    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomMetadata {
    pub server: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserVoiceChannel {
    pub id: String,
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

impl ToRedisArgs for VoiceJoinIntent {
    fn write_redis_args<W: ?Sized + RedisWrite>(&self, out: &mut W) {
        out.write_arg(
            serde_json::to_string(self)
                .expect("VoiceJoinIntent serializes to JSON")
                .as_bytes(),
        );
    }
}

impl FromRedisValue for VoiceJoinIntent {
    fn from_redis_value(v: &Value) -> Result<Self, RedisError> {
        let raw = String::from_redis_value(v)?;
        serde_json::from_str(&raw).map_err(|error| {
            RedisError::from((
                redis_kiss::redis::ErrorKind::TypeError,
                "VoiceJoinIntent",
                error.to_string(),
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::partial_voice_state_for_track;

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
            super::desktop_native_voice_identity("user-a", "microphone"),
            "user-a:desktop-native:microphone"
        );
        assert_eq!(
            super::desktop_native_voice_identities("user-a"),
            [
                "user-a:desktop-native:microphone".to_string(),
                "user-a:desktop-native:screen".to_string(),
                "user-a:desktop-native:camera".to_string()
            ]
        );
        assert_eq!(
            super::base_voice_identity("user-a:desktop-native:microphone"),
            "user-a"
        );
        assert_eq!(super::base_voice_identity("user-a:desktop-native"), "user-a");
        assert_eq!(super::base_voice_identity("user-a"), "user-a");
        assert!(super::is_desktop_native_voice_identity(
            "user-a:desktop-native:screen"
        ));
        assert!(super::is_desktop_native_voice_identity("user-a:desktop-native"));
        assert!(!super::is_desktop_native_voice_identity("user-a"));
    }
}
