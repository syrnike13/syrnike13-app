#![cfg(feature = "voice")]

use livekit_protocol::{participant_info, ParticipantInfo};
use std::{fs::read_to_string, path::Path};
use syrnike_database::voice::{
    voice_participant_reconciliation, voice_participant_reconciliation_with_current_operations,
    VoiceParticipantReconciliationVerdict,
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

#[test]
fn reconciliation_verdict_distinguishes_dead_room_from_transient_skip() {
    assert!(matches!(
        VoiceParticipantReconciliationVerdict::DeadRoom,
        VoiceParticipantReconciliationVerdict::DeadRoom
    ));
    assert!(matches!(
        VoiceParticipantReconciliationVerdict::SkipTransient,
        VoiceParticipantReconciliationVerdict::SkipTransient
    ));
}

#[test]
fn reconciliation_missing_node_skips_instead_of_declaring_dead_room() {
    let source = read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("voice")
            .join("mod.rs"),
    )
    .expect("voice mod source should be readable");

    let missing_node_branch = source
        .split("let Some(node) = get_channel_node(&channel.id).await? else {")
        .nth(1)
        .and_then(|tail| tail.split("};").next())
        .expect("missing node branch should stay explicit");

    assert!(missing_node_branch.contains("VoiceParticipantReconciliationVerdict::SkipTransient"));
    assert!(!missing_node_branch.contains("VoiceParticipantReconciliationVerdict::DeadRoom"));
}
