use std::time::Duration;

use log::{info, warn};
use syrnike_database::{
    events::client::EventV1,
    iso8601_timestamp::Timestamp,
    voice::{
        call_lifecycle::{
            list_channel_voice_calls, mutate_channel_voice_call_if_current,
            voice_call_expire_effect, VoiceCallExpireEffect, VoiceCallState,
            VoiceCallStateMutation, VoiceCallStateMutationResult, GROUP_UNANSWERED_ACTIVE_SECONDS,
        },
        cleanup_removed_voice_channel, delete_voice_channel,
        finish_voice_call_started_system_message, get_voice_channel_members,
        list_active_voice_channel_ids, reconcile_active_voice_permissions,
        reconcile_pending_voice_transport_cleanups,
        reconcile_voice_channel_members_with_call_cleanup, remove_orphaned_active_voice_channel,
        resolve_active_voice_channel, UserVoiceChannel, VoiceClient,
    },
    Channel, Database, VoiceCallEndReason, AMQP,
};
use syrnike_result::{ErrorType, Result};
use tokio::time::sleep;

const EXPIRED_VOICE_CALL_SWEEP_SECONDS: u64 = 5;
const VOICE_PERMISSION_SWEEP_TICKS: u8 = 6;

pub async fn task(db: Database, voice_client: VoiceClient, amqp: AMQP) -> Result<()> {
    let mut permission_sweep_tick = 0;

    loop {
        if let Err(error) = sweep_voice_call_timeouts(&db, &voice_client, &amqp).await {
            syrnike_config::capture_internal_error!(&error);
            warn!("Failed to sweep voice call timeouts: {error:?}");
        }

        if permission_sweep_tick == 0 {
            if let Err(error) = reconcile_active_voice_permissions(&db, &voice_client).await {
                syrnike_config::capture_internal_error!(&error);
                warn!("Failed to sweep active voice permissions: {error:?}");
            }
        }
        permission_sweep_tick = (permission_sweep_tick + 1) % VOICE_PERMISSION_SWEEP_TICKS;

        sleep(Duration::from_secs(EXPIRED_VOICE_CALL_SWEEP_SECONDS)).await;
    }
}

