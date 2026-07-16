#![cfg(feature = "voice")]

use livekit_protocol::{participant_info, ParticipantInfo};
use syrnike_database::voice::{
    voice_participant_identity, voice_participant_reconciliation,
    voice_participant_reconciliation_with_current_operations,
    VoiceParticipantReconciliationVerdict, VoiceRtcEngine,
};

const OP_A: &str = "voice-op-550e8400-e29b-41d4-a716-446655440001";
const OP_B: &str = "voice-op-550e8400-e29b-41d4-a716-446655440002";
const OP_NEW: &str = "voice-op-550e8400-e29b-41d4-a716-446655440003";

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

fn participant_with_operation(
    identity: &str,
    operation_id: &str,
    state: participant_info::State,
) -> ParticipantInfo {
    participant(
        &voice_participant_identity(
            identity,
            VoiceRtcEngine::Web,
            "client-a",
            operation_id,
            "epoch-a",
        ),
        state,
    )
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
            participant_with_operation("user-a", OP_A, participant_info::State::Active),
            participant_with_operation("user-b", OP_B, participant_info::State::Joined),
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

    assert_eq!(plan.livekit_members, Vec::<String>::new());
    assert_eq!(plan.stale_members, Vec::<String>::new());
    assert_eq!(plan.stale_livekit_participants, ids(&["user-a"]));
}

#[test]
fn reconciliation_keeps_native_sidecar_for_committed_base_member() {
    let plan = voice_participant_reconciliation_with_current_operations(
        &ids(&["user-a"]),
        &[
            participant_with_operation("user-a", OP_A, participant_info::State::Active),
            participant(
                &format!("user-a:desktop-native:{OP_A}:screen"),
                participant_info::State::Active,
            ),
        ],
        &[("user-a".to_string(), OP_A.to_string())],
        &[],
    );

    assert_eq!(plan.livekit_members, ids(&["user-a"]));
    assert_eq!(plan.stale_members, Vec::<String>::new());
    assert_eq!(
        plan.stale_livekit_participants,
        ids(&[&format!("user-a:desktop-native:{OP_A}:screen")])
    );
}

#[test]
fn reconciliation_removes_native_sidecar_for_stale_operation() {
    let plan = voice_participant_reconciliation_with_current_operations(
        &ids(&["user-a"]),
        &[
            participant_with_operation("user-a", OP_NEW, participant_info::State::Active),
            participant(
                "user-a:desktop-native:op-old:screen",
                participant_info::State::Active,
            ),
        ],
        &[("user-a".to_string(), OP_NEW.to_string())],
        &[],
    );

    assert_eq!(plan.livekit_members, ids(&["user-a"]));
    assert_eq!(plan.stale_members, Vec::<String>::new());
    assert_eq!(
        plan.stale_livekit_participants,
        ids(&["user-a:desktop-native:op-old:screen"])
    );
}

#[test]
fn reconciliation_keeps_prepared_browser_and_predecessor_membership() {
    let prepared = ids(&["user-a"]);
    let candidate = voice_participant_reconciliation_with_current_operations(
        &[],
        &[participant_with_operation(
            "user-a",
            OP_B,
            participant_info::State::Active,
        )],
        &[("user-a".to_string(), OP_B.to_string())],
        &prepared,
    );
    assert!(candidate.stale_livekit_participants.is_empty());

    let predecessor = voice_participant_reconciliation_with_current_operations(
        &ids(&["user-a"]),
        &[],
        &[("user-a".to_string(), OP_A.to_string())],
        &prepared,
    );
    assert!(predecessor.stale_members.is_empty());
}

#[test]
fn reconciliation_accepts_both_finalized_and_prepared_native_operations() {
    let plan = voice_participant_reconciliation_with_current_operations(
        &ids(&["user-a"]),
        &[
            participant_with_operation("user-a", OP_B, participant_info::State::Active),
            participant(
                &format!("user-a:desktop-native:{OP_A}:screen"),
                participant_info::State::Active,
            ),
            participant(
                &format!("user-a:desktop-native:{OP_B}:microphone"),
                participant_info::State::Active,
            ),
        ],
        &[
            ("user-a".to_string(), OP_A.to_string()),
            ("user-a".to_string(), OP_B.to_string()),
        ],
        &ids(&["user-a"]),
    );

    assert_eq!(plan.stale_livekit_participants.len(), 2);
}

#[test]
fn reconciliation_removes_stale_browser_operation_for_same_identity() {
    let plan = voice_participant_reconciliation_with_current_operations(
        &ids(&["user-a"]),
        &[participant_with_operation(
            "user-a",
            OP_B,
            participant_info::State::Active,
        )],
        &[("user-a".to_string(), OP_A.to_string())],
        &[],
    );

    assert_eq!(plan.livekit_members, Vec::<String>::new());
    assert_eq!(
        plan.stale_livekit_participants,
        ids(&[&voice_participant_identity(
            "user-a",
            VoiceRtcEngine::Web,
            "client-a",
            OP_B,
            "epoch-a"
        )])
    );
    assert_eq!(plan.stale_members, ids(&["user-a"]));
}

#[test]
fn reconciliation_verdict_distinguishes_dead_room_from_transient_skip() {
    assert!(matches!(
        VoiceParticipantReconciliationVerdict::DeadRoom {
            stale_members: Vec::new()
        },
        VoiceParticipantReconciliationVerdict::DeadRoom {
            stale_members: members
        } if members.is_empty()
    ));
    assert!(matches!(
        VoiceParticipantReconciliationVerdict::SkipTransient,
        VoiceParticipantReconciliationVerdict::SkipTransient
    ));
}
