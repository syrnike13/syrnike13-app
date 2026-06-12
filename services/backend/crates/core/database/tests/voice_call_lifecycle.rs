#![cfg(feature = "voice")]

use iso8601_timestamp::{Duration, Timestamp};
use redis_kiss::redis::{FromRedisValue, ToRedisArgs, Value};
use syrnike_database::{
    voice::call_lifecycle::{
        voice_call_cancel_effect, voice_call_decline_effect, voice_call_expire_effect,
        voice_call_join_effect, voice_call_leave_effect, VoiceCallCancelEffect,
        VoiceCallDeclineEffect, VoiceCallExpireEffect, VoiceCallJoinEffect, VoiceCallLeaveEffect,
        VoiceCallLeavePolicy, VoiceCallLeaveReason, VoiceCallPhase, VoiceCallState,
    },
    VoiceCallEndReason,
};

const RING_SECONDS: i64 = 30;
const GROUP_UNANSWERED_ACTIVE_SECONDS: i64 = 10 * 60;

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn ringing_call(channel_id: &str, initiator_id: &str) -> VoiceCallState {
    VoiceCallState {
        channel_id: channel_id.to_string(),
        initiator_id: initiator_id.to_string(),
        phase: VoiceCallPhase::Ringing,
        started_at: Timestamp::UNIX_EPOCH,
        expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS)),
        declined_recipients: ids(&[]),
        ringing_recipients: ids(&["callee"]),
    }
}

#[test]
fn first_dm_join_starts_ringing_for_other_channel_members() {
    let effect = voice_call_join_effect(
        None,
        "dm-channel",
        "caller",
        &ids(&["caller", "callee"]),
        &[],
        None,
        Timestamp::UNIX_EPOCH,
        RING_SECONDS,
    );

    assert_eq!(
        effect,
        VoiceCallJoinEffect::StartRinging {
            state: VoiceCallState {
                channel_id: "dm-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Ringing,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS)),
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&["callee"]),
            },
            notify_recipients: ids(&["callee"]),
            stop_previous_ringing_recipients: ids(&[]),
        }
    );
}

#[test]
fn group_join_filters_ringing_recipients_to_requested_members() {
    let effect = voice_call_join_effect(
        None,
        "group-channel",
        "caller",
        &ids(&["caller", "callee-a", "callee-b"]),
        &[],
        Some(&ids(&["callee-b", "not-member", "caller"])),
        Timestamp::UNIX_EPOCH,
        RING_SECONDS,
    );

    assert_eq!(
        effect,
        VoiceCallJoinEffect::StartRinging {
            state: VoiceCallState {
                channel_id: "group-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Ringing,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS)),
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&["callee-b"]),
            },
            notify_recipients: ids(&["callee-b"]),
            stop_previous_ringing_recipients: ids(&[]),
        }
    );
}

#[test]
fn group_join_deduplicates_requested_ringing_recipients() {
    let effect = voice_call_join_effect(
        None,
        "group-channel",
        "caller",
        &ids(&["caller", "callee-a", "callee-b"]),
        &[],
        Some(&ids(&["callee-b", "callee-a", "callee-b", "callee-a"])),
        Timestamp::UNIX_EPOCH,
        RING_SECONDS,
    );

    assert_eq!(
        effect,
        VoiceCallJoinEffect::StartRinging {
            state: VoiceCallState {
                channel_id: "group-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Ringing,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS)),
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&["callee-b", "callee-a"]),
            },
            notify_recipients: ids(&["callee-b", "callee-a"]),
            stop_previous_ringing_recipients: ids(&[]),
        }
    );
}

#[test]
fn callee_joining_ringing_call_marks_it_active_and_stops_ringing_notifications() {
    let effect = voice_call_join_effect(
        Some(&ringing_call("dm-channel", "caller")),
        "dm-channel",
        "callee",
        &ids(&["caller", "callee"]),
        &ids(&["caller"]),
        None,
        Timestamp::UNIX_EPOCH,
        RING_SECONDS,
    );

    assert_eq!(
        effect,
        VoiceCallJoinEffect::MarkActive {
            state: VoiceCallState {
                channel_id: "dm-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Active,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: None,
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&[]),
            },
            stop_ringing_recipients: ids(&["callee"]),
        }
    );
}

#[test]
fn late_callee_joining_still_active_initiator_marks_expired_ringing_call_active() {
    let call = ringing_call("dm-channel", "caller");
    let effect = voice_call_join_effect(
        Some(&call),
        "dm-channel",
        "callee",
        &ids(&["caller", "callee"]),
        &ids(&["caller"]),
        None,
        Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS + 1),
        RING_SECONDS,
    );

    assert_eq!(
        effect,
        VoiceCallJoinEffect::MarkActive {
            state: VoiceCallState {
                channel_id: "dm-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Active,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: None,
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&[]),
            },
            stop_ringing_recipients: ids(&["callee"]),
        }
    );
}