async fn sweep_voice_call_timeouts(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
) -> Result<()> {
    let now = Timestamp::now_utc();

    if let Err(error) = reconcile_pending_voice_transport_cleanups(db, voice_client).await {
        syrnike_config::capture_internal_error!(&error);
        warn!("Failed to reconcile pending voice transport cleanups: {error:?}");
    }

    for channel_id in list_active_voice_channel_ids().await? {
        let channel = UserVoiceChannel {
            id: channel_id.clone(),
            server_id: None,
        };

        let removed_voice_channel = match db.fetch_channel(&channel_id).await {
            Ok(stored_channel) if stored_channel.voice().is_none() => {
                Some(UserVoiceChannel::from_channel(&stored_channel))
            }
            Err(error) if matches!(error.error_type, ErrorType::NotFound) => {
                match resolve_active_voice_channel(&channel_id).await {
                    Ok(channel) => Some(channel),
                    Err(error) => {
                        syrnike_config::capture_internal_error!(&error);
                        warn!(
                            "Failed to resolve deleted voice channel {channel_id} for cleanup: {error:?}"
                        );
                        None
                    }
                }
            }
            _ => None,
        };
        if let Some(removed_voice_channel) = removed_voice_channel {
            if let Err(error) =
                cleanup_removed_voice_channel(db, voice_client, &removed_voice_channel).await
            {
                syrnike_config::capture_internal_error!(&error);
                warn!("Failed to retry removed voice channel cleanup {channel_id}: {error:?}");
            }
            continue;
        }

        if get_voice_channel_members(&channel).await?.is_none() {
            match reconcile_voice_channel_members_with_call_cleanup(
                db,
                voice_client,
                amqp,
                &channel,
            )
            .await
            {
                Ok(Some(reconciliation))
                    if reconciliation.livekit_members.is_empty()
                        && reconciliation.stale_livekit_participants.is_empty() =>
                {
                    if let Err(error) = remove_orphaned_active_voice_channel(&channel).await {
                        syrnike_config::capture_internal_error!(&error);
                        warn!("Failed to remove orphaned voice channel {channel_id}: {error:?}");
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    syrnike_config::capture_internal_error!(&error);
                    warn!("Failed to reconcile orphaned voice channel {channel_id}: {error:?}");
                }
            }
            continue;
        }
        if let Err(error) =
            reconcile_voice_channel_members_with_call_cleanup(db, voice_client, amqp, &channel)
                .await
        {
            syrnike_config::capture_internal_error!(&error);
            warn!("Failed to reconcile voice channel {channel_id}: {error:?}");
        }
    }

    for call in list_channel_voice_calls().await? {
        let channel_id = call.channel_id.clone();
        if let Err(error) = sweep_voice_call_timeout(db, voice_client, amqp, call, now).await {
            syrnike_config::capture_internal_error!(&error);
            warn!("Failed to sweep voice call {channel_id}: {error:?}");
        }
    }

    Ok(())
}

async fn sweep_voice_call_timeout(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    call: VoiceCallState,
    now: Timestamp,
) -> Result<()> {
    let user_voice_channel = UserVoiceChannel {
        id: call.channel_id.clone(),
        server_id: None,
    };
    let connected_members = get_voice_channel_members(&user_voice_channel)
        .await?
        .unwrap_or_default();
    let keep_joinable_after_ringing = is_group_channel(db, &call.channel_id).await;

    match voice_call_expire_effect(
        Some(&call),
        now,
        keep_joinable_after_ringing,
        GROUP_UNANSWERED_ACTIVE_SECONDS,
        &connected_members,
    ) {
        VoiceCallExpireEffect::NoChange => {}
        VoiceCallExpireEffect::StopRinging {
            state,
            stop_ringing_recipients,
        } => {
            if voice_call_state_changed(&call, VoiceCallStateMutation::Set(state.clone())).await? {
                return Ok(());
            }
            stop_group_ringing(amqp, state, stop_ringing_recipients).await?;
        }
        VoiceCallExpireEffect::ClearActiveDeadline(state) => {
            voice_call_state_changed(&call, VoiceCallStateMutation::Set(state)).await?;
        }
        VoiceCallExpireEffect::End {
            state,
            ended_reason,
        } => {
            if voice_call_state_changed(&call, VoiceCallStateMutation::Delete).await? {
                return Ok(());
            }
            end_timed_out_call(db, voice_client, amqp, state, ended_reason, now).await?;
        }
    }

    Ok(())
}

async fn voice_call_state_changed(
    expected: &VoiceCallState,
    mutation: VoiceCallStateMutation,
) -> Result<bool> {
    Ok(matches!(
        mutate_channel_voice_call_if_current(&expected.channel_id, Some(expected), mutation)
            .await?,
        VoiceCallStateMutationResult::Conflict(_)
    ))
}

async fn is_group_channel(db: &Database, channel_id: &str) -> bool {
    match db.fetch_channel(channel_id).await {
        Ok(Channel::Group { .. }) => true,
        Ok(_) => false,
        Err(error) => {
            syrnike_config::capture_internal_error!(&error);
            false
        }
    }
}

async fn stop_group_ringing(
    amqp: &AMQP,
    state: VoiceCallState,
    stop_ringing_recipients: Vec<String>,
) -> Result<()> {
    EventV1::VoiceCallActive {
        channel_id: state.channel_id.clone(),
        initiator_id: state.initiator_id.clone(),
        started_at: state.started_at,
        expires_at: state.expires_at,
        declined_recipients: state.declined_recipients.clone(),
    }
    .p(state.channel_id.clone())
    .await;

    if !stop_ringing_recipients.is_empty() {
        if let Err(error) = amqp
            .dm_call_updated(
                &state.initiator_id,
                &state.channel_id,
                None,
                true,
                Some(stop_ringing_recipients),
            )
            .await
        {
            syrnike_config::capture_internal_error!(&error);
        }
    }

    info!(
        "Stopped ringing group voice call {} from initiator {}; keeping it joinable for {} seconds",
        state.channel_id, state.initiator_id, GROUP_UNANSWERED_ACTIVE_SECONDS
    );

    Ok(())
}

async fn end_timed_out_call(
    db: &Database,
    voice_client: &VoiceClient,
    amqp: &AMQP,
    state: VoiceCallState,
    ended_reason: VoiceCallEndReason,
    now: Timestamp,
) -> Result<()> {
    EventV1::VoiceCallEnd {
        channel_id: state.channel_id.clone(),
    }
    .p(state.channel_id.clone())
    .await;

    if let Err(error) = amqp
        .dm_call_updated(
            &state.initiator_id,
            &state.channel_id,
            None,
            true,
            (!state.ringing_recipients.is_empty()).then_some(state.ringing_recipients.clone()),
        )
        .await
    {
        syrnike_config::capture_internal_error!(&error);
    }

    let finished_at = match &ended_reason {
        VoiceCallEndReason::Missed => state.expires_at.unwrap_or(now),
        VoiceCallEndReason::Cancelled | VoiceCallEndReason::Completed => now,
    };

    if let Err(error) =
        finish_voice_call_started_system_message(db, &state.channel_id, finished_at, ended_reason)
            .await
    {
        syrnike_config::capture_internal_error!(&error);
    }

    delete_voice_channel(
        voice_client,
        &UserVoiceChannel {
            id: state.channel_id.clone(),
            server_id: None,
        },
    )
    .await?;

    info!(
        "Expired unanswered voice call {} from initiator {}",
        state.channel_id, state.initiator_id
    );

    Ok(())
}
