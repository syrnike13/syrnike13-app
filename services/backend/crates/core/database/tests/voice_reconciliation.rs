#![cfg(feature = "voice")]

use livekit_protocol::{participant_info, ParticipantInfo};
use syrnike_database::voice::{
    voice_participant_reconciliation, voice_participant_reconciliation_with_current_operations,
};

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn participant(identity: &str, state: participant_info::State) -> ParticipantInfo {
    ParticipantInfo {
        identity: identity.to_string(),
        state: state as i32,
        ..Default::default()
    }
}

#[test]
fn reconciliation_marks_redis_member_stale_when_livekit_room_is_empty() {
    let plan = voice_participant_reconciliation(&ids(&["user-a"]), &[]);

    assert_eq!(plan.livekit_members, Vec::<String>::new());
    assert_eq!(plan.stale_members, ids(&["user-a"]));
}

#[test]
fn reconciliation_keeps_livekit_standard_participants() {
    let plan = voice_participant_reconciliation(
        &ids(&["user-a", "user-b"]),
        &[
            participant("user-a", participant_info::State::Active),
            participant("user-b", participant_info::State::Joined),
        ],
    );

    assert_eq!(plan.livekit_members, ids(&["user-a", "user-b"]));
    assert_eq!(plan.stale_members, Vec::<String>::new());
}

#[test]
fn reconciliation_does_not_treat_native_sidecars_as_membership() {
    let plan = voice_participant_reconciliation(
        &ids(&["user-a"]),
        &[participant(
            "user-a:desktop-native:microphone",
            participant_info::State::Active,
        )],
    );

    assert_eq!(plan.livekit_members, Vec::<String>::new());
    assert_eq!(plan.stale_members, ids(&["user-a"]));
    assert_eq!(
        plan.stale_livekit_participants,
        ids(&["user-a:desktop-native:microphone"])
    );
}

#[test]
fn reconciliation_ignores_disconnected_livekit_participants() {
    let plan = voice_participant_reconciliation(
        &ids(&["user-a"]),
        &[participant("user-a", participant_info::State::Disconnected)],
    );

    assert_eq!(plan.livekit_members, Vec::<String>::new());
    assert_eq!(plan.stale_members, ids(&["user-a"]));
    assert_eq!(plan.stale_livekit_participants, Vec::<String>::new());
}

#[test]
fn reconciliation_removes_livekit_base_participant_without_redis_membership() {
    let plan = voice_participant_reconciliation(
        &[],
        &[participant("user-a", participant_info::State::Active)],
    );

    assert_eq!(plan.livekit_members, ids(&["user-a"]));
    assert_eq!(plan.stale_members, Vec::<String>::new());
    assert_eq!(plan.stale_livekit_participants, ids(&["user-a"]));
}

#[test]
fn reconciliation_keeps_native_sidecar_for_committed_base_member() {
    let plan = voice_participant_reconciliation_with_current_operations(
        &ids(&["user-a"]),
        &[
            participant("user-a", participant_info::State::Active),
            participant(
                "user-a:desktop-native:op-a:screen",
                participant_info::State::Active,
            ),
        ],
        &[("user-a".to_string(), "op-a".to_string())],
    );

    assert_eq!(plan.livekit_members, ids(&["user-a"]));
    assert_eq!(plan.stale_members, Vec::<String>::new());
    assert_eq!(plan.stale_livekit_participants, Vec::<String>::new());
}

#[test]
fn reconciliation_removes_native_sidecar_for_stale_operation() {
    let plan = voice_participant_reconciliation_with_current_operations(
        &ids(&["user-a"]),
        &[
            participant("user-a", participant_info::State::Active),
            participant(
                "user-a:desktop-native:op-old:screen",
                participant_info::State::Active,
            ),
        ],
        &[("user-a".to_string(), "op-new".to_string())],
    );

    assert_eq!(plan.livekit_members, ids(&["user-a"]));
    assert_eq!(plan.stale_members, Vec::<String>::new());
    assert_eq!(
        plan.stale_livekit_participants,
        ids(&["user-a:desktop-native:op-old:screen"])
    );
}