#[test]
fn callee_joining_group_active_grace_clears_no_answer_deadline() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(10 * 60)),
        ringing_recipients: ids(&[]),
        ..ringing_call("group-channel", "caller")
    };

    let effect = voice_call_join_effect(
        Some(&call),
        "group-channel",
        "callee",
        &ids(&["caller", "callee"]),
        &ids(&["caller"]),
        None,
        Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS + 1),
        RING_SECONDS,
    );

    assert_eq!(
        effect,
        VoiceCallJoinEffect::MarkActive {
            state: VoiceCallState {
                channel_id: "group-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Active,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: None,
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&[]),
            },
            stop_ringing_recipients: ids(&[]),
        }
    );
}

#[test]
fn callee_joining_without_initiator_does_not_mark_ringing_call_active() {
    let effect = voice_call_join_effect(
        Some(&ringing_call("dm-channel", "caller")),
        "dm-channel",
        "callee",
        &ids(&["caller", "callee"]),
        &[],
        None,
        Timestamp::UNIX_EPOCH,
        RING_SECONDS,
    );

    assert_eq!(effect, VoiceCallJoinEffect::NoChange);
}

#[test]
fn initiator_rejoin_does_not_restart_ringing() {
    let call = ringing_call("dm-channel", "caller");
    let effect = voice_call_join_effect(
        Some(&call),
        "dm-channel",
        "caller",
        &ids(&["caller", "callee"]),
        &ids(&["caller"]),
        None,
        Timestamp::UNIX_EPOCH,
        RING_SECONDS,
    );

    assert_eq!(effect, VoiceCallJoinEffect::NoChange);
}

#[test]
fn expired_ringing_call_does_not_block_a_new_empty_channel_call() {
    let mut expired_call = ringing_call("dm-channel", "old-caller");
    expired_call.ringing_recipients = ids(&["old-callee"]);
    let fresh_started_at = Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS + 1);
    let effect = voice_call_join_effect(
        Some(&expired_call),
        "dm-channel",
        "fresh-caller",
        &ids(&["fresh-caller", "new-callee"]),
        &[],
        None,
        fresh_started_at,
        RING_SECONDS,
    );

    assert_eq!(
        effect,
        VoiceCallJoinEffect::StartRinging {
            state: VoiceCallState {
                channel_id: "dm-channel".to_string(),
                initiator_id: "fresh-caller".to_string(),
                phase: VoiceCallPhase::Ringing,
                started_at: fresh_started_at,
                expires_at: Some(fresh_started_at + Duration::seconds(RING_SECONDS)),
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&["new-callee"]),
            },
            notify_recipients: ids(&["new-callee"]),
            stop_previous_ringing_recipients: ids(&["old-callee"]),
        }
    );
}

#[test]
fn callee_cannot_cancel_ringing_dm_call() {
    let call = ringing_call("dm-channel", "caller");

    assert_eq!(
        voice_call_cancel_effect(Some(&call), "callee", &ids(&["caller", "callee"])),
        VoiceCallCancelEffect::NoChange
    );
}

#[test]
fn initiator_can_cancel_own_ringing_dm_call() {
    let call = ringing_call("dm-channel", "caller");

    assert_eq!(
        voice_call_cancel_effect(Some(&call), "caller", &ids(&["caller", "callee"])),
        VoiceCallCancelEffect::Cancel {
            state: call,
            stop_ringing_recipients: ids(&["callee"]),
        }
    );
}

#[test]
fn callee_declining_ringing_dm_call_stops_ringing_but_keeps_call_joinable() {
    let call = ringing_call("dm-channel", "caller");
    let declined_at = Timestamp::UNIX_EPOCH + Duration::seconds(5);

    assert_eq!(
        voice_call_decline_effect(
            Some(&call),
            "callee",
            &ids(&["caller", "callee"]),
            declined_at,
            GROUP_UNANSWERED_ACTIVE_SECONDS,
        ),
        VoiceCallDeclineEffect::Decline {
            state: VoiceCallState {
                channel_id: "dm-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Active,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: Some(declined_at + Duration::seconds(GROUP_UNANSWERED_ACTIVE_SECONDS)),
                declined_recipients: ids(&["callee"]),
                ringing_recipients: ids(&[]),
            },
            stop_ringing_recipients: ids(&["callee"]),
        }
    );
}

