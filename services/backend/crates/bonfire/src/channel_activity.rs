use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use syrnike_database::{
    channel_activity::{
        get_channel_activity, mutate_channel_activity_if_current, ChannelActivityMutation,
        ChannelActivityMutationResult,
    },
    events::{
        client::{ChannelActivityErrorCode, ChannelActivityInstance, EventV1},
        server::ChannelActivityRequest,
    },
    iso8601_timestamp::Timestamp,
    voice::{get_active_voice_session_for_user, get_voice_channel_members, UserVoiceChannel},
    User,
};

pub const SHARED_COUNTER_APPLICATION_ID: &str = "syrnike13.shared-counter";
pub const SYRNIK_RACE_APPLICATION_ID: &str = "syrnike13.syrnik-race";

const ACTIVITY_INSTANCE_ID_PREFIX: &str = "activity-";
const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_COMMAND_BYTES: usize = 4 * 1024;
const MUTATION_RETRY_LIMIT: usize = 8;
const SYRNIK_RACE_HITS_PER_ROUND: u32 = 12;

pub async fn handle_request(
    user: &User,
    request_id: String,
    channel_id: String,
    request: ChannelActivityRequest,
) -> Option<EventV1> {
    if !valid_identifier(&request_id) || !valid_identifier(&channel_id) {
        return Some(error_event(
            request_id,
            channel_id,
            ChannelActivityErrorCode::InvalidRequest,
        ));
    }

    let result = match request {
        ChannelActivityRequest::Sync => sync_activity(user, &request_id, &channel_id).await,
        ChannelActivityRequest::Start { application_id } => {
            start_activity(user, &request_id, &channel_id, &application_id).await
        }
        ChannelActivityRequest::Join { instance_id } => {
            join_activity(user, &request_id, &channel_id, &instance_id).await
        }
        ChannelActivityRequest::Leave { instance_id } => {
            leave_activity(user, &request_id, &channel_id, &instance_id).await
        }
        ChannelActivityRequest::Command {
            instance_id,
            command,
        } => command_activity(user, &request_id, &channel_id, &instance_id, command).await,
        ChannelActivityRequest::Close { instance_id } => {
            close_activity(user, &request_id, &channel_id, &instance_id).await
        }
    };

    match result {
        Ok(HandleOutcome::Direct(event)) => Some(event),
        Ok(HandleOutcome::Published) => None,
        Err(code) => Some(error_event(request_id, channel_id, code)),
    }
}

enum HandleOutcome {
    Direct(EventV1),
    Published,
}

async fn sync_activity(
    user: &User,
    request_id: &str,
    channel_id: &str,
) -> std::result::Result<HandleOutcome, ChannelActivityErrorCode> {
    let voice_channel = require_voice_channel(&user.id, channel_id).await?;
    let active_member_ids = get_voice_channel_members(&voice_channel)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)?
        .unwrap_or_default();
    let mut current = get_channel_activity(channel_id)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)?;

    for _ in 0..MUTATION_RETRY_LIMIT {
        let Some(existing) = current.as_ref() else {
            return Ok(HandleOutcome::Direct(EventV1::ChannelActivityEmpty {
                request_id: request_id.to_string(),
                channel_id: channel_id.to_string(),
            }));
        };
        let Some(mut next) = reconcile_participants(existing, &active_member_ids) else {
            match persist(
                channel_id,
                current.as_ref(),
                ChannelActivityMutation::Delete,
            )
            .await?
            {
                ChannelActivityMutationResult::Applied => {
                    publish_closed(
                        &voice_channel,
                        Some(request_id.to_string()),
                        channel_id,
                        &existing.id,
                    )
                    .await;
                    return Ok(HandleOutcome::Published);
                }
                ChannelActivityMutationResult::Conflict(conflict) => current = conflict,
            }
            continue;
        };
        if &next == existing {
            return Ok(HandleOutcome::Direct(snapshot_event(
                Some(request_id.to_string()),
                next,
            )));
        }
        next.revision = existing.revision + 1;
        match persist(
            channel_id,
            current.as_ref(),
            ChannelActivityMutation::Set(next.clone()),
        )
        .await?
        {
            ChannelActivityMutationResult::Applied => {
                publish_snapshot(&voice_channel, Some(request_id.to_string()), next).await;
                return Ok(HandleOutcome::Published);
            }
            ChannelActivityMutationResult::Conflict(conflict) => current = conflict,
        }
    }

    Err(ChannelActivityErrorCode::Internal)
}

