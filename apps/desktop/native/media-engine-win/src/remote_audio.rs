use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures::StreamExt;
use livekit::prelude::*;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use tokio::task::JoinHandle;

use crate::event_emitter::emit_engine_event;

const SAMPLE_RATE: i32 = 48_000;
const NUM_CHANNELS: i32 = 1;

pub struct RemoteAudioForwarder {
    tasks: Vec<JoinHandle<()>>,
}

impl RemoteAudioForwarder {
    pub fn new() -> Self {
        Self { tasks: Vec::new() }
    }

    pub fn stop(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }

    pub fn subscribe_track(
        &mut self,
        participant_identity: String,
        audio_track: RemoteAudioTrack,
    ) {
        let rtc_track = audio_track.rtc_track();
        let task = tokio::spawn(async move {
            let mut stream =
                NativeAudioStream::new(rtc_track, SAMPLE_RATE, NUM_CHANNELS);

            while let Some(frame) = stream.next().await {
                let samples = frame.data.to_vec();
                if samples.is_empty() {
                    continue;
                }

                let bytes: Vec<u8> = samples
                    .iter()
                    .flat_map(|sample| sample.to_le_bytes())
                    .collect();

                emit_engine_event(
                    "remote.audio.frame",
                    serde_json::json!({
                        "userId": participant_identity,
                        "sampleRate": frame.sample_rate,
                        "channels": frame.num_channels,
                        "samplesPerChannel": frame.samples_per_channel,
                        "pcmBase64": STANDARD.encode(bytes),
                    }),
                );
            }

            emit_engine_event(
                "remote.audio.ended",
                serde_json::json!({ "userId": participant_identity }),
            );
        });

        self.tasks.push(task);
    }
}

pub fn emit_participants_snapshot(room: &Arc<Room>) {
    let participants: Vec<serde_json::Value> = room
        .remote_participants()
        .values()
        .map(|participant| {
            serde_json::json!({
                "userId": participant.identity().to_string(),
                "sid": participant.sid().to_string(),
            })
        })
        .collect();

    emit_engine_event(
        "room.participants",
        serde_json::json!({
            "localUserId": room.local_participant().identity().to_string(),
            "participants": participants,
        }),
    );
}

pub fn emit_room_connected(room: &Arc<Room>) {
    emit_engine_event(
        "room.connected",
        serde_json::json!({
            "roomName": room.name(),
            "sid": room.sid(),
            "localUserId": room.local_participant().identity().to_string(),
        }),
    );
}

pub fn emit_room_disconnected() {
    emit_engine_event("room.disconnected", serde_json::json!({}));
}
