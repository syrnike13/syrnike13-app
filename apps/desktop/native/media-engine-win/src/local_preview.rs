use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use livekit::webrtc::video_frame::I420Buffer;

use crate::capture::color_convert::i420_buffer_to_jpeg;
use crate::event_emitter::emit_engine_event;

const MIN_PREVIEW_INTERVAL_MS: i64 = 66;

struct PreviewThrottle {
    last_ms: AtomicI64,
}

impl PreviewThrottle {
    const fn new() -> Self {
        Self {
            last_ms: AtomicI64::new(0),
        }
    }

    fn allow(&self, now_ms: i64) -> bool {
        let last = self.last_ms.load(Ordering::Relaxed);
        if now_ms - last < MIN_PREVIEW_INTERVAL_MS {
            return false;
        }
        self.last_ms.store(now_ms, Ordering::Relaxed);
        true
    }
}

static SCREEN_PREVIEW: PreviewThrottle = PreviewThrottle::new();
static CAMERA_PREVIEW: PreviewThrottle = PreviewThrottle::new();

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn maybe_emit_local_preview_frame(source: &str, buffer: &I420Buffer) {
    let throttle = match source {
        "screen" => &SCREEN_PREVIEW,
        "camera" => &CAMERA_PREVIEW,
        _ => return,
    };

    let timestamp = now_ms();
    if !throttle.allow(timestamp) {
        return;
    }

    let width = buffer.width();
    let height = buffer.height();
    if width == 0 || height == 0 {
        return;
    }

    let jpeg = match i420_buffer_to_jpeg(buffer, 75) {
        Ok(jpeg) => jpeg,
        Err(error) => {
            log::warn!("local preview jpeg encode failed: {error}");
            return;
        }
    };

    emit_engine_event(
        "local.preview.frame",
        serde_json::json!({
            "source": source,
            "width": width,
            "height": height,
            "jpegBase64": STANDARD.encode(jpeg),
        }),
    );
}

pub fn emit_local_preview_ended(source: &str) {
    emit_engine_event(
        "local.preview.ended",
        serde_json::json!({ "source": source }),
    );
}