async fn start_activity(
    user: &User,
    request_id: &str,
    channel_id: &str,
    application_id: &str,
) -> std::result::Result<HandleOutcome, ChannelActivityErrorCode> {
    if application_initial_state(application_id).is_none() {
        return Err(ChannelActivityErrorCode::UnknownApplication);
    }
    let voice_channel = require_voice_channel(&user.id, channel_id).await?;
    let mut current = get_channel_activity(channel_id)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)?;

    for _ in 0..MUTATION_RETRY_LIMIT {
        let next = match current.as_ref() {
            Some(existing) if existing.application_id != application_id => {
                return Err(ChannelActivityErrorCode::AlreadyRunning);
            }
            Some(existing) => with_participant(existing, &user.id),
            None => ChannelActivityInstance {
                id: format!("{ACTIVITY_INSTANCE_ID_PREFIX}{}", ulid::Ulid::new()),
                application_id: application_id.to_string(),
                channel_id: channel_id.to_string(),
                server_id: voice_channel.server_id.clone(),
                owner_id: user.id.clone(),
                participant_ids: vec![user.id.clone()],
                revision: 1,
                state: application_initial_state(application_id)
                    .expect("application was validated"),
                created_at: Timestamp::now_utc(),
            },
        };

        match persist(
            channel_id,
            current.as_ref(),
            ChannelActivityMutation::Set(next.clone()),
        )
        .await?
        {
            ChannelActivityMutationResult::Applied => {
                publish_snapshot(&voice_channel, Some(request_id.to_string()), next).await;
                return Ok(HandleOutcome::Published);
            }
            ChannelActivityMutationResult::Conflict(conflict) => current = conflict,
        }
    }

    Err(ChannelActivityErrorCode::Internal)
}

async fn join_activity(
    user: &User,
    request_id: &str,
    channel_id: &str,
    instance_id: &str,
) -> std::result::Result<HandleOutcome, ChannelActivityErrorCode> {
    if !valid_identifier(instance_id) {
        return Err(ChannelActivityErrorCode::InvalidRequest);
    }
    let voice_channel = require_voice_channel(&user.id, channel_id).await?;
    let mut current = get_channel_activity(channel_id)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)?;

    for _ in 0..MUTATION_RETRY_LIMIT {
        let existing = matching_instance(current.as_ref(), instance_id)?;
        let next = with_participant(existing, &user.id);
        if &next == existing {
            return Ok(HandleOutcome::Direct(snapshot_event(
                Some(request_id.to_string()),
                next,
            )));
        }
        match persist(
            channel_id,
            current.as_ref(),
            ChannelActivityMutation::Set(next.clone()),
        )
        .await?
        {
            ChannelActivityMutationResult::Applied => {
                publish_snapshot(&voice_channel, Some(request_id.to_string()), next).await;
                return Ok(HandleOutcome::Published);
            }
            ChannelActivityMutationResult::Conflict(conflict) => current = conflict,
        }
    }

    Err(ChannelActivityErrorCode::Internal)
}

