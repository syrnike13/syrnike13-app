use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle as TokioJoinHandle;

use crate::capture::audio_loopback::{
    audio_mode_label, resolve_audio_loopback_target, AudioLoopbackCapture,
};
use crate::capture::color_convert::bgra_to_i420;
use crate::capture::hybrid::{CaptureMethod, HybridCapturer};
use crate::capture::target::{parse_target, CaptureTarget};
use crate::protocol::{ScreenStartParams, ScreenStartResult};

pub struct ScreenPublisher {
    inner: AsyncMutex<Option<ScreenPublisherInner>>,
}

struct ScreenPublisherInner {
    stop: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
    video_publish_task: Option<TokioJoinHandle<()>>,
    audio_publish_task: Option<TokioJoinHandle<()>>,
    audio_capture: Option<AudioLoopbackCapture>,
}

impl ScreenPublisher {
    pub fn new() -> Self {
        Self {
            inner: AsyncMutex::new(None),
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

        let audio_target = resolve_audio_loopback_target(
            &target,
            params.with_audio,
            exclude_process_id,
            self_window_hwnd,
        );
        let audio_mode = if params.with_audio {
            Some(
                audio_target
                    .as_ref()
                    .map(audio_mode_label)
                    .unwrap_or("none")
                    .to_string(),
            )
        } else {
            None
        };

        let mut audio_capture = None;
        let mut audio_publish_task = None;

        if let Some(loopback_target) = audio_target {
            let audio_source = NativeAudioSource::new(
                AudioSourceOptions::default(),
                SAMPLE_RATE,
                NUM_CHANNELS,
                0,
            );
            let audio_track = LocalAudioTrack::create_audio_track(
                "screen_share_audio",
                RtcAudioSource::Native(audio_source.clone()),
            );

            room.local_participant()
                .publish_track(
                    LocalTrack::Audio(audio_track),
                    TrackPublishOptions {
                        source: TrackSource::ScreenshareAudio,
                        ..Default::default()
                    },
                )
                .await
                .map_err(|error| error.to_string())?;

            let (audio_tx, mut audio_rx) = tokio::sync::mpsc::channel::<Vec<i16>>(8);
            audio_capture = Some(AudioLoopbackCapture::start(loopback_target, audio_tx)?);

            audio_publish_task = Some(tokio::spawn(async move {
                while let Some(samples) = audio_rx.recv().await {
                    if samples.is_empty() {
                        continue;
                    }

                    let samples_per_channel =
                        (samples.len() / NUM_CHANNELS as usize) as u32;
                    if samples_per_channel == 0 {
                        continue;
                    }

                    let frame = AudioFrame {
                        data: samples.into(),
                        sample_rate: SAMPLE_RATE,
                        num_channels: NUM_CHANNELS,
                        samples_per_channel,
                    };

                    if audio_source.capture_frame(&frame).await.is_err() {
                        break;
                    }
                }
            }));
        }

        let stop = Arc::new(AtomicBool::new(true));
        let stop_flag = Arc::clone(&stop);
        let active_method = Arc::new(Mutex::new(CaptureMethod::Wgc.as_str().to_string()));
        let active_method_for_capture = Arc::clone(&active_method);
        let (frame_tx, mut frame_rx) =
            tokio::sync::mpsc::channel::<(I420Buffer, i64)>(2);

        let video_publish_task = tokio::spawn(async move {
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
                    active_method_for_capture,
                ) {
                    log::warn!("screen capture loop stopped: {error}");
                }
            })
            .map_err(|error| error.to_string())?;

        let active_method = active_method
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| CaptureMethod::Wgc.as_str().to_string());

        let mut inner = self.inner.lock().await;
        *inner = Some(ScreenPublisherInner {
            stop,
            capture_thread: Some(capture_thread),
            video_publish_task: Some(video_publish_task),
            audio_publish_task,
            audio_capture,
        });

        Ok(ScreenStartResult {
            audio_mode,
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
        if let Some(capture) = session.audio_capture {
            capture.stop();
        }
        if let Some(task) = session.video_publish_task {
            task.abort();
        }
        if let Some(task) = session.audio_publish_task {
            task.abort();
        }

        Ok(())
    }
}

const SAMPLE_RATE: u32 = 48_000;
const NUM_CHANNELS: u32 = 2;

fn run_capture_loop(
    target: CaptureTarget,
    width: u32,
    height: u32,
    fps: u32,
    stop: Arc<AtomicBool>,
    frame_tx: tokio::sync::mpsc::Sender<(I420Buffer, i64)>,
    active_method: Arc<Mutex<String>>,
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

        if let Ok(mut method) = active_method.lock() {
            *method = frame.method.as_str().to_string();
        }

        let buffer = bgra_to_i420(&frame.bgra, frame.width, frame.height, frame.stride)?;
        let timestamp_us = started_at.elapsed().as_micros() as i64;
        if frame_tx.blocking_send((buffer, timestamp_us)).is_err() {
            break;
        }

        let elapsed = tick_started.elapsed();
        if elapsed < frame_interval {
            thread::sleep(frame_interval - elapsed);
        }
    }

    Ok(())
}