#[test]
fn declined_callee_can_later_join_the_same_dm_call() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(10 * 60)),
        declined_recipients: ids(&["callee"]),
        ringing_recipients: ids(&[]),
        ..ringing_call("dm-channel", "caller")
    };

    assert_eq!(
        voice_call_join_effect(
            Some(&call),
            "dm-channel",
            "callee",
            &ids(&["caller", "callee"]),
            &ids(&["caller"]),
            None,
            Timestamp::UNIX_EPOCH + Duration::seconds(60),
            RING_SECONDS,
        ),
        VoiceCallJoinEffect::MarkActive {
            state: VoiceCallState {
                channel_id: "dm-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Active,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: None,
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&[]),
            },
            stop_ringing_recipients: ids(&[]),
        }
    );
}

#[test]
fn active_dm_call_cannot_be_cancelled_as_ringing() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: None,
        ringing_recipients: ids(&[]),
        ..ringing_call("dm-channel", "caller")
    };

    assert_eq!(
        voice_call_cancel_effect(Some(&call), "callee", &ids(&["caller", "callee"])),
        VoiceCallCancelEffect::NoChange
    );
}

#[test]
fn group_call_decline_is_not_a_backend_cancel() {
    let mut call = ringing_call("group-channel", "caller");
    call.ringing_recipients = ids(&["callee-a", "callee-b"]);

    assert_eq!(
        voice_call_cancel_effect(
            Some(&call),
            "callee-a",
            &ids(&["caller", "callee-a", "callee-b"]),
        ),
        VoiceCallCancelEffect::NoChange
    );
}

#[test]
fn expired_ringing_call_ends_the_call() {
    let call = ringing_call("dm-channel", "caller");

    assert_eq!(
        voice_call_expire_effect(
            Some(&call),
            Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS),
            false,
            GROUP_UNANSWERED_ACTIVE_SECONDS,
            &ids(&["caller"]),
        ),
        VoiceCallExpireEffect::End {
            state: call,
            ended_reason: VoiceCallEndReason::Missed,
        }
    );
}

#[test]
fn expired_group_ringing_call_stops_ringing_but_keeps_call_joinable() {
    let mut call = ringing_call("group-channel", "caller");
    call.ringing_recipients = ids(&["callee-a", "callee-b"]);
    let ring_expires_at = call.expires_at.clone().unwrap();

    assert_eq!(
        voice_call_expire_effect(
            Some(&call),
            ring_expires_at,
            true,
            GROUP_UNANSWERED_ACTIVE_SECONDS,
            &ids(&["caller"]),
        ),
        VoiceCallExpireEffect::StopRinging {
            state: VoiceCallState {
                channel_id: "group-channel".to_string(),
                initiator_id: "caller".to_string(),
                phase: VoiceCallPhase::Active,
                started_at: Timestamp::UNIX_EPOCH,
                expires_at: Some(
                    ring_expires_at + Duration::seconds(GROUP_UNANSWERED_ACTIVE_SECONDS)
                ),
                declined_recipients: ids(&[]),
                ringing_recipients: ids(&[]),
            },
            stop_ringing_recipients: ids(&["callee-a", "callee-b"]),
        }
    );
}

#[test]
fn ringing_call_without_connected_members_ends_instead_of_becoming_joinable() {
    let mut call = ringing_call("group-channel", "caller");
    call.ringing_recipients = ids(&["callee-a", "callee-b"]);

    assert_eq!(
        voice_call_expire_effect(
            Some(&call),
            Timestamp::UNIX_EPOCH,
            true,
            GROUP_UNANSWERED_ACTIVE_SECONDS,
            &[],
        ),
        VoiceCallExpireEffect::End {
            state: call,
            ended_reason: VoiceCallEndReason::Cancelled,
        }
    );
}

#[test]
fn active_call_without_connected_members_ends_even_without_deadline() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: None,
        ringing_recipients: ids(&[]),
        ..ringing_call("dm-channel", "caller")
    };

    assert_eq!(
        voice_call_expire_effect(
            Some(&call),
            Timestamp::UNIX_EPOCH,
            false,
            GROUP_UNANSWERED_ACTIVE_SECONDS,
            &[],
        ),
        VoiceCallExpireEffect::End {
            state: call,
            ended_reason: VoiceCallEndReason::Completed,
        }
    );
}

#[test]
fn unanswered_group_active_grace_expires_when_only_initiator_remains() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(10 * 60)),
        ringing_recipients: ids(&[]),
        ..ringing_call("group-channel", "caller")
    };

    assert_eq!(
        voice_call_expire_effect(
            Some(&call),
            Timestamp::UNIX_EPOCH + Duration::seconds(10 * 60),
            true,
            GROUP_UNANSWERED_ACTIVE_SECONDS,
            &ids(&["caller"]),
        ),
        VoiceCallExpireEffect::End {
            state: call,
            ended_reason: VoiceCallEndReason::Missed,
        }
    );
}