async fn leave_activity(
    user: &User,
    request_id: &str,
    channel_id: &str,
    instance_id: &str,
) -> std::result::Result<HandleOutcome, ChannelActivityErrorCode> {
    if !valid_identifier(instance_id) {
        return Err(ChannelActivityErrorCode::InvalidRequest);
    }
    let mut current = get_channel_activity(channel_id)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)?;

    for _ in 0..MUTATION_RETRY_LIMIT {
        let existing = matching_instance(current.as_ref(), instance_id)?;
        if !existing.participant_ids.iter().any(|id| id == &user.id) {
            return Ok(HandleOutcome::Direct(snapshot_event(
                Some(request_id.to_string()),
                existing.clone(),
            )));
        }

        let mut next = existing.clone();
        next.participant_ids.retain(|id| id != &user.id);
        if next.participant_ids.is_empty() {
            match persist(
                channel_id,
                current.as_ref(),
                ChannelActivityMutation::Delete,
            )
            .await?
            {
                ChannelActivityMutationResult::Applied => {
                    publish_closed(
                        &instance_voice_channel(existing),
                        Some(request_id.to_string()),
                        channel_id,
                        instance_id,
                    )
                    .await;
                    return Ok(HandleOutcome::Published);
                }
                ChannelActivityMutationResult::Conflict(conflict) => current = conflict,
            }
            continue;
        }

        if next.owner_id == user.id {
            next.owner_id = next.participant_ids[0].clone();
        }
        next.revision += 1;
        match persist(
            channel_id,
            current.as_ref(),
            ChannelActivityMutation::Set(next.clone()),
        )
        .await?
        {
            ChannelActivityMutationResult::Applied => {
                publish_snapshot(
                    &instance_voice_channel(&next),
                    Some(request_id.to_string()),
                    next,
                )
                .await;
                return Ok(HandleOutcome::Published);
            }
            ChannelActivityMutationResult::Conflict(conflict) => current = conflict,
        }
    }

    Err(ChannelActivityErrorCode::Internal)
}

async fn command_activity(
    user: &User,
    request_id: &str,
    channel_id: &str,
    instance_id: &str,
    command: Value,
) -> std::result::Result<HandleOutcome, ChannelActivityErrorCode> {
    if !valid_identifier(instance_id)
        || serde_json::to_vec(&command).map_or(true, |payload| payload.len() > MAX_COMMAND_BYTES)
    {
        return Err(ChannelActivityErrorCode::InvalidRequest);
    }
    let voice_channel = require_voice_channel(&user.id, channel_id).await?;
    let mut current = get_channel_activity(channel_id)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)?;

    for _ in 0..MUTATION_RETRY_LIMIT {
        let existing = matching_instance(current.as_ref(), instance_id)?;
        if !existing.participant_ids.iter().any(|id| id == &user.id) {
            return Err(ChannelActivityErrorCode::NotParticipant);
        }
        let mut next = existing.clone();
        next.state = application_reduce(existing, &command, &user.id)?;
        next.revision += 1;

        match persist(
            channel_id,
            current.as_ref(),
            ChannelActivityMutation::Set(next.clone()),
        )
        .await?
        {
            ChannelActivityMutationResult::Applied => {
                publish_snapshot(&voice_channel, Some(request_id.to_string()), next).await;
                return Ok(HandleOutcome::Published);
            }
            ChannelActivityMutationResult::Conflict(conflict) => current = conflict,
        }
    }

    Err(ChannelActivityErrorCode::Internal)
}

async fn close_activity(
    user: &User,
    request_id: &str,
    channel_id: &str,
    instance_id: &str,
) -> std::result::Result<HandleOutcome, ChannelActivityErrorCode> {
    let voice_channel = require_voice_channel(&user.id, channel_id).await?;
    let mut current = get_channel_activity(channel_id)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)?;

    for _ in 0..MUTATION_RETRY_LIMIT {
        let existing = matching_instance(current.as_ref(), instance_id)?;
        if existing.owner_id != user.id {
            return Err(ChannelActivityErrorCode::NotOwner);
        }
        match persist(
            channel_id,
            current.as_ref(),
            ChannelActivityMutation::Delete,
        )
        .await?
        {
            ChannelActivityMutationResult::Applied => {
                publish_closed(
                    &voice_channel,
                    Some(request_id.to_string()),
                    channel_id,
                    instance_id,
                )
                .await;
                return Ok(HandleOutcome::Published);
            }
            ChannelActivityMutationResult::Conflict(conflict) => current = conflict,
        }
    }

    Err(ChannelActivityErrorCode::Internal)
}

async fn require_voice_channel(
    user_id: &str,
    channel_id: &str,
) -> std::result::Result<UserVoiceChannel, ChannelActivityErrorCode> {
    let session = get_active_voice_session_for_user(user_id)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)?
        .ok_or(ChannelActivityErrorCode::NotInVoiceChannel)?;
    if session.channel.id != channel_id {
        return Err(ChannelActivityErrorCode::NotInVoiceChannel);
    }
    Ok(session.channel)
}

