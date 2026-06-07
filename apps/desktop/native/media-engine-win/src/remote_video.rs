use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures::StreamExt;
use livekit::prelude::*;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use tokio::task::JoinHandle;

use crate::capture::color_convert::{i420_buffer_to_jpeg, video_source_label};
use crate::event_emitter::emit_engine_event;

const MIN_FRAME_INTERVAL: Duration = Duration::from_millis(66);

pub struct RemoteVideoForwarder {
    tasks: Vec<JoinHandle<()>>,
}

impl RemoteVideoForwarder {
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
        source: TrackSource,
        video_track: RemoteVideoTrack,
    ) {
        let Some(source_label) = video_source_label(source) else {
            return;
        };

        let rtc_track = video_track.rtc_track();
        let task = tokio::spawn(async move {
            let mut stream = NativeVideoStream::new(rtc_track);
            let mut last_emit = Instant::now()
                .checked_sub(MIN_FRAME_INTERVAL)
                .unwrap_or_else(Instant::now);

            while let Some(frame) = stream.next().await {
                if last_emit.elapsed() < MIN_FRAME_INTERVAL {
                    continue;
                }

                let buffer = frame.buffer;
                let width = buffer.width();
                let height = buffer.height();
                if width == 0 || height == 0 {
                    continue;
                }

                let jpeg = match i420_buffer_to_jpeg(&buffer, 75) {
                    Ok(jpeg) => jpeg,
                    Err(error) => {
                        log::warn!("remote video jpeg encode failed: {error}");
                        continue;
                    }
                };

                last_emit = Instant::now();
                emit_engine_event(
                    "remote.video.frame",
                    serde_json::json!({
                        "userId": participant_identity,
                        "source": source_label,
                        "width": width,
                        "height": height,
                        "jpegBase64": STANDARD.encode(jpeg),
                    }),
                );
            }

            emit_engine_event(
                "remote.video.ended",
                serde_json::json!({
                    "userId": participant_identity,
                    "source": source_label,
                }),
            );
        });

        self.tasks.push(task);
    }
}

pub fn emit_track_published(
    user_id: &str,
    source: TrackSource,
    subscribed: bool,
    muted: bool,
) {
    let Some(source_label) = video_source_label(source) else {
        return;
    };

    emit_engine_event(
        "track.published",
        serde_json::json!({
            "userId": user_id,
            "source": source_label,
            "subscribed": subscribed,
            "muted": muted,
        }),
    );
}

pub fn emit_track_unpublished(user_id: &str, source: TrackSource) {
    let Some(source_label) = video_source_label(source) else {
        return;
    };

    emit_engine_event(
        "track.unpublished",
        serde_json::json!({
            "userId": user_id,
            "source": source_label,
        }),
    );
}
