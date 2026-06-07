use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use tokio::sync::Mutex;
use tokio::task::JoinHandle as TokioJoinHandle;

use crate::capture::color_convert::bgra_to_i420;
use crate::capture::hybrid::{CaptureMethod, HybridCapturer};
use crate::capture::target::{parse_target, CaptureTarget};
use crate::protocol::{ScreenStartParams, ScreenStartResult};

pub struct ScreenPublisher {
    inner: Mutex<Option<ScreenPublisherInner>>,
}

struct ScreenPublisherInner {
    stop: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
    publish_task: Option<TokioJoinHandle<()>>,
}

impl ScreenPublisher {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub async fn start(
        &self,
        room: Arc<Room>,
        params: ScreenStartParams,
    ) -> Result<ScreenStartResult, String> {
        self.stop().await?;

        let target = parse_target(&params.source_id)
            .ok_or_else(|| format!("unsupported capture source id: {}", params.source_id))?;

        let width = params.width.max(2);
        let height = params.height.max(2);
        let fps = params.fps.max(1);
        let exclude_process_id = params.exclude_process_id.unwrap_or(0);
        let self_window_hwnd = params.self_window_hwnd;

        let video_source =
            NativeVideoSource::new(VideoResolution { width, height });
        let track = LocalVideoTrack::create_video_track(
            "screen_share",
            RtcVideoSource::Native(video_source.clone()),
        );

        let mut publish_options = TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: VideoCodec::H264,
            simulcast: false,
            ..Default::default()
        };
        if let Some(encoding) = params.max_bitrate {
            publish_options.video_encoding = Some(VideoEncoding {
                max_bitrate: encoding,
                max_framerate: fps,
            });
        }

        room.local_participant()
            .publish_track(LocalTrack::Video(track), publish_options)
            .await
            .map_err(|error| error.to_string())?;

        let audio_mode = resolve_screen_audio_mode(
            &target,
            params.with_audio,
            exclude_process_id,
            self_window_hwnd,
        );

        let stop = Arc::new(AtomicBool::new(true));
        let stop_flag = Arc::clone(&stop);
        let (frame_tx, mut frame_rx) =
            tokio::sync::mpsc::channel::<(I420Buffer, i64)>(2);

        let publish_task = tokio::spawn(async move {
            let mut frame = VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: 0,
                frame_metadata: None,
                buffer: I420Buffer::new(width, height),
            };

            while let Some((buffer, timestamp_us)) = frame_rx.recv().await {
                frame.timestamp_us = timestamp_us;
                frame.buffer = buffer;
                if video_source.capture_frame(&frame).await.is_err() {
                    break;
                }
            }
        });

        let capture_thread = thread::Builder::new()
            .name("screen-capture".into())
            .spawn(move || {
                if let Err(error) = run_capture_loop(
                    target,
                    width,
                    height,
                    fps,
                    stop_flag,
                    frame_tx,
                ) {
                    log::warn!("screen capture loop stopped: {error}");
                }
            })
            .map_err(|error| error.to_string())?;

        let active_method = "wgc".to_string();
        let mut inner = self.inner.lock().await;
        *inner = Some(ScreenPublisherInner {
            stop,
            capture_thread: Some(capture_thread),
            publish_task: Some(publish_task),
        });

        Ok(ScreenStartResult {
            audio_mode: audio_mode.map(str::to_string),
            active_method,
        })
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let Some(session) = inner.take() else {
            return Ok(());
        };

        session.stop.store(false, Ordering::SeqCst);
        if let Some(thread) = session.capture_thread {
            let _ = thread.join();
        }
        if let Some(task) = session.publish_task {
            task.abort();
        }

        Ok(())
    }
}

fn resolve_screen_audio_mode(
    target: &CaptureTarget,
    with_audio: bool,
    exclude_process_id: u32,
    self_window_hwnd: Option<isize>,
) -> Option<String> {
    if !with_audio {
        return None;
    }

    if target
        .hwnd
        .is_some_and(|hwnd| self_window_hwnd.is_some_and(|self_hwnd| hwnd == self_hwnd))
    {
        return Some("none".into());
    }

    if target.hwnd.is_some() {
        return Some("process".into());
    }

    if exclude_process_id == 0 {
        return Some("none".into());
    }

    Some("system_exclude".into())
}

fn run_capture_loop(
    target: CaptureTarget,
    width: u32,
    height: u32,
    fps: u32,
    stop: Arc<AtomicBool>,
    frame_tx: tokio::sync::mpsc::Sender<(I420Buffer, i64)>,
) -> Result<(), String> {
    let mut capturer = HybridCapturer::new(target, width, height)?;
    let frame_interval = Duration::from_micros(1_000_000 / fps as u64);
    let started_at = Instant::now();

    while stop.load(Ordering::SeqCst) {
        let tick_started = Instant::now();
        let frame = capturer.capture()?;
        if frame.bgra.is_empty() {
            thread::sleep(Duration::from_millis(5));
            continue;
        }

        let buffer = bgra_to_i420(&frame.bgra, frame.width, frame.height, frame.stride)?;
        let timestamp_us = started_at.elapsed().as_micros() as i64;
        if frame_tx.blocking_send((buffer, timestamp_us)).is_err() {
            break;
        }

        let _ = frame.method;
        let _ = CaptureMethod::Wgc;

        let elapsed = tick_started.elapsed();
        if elapsed < frame_interval {
            thread::sleep(frame_interval - elapsed);
        }
    }

    Ok(())
}