fn matching_instance<'a>(
    instance: Option<&'a ChannelActivityInstance>,
    instance_id: &str,
) -> std::result::Result<&'a ChannelActivityInstance, ChannelActivityErrorCode> {
    instance
        .filter(|current| current.id == instance_id)
        .ok_or(ChannelActivityErrorCode::InstanceNotFound)
}

fn with_participant(instance: &ChannelActivityInstance, user_id: &str) -> ChannelActivityInstance {
    if instance.participant_ids.iter().any(|id| id == user_id) {
        return instance.clone();
    }
    let mut next = instance.clone();
    next.participant_ids.push(user_id.to_string());
    next.participant_ids.sort();
    next.revision += 1;
    next
}

fn reconcile_participants(
    instance: &ChannelActivityInstance,
    active_member_ids: &[String],
) -> Option<ChannelActivityInstance> {
    let mut next = instance.clone();
    next.participant_ids
        .retain(|participant_id| active_member_ids.contains(participant_id));
    if next.participant_ids.is_empty() {
        return None;
    }
    if !next.participant_ids.contains(&next.owner_id) {
        next.owner_id = next.participant_ids[0].clone();
    }
    Some(next)
}

async fn persist(
    channel_id: &str,
    expected: Option<&ChannelActivityInstance>,
    mutation: ChannelActivityMutation,
) -> std::result::Result<ChannelActivityMutationResult, ChannelActivityErrorCode> {
    mutate_channel_activity_if_current(channel_id, expected, mutation)
        .await
        .map_err(|_| ChannelActivityErrorCode::Internal)
}

fn application_initial_state(application_id: &str) -> Option<Value> {
    match application_id {
        SHARED_COUNTER_APPLICATION_ID => Some(json!({
            "count": 0,
            "last_actor_id": null,
        })),
        SYRNIK_RACE_APPLICATION_ID => serde_json::to_value(SyrnikRaceState::default()).ok(),
        _ => None,
    }
}

fn application_reduce(
    instance: &ChannelActivityInstance,
    command: &Value,
    actor_id: &str,
) -> std::result::Result<Value, ChannelActivityErrorCode> {
    match instance.application_id.as_str() {
        SHARED_COUNTER_APPLICATION_ID => reduce_shared_counter(&instance.state, command, actor_id),
        SYRNIK_RACE_APPLICATION_ID => reduce_syrnik_race(instance, command, actor_id),
        _ => Err(ChannelActivityErrorCode::UnknownApplication),
    }
}