#[test]
fn group_active_grace_deadline_is_cleared_when_someone_answered() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(10 * 60)),
        ringing_recipients: ids(&[]),
        ..ringing_call("group-channel", "caller")
    };

    assert_eq!(
        voice_call_expire_effect(
            Some(&call),
            Timestamp::UNIX_EPOCH + Duration::seconds(10 * 60),
            true,
            GROUP_UNANSWERED_ACTIVE_SECONDS,
            &ids(&["caller", "callee"]),
        ),
        VoiceCallExpireEffect::ClearActiveDeadline(VoiceCallState {
            channel_id: "group-channel".to_string(),
            initiator_id: "caller".to_string(),
            phase: VoiceCallPhase::Active,
            started_at: Timestamp::UNIX_EPOCH,
            expires_at: None,
            declined_recipients: ids(&[]),
            ringing_recipients: ids(&[]),
        })
    );
}

#[test]
fn leaving_last_member_ends_call() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: None,
        ..ringing_call("dm-channel", "caller")
    };

    let effect = voice_call_leave_effect(
        Some(&call),
        VoiceCallLeaveReason::ParticipantLeft {
            remaining_members_after_leave: &[],
            leave_policy: VoiceCallLeavePolicy::EndWhenEmpty,
        },
    );

    assert_eq!(
        effect,
        VoiceCallLeaveEffect::End {
            state: call,
            stop_ringing_recipients: ids(&[]),
        }
    );
}

#[test]
fn leaving_unanswered_ringing_call_stops_only_ringing_recipients() {
    let mut call = ringing_call("group-channel", "caller");
    call.ringing_recipients = ids(&["callee-a", "callee-b"]);

    let effect = voice_call_leave_effect(
        Some(&call),
        VoiceCallLeaveReason::ParticipantLeft {
            remaining_members_after_leave: &[],
            leave_policy: VoiceCallLeavePolicy::EndWhenEmpty,
        },
    );

    assert_eq!(
        effect,
        VoiceCallLeaveEffect::End {
            state: call,
            stop_ringing_recipients: ids(&["callee-a", "callee-b"]),
        }
    );
}

#[test]
fn group_call_keeps_running_when_members_remain_after_leave() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: None,
        ..ringing_call("group-channel", "caller")
    };

    let remaining_members = ids(&["callee"]);
    let effect = voice_call_leave_effect(
        Some(&call),
        VoiceCallLeaveReason::ParticipantLeft {
            remaining_members_after_leave: &remaining_members,
            leave_policy: VoiceCallLeavePolicy::EndWhenEmpty,
        },
    );

    assert_eq!(effect, VoiceCallLeaveEffect::NoChange);
}

#[test]
fn dm_call_ends_when_any_participant_leaves() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: None,
        ..ringing_call("dm-channel", "caller")
    };

    let remaining_members = ids(&["callee"]);
    let effect = voice_call_leave_effect(
        Some(&call),
        VoiceCallLeaveReason::ParticipantLeft {
            remaining_members_after_leave: &remaining_members,
            leave_policy: VoiceCallLeavePolicy::EndWhenAnyParticipantLeaves,
        },
    );

    assert_eq!(
        effect,
        VoiceCallLeaveEffect::End {
            state: call,
            stop_ringing_recipients: ids(&[]),
        }
    );
}

#[test]
fn finished_room_ends_call_even_when_members_were_present_before_cleanup() {
    let call = VoiceCallState {
        phase: VoiceCallPhase::Active,
        expires_at: None,
        ..ringing_call("dm-channel", "caller")
    };

    let effect = voice_call_leave_effect(Some(&call), VoiceCallLeaveReason::RoomFinished);

    assert_eq!(
        effect,
        VoiceCallLeaveEffect::End {
            state: call,
            stop_ringing_recipients: ids(&[]),
        }
    );
}

#[test]
fn voice_call_state_round_trips_through_redis_value() {
    let call = VoiceCallState {
        channel_id: "dm-channel".to_string(),
        initiator_id: "caller".to_string(),
        phase: VoiceCallPhase::Ringing,
        started_at: Timestamp::UNIX_EPOCH,
        expires_at: Some(Timestamp::UNIX_EPOCH + Duration::seconds(RING_SECONDS)),
        declined_recipients: ids(&[]),
        ringing_recipients: ids(&["callee"]),
    };

    let args = call.to_redis_args();
    let stored = Value::Data(args[0].clone());

    assert_eq!(VoiceCallState::from_redis_value(&stored).unwrap(), call);
}
