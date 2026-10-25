//! Pure Activity Instance rules (ADR-0011). Everything here is synchronous and
//! side-effect free so the lifecycle can be unit tested without Redis.

use iso8601_timestamp::Timestamp;
use serde_json::Value;

use crate::events::client::{
    ActivityEndReason, ActivityErrorCode, ActivityInstance, ActivityParticipant,
    ActivitySharedState,
};

/// Maximum length of request, channel, instance, application and user ids.
pub const MAX_IDENTIFIER_BYTES: usize = 128;
/// Maximum serialized size of a relayed message payload.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
/// Maximum serialized size of the shared state `data`.
pub const MAX_STATE_BYTES: usize = 64 * 1024;
/// Maximum number of explicit message recipients.
pub const MAX_MESSAGE_RECIPIENTS: usize = 128;

/// What a lifecycle step wants to write.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Nothing to write; carries the current instance, if any.
    Keep(Option<ActivityInstance>),
    /// Create a new instance with its initial shared state.
    Create(ActivityInstance, ActivitySharedState),
    /// Replace the instance.
    Update(ActivityInstance),
    /// Delete the instance and its shared state.
    End(ActivityInstance, ActivityEndReason),
}

/// Result of removing participants from an instance.
#[derive(Debug, Clone, PartialEq)]
pub enum ParticipantChange {
    Unchanged,
    Updated(ActivityInstance),
    Empty,
}

pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES
}

/// Serialized JSON size of a value.
pub fn serialized_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |raw| raw.len())
}

/// Storage scope of an instance: the server, or the channel for DM and group calls.
pub fn instance_scope(instance: &ActivityInstance) -> &str {
    instance
        .server_id
        .as_deref()
        .unwrap_or(instance.channel_id.as_str())
}

pub fn is_participant(instance: &ActivityInstance, user_id: &str) -> bool {
    instance
        .participants
        .iter()
        .any(|participant| participant.user_id == user_id)
}

pub fn new_instance(
    application_id: &str,
    channel_id: &str,
    server_id: Option<String>,
    user_id: &str,
    now: Timestamp,
) -> (ActivityInstance, ActivitySharedState) {
    let instance = ActivityInstance {
        id: ulid::Ulid::new().to_string(),
        application_id: application_id.to_string(),
        channel_id: channel_id.to_string(),
        server_id,
        revision: 1,
        host_id: user_id.to_string(),
        participants: vec![ActivityParticipant {
            user_id: user_id.to_string(),
            joined_at: now,
        }],
        started_by: user_id.to_string(),
        started_at: now,
    };
    let state = ActivitySharedState {
        instance_id: instance.id.clone(),
        version: 0,
        data: Value::Null,
        updated_by: None,
    };
    (instance, state)
}

/// Instance with `instance_id` or `instance_not_found`.
pub fn matching<'a>(
    current: Option<&'a ActivityInstance>,
    instance_id: &str,
) -> Result<&'a ActivityInstance, ActivityErrorCode> {
    current
        .filter(|instance| instance.id == instance_id)
        .ok_or(ActivityErrorCode::InstanceNotFound)
}

/// Add a participant (idempotent) respecting `max_participants`.
pub fn join_decision(
    instance: &ActivityInstance,
    user_id: &str,
    max_participants: usize,
    now: Timestamp,
) -> Result<Decision, ActivityErrorCode> {
    if is_participant(instance, user_id) {
        return Ok(Decision::Keep(Some(instance.clone())));
    }
    if instance.participants.len() >= max_participants {
        return Err(ActivityErrorCode::Full);
    }
    let mut next = instance.clone();
    next.participants.push(ActivityParticipant {
        user_id: user_id.to_string(),
        joined_at: now,
    });
    next.revision += 1;
    Ok(Decision::Update(next))
}

/// Keep participants accepted by `keep`; the earliest remaining participant
/// becomes host when the host is removed.
pub fn retain_participants(
    instance: &ActivityInstance,
    keep: impl Fn(&str) -> bool,
) -> ParticipantChange {
    let mut next = instance.clone();
    next.participants
        .retain(|participant| keep(&participant.user_id));
    if next.participants.is_empty() {
        return ParticipantChange::Empty;
    }
    if next.participants.len() == instance.participants.len() {
        return ParticipantChange::Unchanged;
    }
    if !is_participant(&next, &next.host_id) {
        next.host_id = next.participants[0].user_id.clone();
    }
    next.revision += 1;
    ParticipantChange::Updated(next)
}