fn reduce_shared_counter(
    state: &Value,
    command: &Value,
    actor_id: &str,
) -> std::result::Result<Value, ChannelActivityErrorCode> {
    let current = state
        .get("count")
        .and_then(Value::as_i64)
        .ok_or(ChannelActivityErrorCode::InvalidCommand)?;
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .ok_or(ChannelActivityErrorCode::InvalidCommand)?;
    let count = match command_type {
        "increment" => current.saturating_add(1),
        "decrement" => current.saturating_sub(1),
        _ => return Err(ChannelActivityErrorCode::InvalidCommand),
    }
    .clamp(-999_999, 999_999);

    Ok(json!({
        "count": count,
        "last_actor_id": actor_id,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SyrnikRacePhase {
    Lobby,
    Playing,
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SyrnikRaceTarget {
    id: u64,
    x: u8,
    y: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SyrnikRaceState {
    phase: SyrnikRacePhase,
    ready_user_ids: Vec<String>,
    scores: BTreeMap<String, u32>,
    target: Option<SyrnikRaceTarget>,
    hits_remaining: u32,
    round: u32,
    last_hit_by: Option<String>,
}

impl Default for SyrnikRaceState {
    fn default() -> Self {
        Self {
            phase: SyrnikRacePhase::Lobby,
            ready_user_ids: Vec::new(),
            scores: BTreeMap::new(),
            target: None,
            hits_remaining: 0,
            round: 0,
            last_hit_by: None,
        }
    }
}

fn reduce_syrnik_race(
    instance: &ChannelActivityInstance,
    command: &Value,
    actor_id: &str,
) -> std::result::Result<Value, ChannelActivityErrorCode> {
    let mut state = serde_json::from_value::<SyrnikRaceState>(instance.state.clone())
        .map_err(|_| ChannelActivityErrorCode::InvalidCommand)?;
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .ok_or(ChannelActivityErrorCode::InvalidCommand)?;

    match command_type {
        "toggle_ready" => {
            if state.phase != SyrnikRacePhase::Lobby {
                return Err(ChannelActivityErrorCode::InvalidCommand);
            }
            if let Some(index) = state.ready_user_ids.iter().position(|id| id == actor_id) {
                state.ready_user_ids.remove(index);
            } else {
                state.ready_user_ids.push(actor_id.to_string());
                state.ready_user_ids.sort();
            }
        }
        "start_round" => {
            require_activity_owner(instance, actor_id)?;
            if state.phase != SyrnikRacePhase::Lobby
                || instance.participant_ids.is_empty()
                || !instance
                    .participant_ids
                    .iter()
                    .all(|id| state.ready_user_ids.contains(id))
            {
                return Err(ChannelActivityErrorCode::InvalidCommand);
            }
            state.phase = SyrnikRacePhase::Playing;
            state.round = state.round.saturating_add(1);
            state.ready_user_ids.clear();
            state.scores = instance
                .participant_ids
                .iter()
                .map(|id| (id.clone(), 0))
                .collect();
            state.hits_remaining = SYRNIK_RACE_HITS_PER_ROUND;
            state.last_hit_by = None;
            state.target = Some(syrnik_race_target(state.round, 1));
        }
        "hit_target" => {
            if state.phase != SyrnikRacePhase::Playing {
                return Err(ChannelActivityErrorCode::InvalidCommand);
            }
            let target_id = command
                .get("target_id")
                .and_then(Value::as_u64)
                .ok_or(ChannelActivityErrorCode::InvalidCommand)?;
            let current_target = state
                .target
                .as_ref()
                .filter(|target| target.id == target_id)
                .ok_or(ChannelActivityErrorCode::InvalidCommand)?;
            let next_sequence = current_target.id % 1_000 + 1;
            let score = state.scores.entry(actor_id.to_string()).or_default();
            *score = score.saturating_add(1);
            state.hits_remaining = state.hits_remaining.saturating_sub(1);
            state.last_hit_by = Some(actor_id.to_string());
            if state.hits_remaining == 0 {
                state.phase = SyrnikRacePhase::Finished;
                state.target = None;
            } else {
                state.target = Some(syrnik_race_target(state.round, next_sequence));
            }
        }
        "reset_lobby" => {
            require_activity_owner(instance, actor_id)?;
            state = SyrnikRaceState {
                round: state.round,
                ..SyrnikRaceState::default()
            };
        }
        _ => return Err(ChannelActivityErrorCode::InvalidCommand),
    }

    serde_json::to_value(state).map_err(|_| ChannelActivityErrorCode::Internal)
}

fn require_activity_owner(
    instance: &ChannelActivityInstance,
    actor_id: &str,
) -> std::result::Result<(), ChannelActivityErrorCode> {
    if instance.owner_id == actor_id {
        Ok(())
    } else {
        Err(ChannelActivityErrorCode::NotOwner)
    }
}

fn syrnik_race_target(round: u32, sequence: u64) -> SyrnikRaceTarget {
    let id = u64::from(round).saturating_mul(1_000) + sequence;
    let seed = id
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    SyrnikRaceTarget {
        id,
        x: 12 + (seed % 77) as u8,
        y: 16 + ((seed >> 17) % 69) as u8,
    }
}

async fn publish_snapshot(
    channel: &UserVoiceChannel,
    request_id: Option<String>,
    instance: ChannelActivityInstance,
) {
    publish_to_voice_members(channel, snapshot_event(request_id, instance)).await;
}

async fn publish_closed(
    channel: &UserVoiceChannel,
    request_id: Option<String>,
    channel_id: &str,
    instance_id: &str,
) {
    publish_to_voice_members(
        channel,
        EventV1::ChannelActivityClosed {
            request_id,
            channel_id: channel_id.to_string(),
            instance_id: instance_id.to_string(),
        },
    )
    .await;
}

async fn publish_to_voice_members(channel: &UserVoiceChannel, event: EventV1) {
    let Ok(Some(member_ids)) = get_voice_channel_members(channel).await else {
        return;
    };
    for member_id in member_ids {
        event.clone().private(member_id).await;
    }
}

fn snapshot_event(request_id: Option<String>, instance: ChannelActivityInstance) -> EventV1 {
    EventV1::ChannelActivitySnapshot {
        request_id,
        instance,
    }
}

fn error_event(request_id: String, channel_id: String, code: ChannelActivityErrorCode) -> EventV1 {
    EventV1::ChannelActivityError {
        request_id,
        channel_id,
        code,
    }
}

fn instance_voice_channel(instance: &ChannelActivityInstance) -> UserVoiceChannel {
    UserVoiceChannel {
        id: instance.channel_id.clone(),
        server_id: instance.server_id.clone(),
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        application_initial_state, application_reduce, reconcile_participants,
        reduce_shared_counter, with_participant, SHARED_COUNTER_APPLICATION_ID,
        SYRNIK_RACE_APPLICATION_ID,
    };
    use syrnike_database::{events::client::ChannelActivityInstance, iso8601_timestamp::Timestamp};

    fn instance() -> ChannelActivityInstance {
        ChannelActivityInstance {
            id: "activity-1".to_string(),
            application_id: SHARED_COUNTER_APPLICATION_ID.to_string(),
            channel_id: "channel-1".to_string(),
            server_id: None,
            owner_id: "user-a".to_string(),
            participant_ids: vec!["user-a".to_string()],
            revision: 1,
            state: json!({ "count": 0, "last_actor_id": null }),
            created_at: Timestamp::UNIX_EPOCH,
        }
    }

    #[test]
    fn joining_adds_participant_once_and_advances_revision() {
        let joined = with_participant(&instance(), "user-b");
        assert_eq!(joined.participant_ids, vec!["user-a", "user-b"]);
        assert_eq!(joined.revision, 2);
        assert_eq!(with_participant(&joined, "user-b"), joined);
    }

    #[test]
    fn shared_counter_reducer_is_server_authoritative() {
        let next = reduce_shared_counter(
            &json!({ "count": 4, "last_actor_id": null }),
            &json!({ "type": "increment" }),
            "user-b",
        )
        .expect("valid command");

        assert_eq!(next, json!({ "count": 5, "last_actor_id": "user-b" }));
        assert!(reduce_shared_counter(
            &next,
            &json!({ "type": "replace", "count": 999 }),
            "user-a"
        )
        .is_err());
    }

    #[test]
    fn reconciliation_removes_voice_leavers_and_transfers_ownership() {
        let mut current = instance();
        current.participant_ids.push("user-b".to_string());

        let reconciled = reconcile_participants(&current, &["user-b".to_string()])
            .expect("one participant remains");
        assert_eq!(reconciled.participant_ids, vec!["user-b"]);
        assert_eq!(reconciled.owner_id, "user-b");
        assert!(reconcile_participants(&current, &[]).is_none());
    }

    #[test]
    fn syrnik_race_covers_ready_start_hit_and_stale_target_rejection() {
        let mut race = instance();
        race.application_id = SYRNIK_RACE_APPLICATION_ID.to_string();
        race.participant_ids.push("user-b".to_string());
        race.state = application_initial_state(SYRNIK_RACE_APPLICATION_ID)
            .expect("race application is registered");

        race.state = application_reduce(&race, &json!({ "type": "toggle_ready" }), "user-a")
            .expect("owner becomes ready");
        race.state = application_reduce(&race, &json!({ "type": "toggle_ready" }), "user-b")
            .expect("second participant becomes ready");
        assert_eq!(
            application_reduce(&race, &json!({ "type": "start_round" }), "user-b")
                .expect_err("only the owner starts a round"),
            syrnike_database::events::client::ChannelActivityErrorCode::NotOwner
        );
        race.state = application_reduce(&race, &json!({ "type": "start_round" }), "user-a")
            .expect("ready owner starts round");

        let target_id = race.state["target"]["id"]
            .as_u64()
            .expect("playing state has target id");
        race.state = application_reduce(
            &race,
            &json!({ "type": "hit_target", "target_id": target_id }),
            "user-b",
        )
        .expect("first claim wins");
        assert_eq!(race.state["scores"]["user-b"], 1);
        assert!(application_reduce(
            &race,
            &json!({ "type": "hit_target", "target_id": target_id }),
            "user-a",
        )
        .is_err());
    }
}