/// Remove one participant; ends the instance when it becomes empty.
pub fn leave_decision(instance: &ActivityInstance, user_id: &str) -> Decision {
    participant_change_decision(
        instance,
        retain_participants(instance, |participant| participant != user_id),
    )
}

/// Reconcile an instance with the application registry and voice membership.
///
/// `observed_instance_id` guards against acting on a newer instance that
/// replaced the one the async checks were made for.
pub fn reconcile_decision(
    current: Option<&ActivityInstance>,
    observed_instance_id: &str,
    application_available: bool,
    voice_members: &[String],
) -> Decision {
    let Some(instance) = current.filter(|instance| instance.id == observed_instance_id) else {
        return Decision::Keep(current.cloned());
    };
    if !application_available {
        return Decision::End(instance.clone(), ActivityEndReason::ApplicationUnavailable);
    }
    participant_change_decision(
        instance,
        retain_participants(instance, |participant| {
            voice_members.iter().any(|member| member == participant)
        }),
    )
}

fn participant_change_decision(instance: &ActivityInstance, change: ParticipantChange) -> Decision {
    match change {
        ParticipantChange::Unchanged => Decision::Keep(Some(instance.clone())),
        ParticipantChange::Updated(next) => Decision::Update(next),
        ParticipantChange::Empty => Decision::End(instance.clone(), ActivityEndReason::Empty),
    }
}

/// Recipients of a relayed message: the requested participants, or every
/// participant except the sender.
pub fn message_recipients(
    instance: &ActivityInstance,
    sender_id: &str,
    to: Option<&[String]>,
) -> Vec<String> {
    match to {
        Some(targets) => {
            let mut recipients = Vec::new();
            for target in targets {
                if is_participant(instance, target) && !recipients.contains(target) {
                    recipients.push(target.clone());
                }
            }
            recipients
        }
        None => instance
            .participants
            .iter()
            .filter(|participant| participant.user_id != sender_id)
            .map(|participant| participant.user_id.clone())
            .collect(),
    }
}

/// Next shared state for a compare-and-set write.
pub fn next_state(
    current: &ActivitySharedState,
    instance_id: &str,
    expected_version: u64,
    data: Value,
    user_id: &str,
) -> Result<ActivitySharedState, ActivityErrorCode> {
    if current.instance_id != instance_id {
        return Err(ActivityErrorCode::InstanceNotFound);
    }
    if current.version != expected_version {
        return Err(ActivityErrorCode::VersionConflict);
    }
    Ok(ActivitySharedState {
        instance_id: instance_id.to_string(),
        version: expected_version + 1,
        data,
        updated_by: Some(user_id.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn instance_with(users: &[&str]) -> ActivityInstance {
        let (mut instance, _) = new_instance(
            "lab",
            "channel",
            Some("server".into()),
            users[0],
            Timestamp::UNIX_EPOCH,
        );
        for user in &users[1..] {
            let Decision::Update(next) =
                join_decision(&instance, user, 16, Timestamp::UNIX_EPOCH).unwrap()
            else {
                panic!("join must update");
            };
            instance = next;
        }
        instance
    }

    fn ids(instance: &ActivityInstance) -> Vec<&str> {
        instance
            .participants
            .iter()
            .map(|participant| participant.user_id.as_str())
            .collect()
    }

    #[test]
    fn starter_is_host_and_state_starts_empty() {
        let (instance, state) = new_instance("lab", "channel", None, "a", Timestamp::UNIX_EPOCH);
        assert_eq!(instance.host_id, "a");
        assert_eq!(instance.started_by, "a");
        assert_eq!(instance.revision, 1);
        assert_eq!(ids(&instance), vec!["a"]);
        assert_eq!(instance_scope(&instance), "channel");
        assert_eq!(state.version, 0);
        assert_eq!(state.data, Value::Null);
        assert_eq!(state.instance_id, instance.id);
    }

    #[test]
    fn join_is_idempotent_and_respects_capacity() {
        let instance = instance_with(&["a", "b"]);
        assert_eq!(instance.revision, 2);
        assert_eq!(ids(&instance), vec!["a", "b"]);
        assert_eq!(
            join_decision(&instance, "b", 2, Timestamp::UNIX_EPOCH),
            Ok(Decision::Keep(Some(instance.clone())))
        );
        assert_eq!(
            join_decision(&instance, "c", 2, Timestamp::UNIX_EPOCH),
            Err(ActivityErrorCode::Full)
        );
    }

    #[test]
    fn host_leave_promotes_earliest_remaining_participant() {
        let instance = instance_with(&["a", "b", "c"]);
        let Decision::Update(next) = leave_decision(&instance, "a") else {
            panic!("leave must update");
        };
        assert_eq!(next.host_id, "b");
        assert_eq!(ids(&next), vec!["b", "c"]);
        assert_eq!(next.revision, instance.revision + 1);

        let Decision::Update(next) = leave_decision(&next, "c") else {
            panic!("leave must update");
        };
        assert_eq!(next.host_id, "b");
    }

    #[test]
    fn last_leave_ends_and_unknown_leave_keeps() {
        let instance = instance_with(&["a"]);
        assert_eq!(
            leave_decision(&instance, "x"),
            Decision::Keep(Some(instance.clone()))
        );
        assert_eq!(
            leave_decision(&instance, "a"),
            Decision::End(instance.clone(), ActivityEndReason::Empty)
        );
    }

    #[test]
    fn reconcile_drops_non_members_and_ends_unavailable() {
        let instance = instance_with(&["a", "b", "c"]);
        let members = vec!["c".to_string(), "b".to_string()];

        let Decision::Update(next) =
            reconcile_decision(Some(&instance), &instance.id, true, &members)
        else {
            panic!("reconcile must update");
        };
        assert_eq!(ids(&next), vec!["b", "c"]);
        assert_eq!(next.host_id, "b");

        assert_eq!(
            reconcile_decision(Some(&instance), &instance.id, true, &[]),
            Decision::End(instance.clone(), ActivityEndReason::Empty)
        );
        assert_eq!(
            reconcile_decision(Some(&instance), &instance.id, false, &members),
            Decision::End(instance.clone(), ActivityEndReason::ApplicationUnavailable)
        );
        assert_eq!(
            reconcile_decision(Some(&instance), "other", false, &members),
            Decision::Keep(Some(instance.clone()))
        );
        assert_eq!(
            reconcile_decision(None, "other", true, &members),
            Decision::Keep(None)
        );
    }

    #[test]
    fn message_recipients_are_filtered_to_participants() {
        let instance = instance_with(&["a", "b", "c"]);
        assert_eq!(message_recipients(&instance, "a", None), vec!["b", "c"]);
        let to = vec![
            "c".to_string(),
            "x".to_string(),
            "c".to_string(),
            "a".to_string(),
        ];
        assert_eq!(
            message_recipients(&instance, "a", Some(&to)),
            vec!["c", "a"]
        );
    }

    #[test]
    fn shared_state_compare_and_set() {
        let (instance, state) = new_instance("lab", "channel", None, "a", Timestamp::UNIX_EPOCH);
        let next = next_state(&state, &instance.id, 0, json!({ "n": 1 }), "a").unwrap();
        assert_eq!(next.version, 1);
        assert_eq!(next.updated_by.as_deref(), Some("a"));
        assert_eq!(
            next_state(&next, &instance.id, 0, json!({}), "a"),
            Err(ActivityErrorCode::VersionConflict)
        );
        assert_eq!(
            next_state(&next, "other", 1, json!({}), "a"),
            Err(ActivityErrorCode::InstanceNotFound)
        );
    }

    #[test]
    fn limits() {
        assert!(valid_identifier("a"));
        assert!(!valid_identifier(""));
        assert!(!valid_identifier(&"a".repeat(MAX_IDENTIFIER_BYTES + 1)));
        assert_eq!(serialized_len(&json!({ "a": 1 })), 7);
    }
}
