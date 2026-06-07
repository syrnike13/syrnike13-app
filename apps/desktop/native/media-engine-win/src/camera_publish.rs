use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{CameraIndex, RequestedFormat, RequestedFormatType};
use nokhwa::Camera;
use tokio::sync::mpsc;
use tokio::task::JoinHandle as TokioJoinHandle;

use crate::capture::color_convert::rgb_to_i420;
use crate::devices::resolve_camera_index;
use crate::local_preview::{emit_local_preview_ended, maybe_emit_local_preview_frame};

const CAMERA_WIDTH: u32 = 640;
const CAMERA_HEIGHT: u32 = 480;
const CAMERA_FPS: u32 = 15;

pub struct CameraPublisher {
    stop: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
    publish_task: Option<TokioJoinHandle<()>>,
    video_source: Option<NativeVideoSource>,
    track_sid: Option<String>,
    device_id: Option<String>,
}

impl CameraPublisher {
    pub fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            publish_task: None,
            video_source: None,
            track_sid: None,
            device_id: None,
        }
    }

    pub fn set_device_id(&mut self, device_id: Option<String>) {
        self.device_id = device_id.filter(|value| !value.is_empty());
    }

    pub async fn start(&mut self, room: Arc<Room>) -> Result<(), String> {
        self.stop(room.as_ref()).await?;

        let video_source = NativeVideoSource::new(VideoResolution {
            width: CAMERA_WIDTH,
            height: CAMERA_HEIGHT,
        });
        let track = LocalVideoTrack::create_video_track(
            "camera",
            RtcVideoSource::Native(video_source.clone()),
        );

        let publication = room
            .local_participant()
            .publish_track(
                LocalTrack::Video(track),
                TrackPublishOptions {
                    source: TrackSource::Camera,
                    simulcast: false,
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| error.to_string())?;

        let (frame_tx, mut frame_rx) = mpsc::channel::<I420Buffer>(2);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stop);

        let camera_index = resolve_camera_index(self.device_id.as_deref());
        let capture_thread = thread::Builder::new()
            .name("camera-capture".into())
            .spawn(move || {
                if let Err(error) = run_camera_capture(stop_flag, frame_tx, camera_index) {
                    log::warn!("camera capture stopped: {error}");
                }
            })
            .map_err(|error| error.to_string())?;

        let publish_task = tokio::spawn(async move {
            while let Some(buffer) = frame_rx.recv().await {
                let frame = VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    buffer,
                    timestamp_us: 0,
                };

                if video_source.capture_frame(&frame).await.is_err() {
                    break;
                }
            }
        });

        self.stop = stop;
        self.capture_thread = Some(capture_thread);
        self.publish_task = Some(publish_task);
        self.video_source = Some(video_source);
        self.track_sid = Some(publication.sid().to_string());

        Ok(())
    }

    pub async fn stop(&mut self, room: &Room) -> Result<(), String> {
        self.stop.store(true, Ordering::SeqCst);

        if let Some(thread) = self.capture_thread.take() {
            let _ = thread.join();
        }

        if let Some(task) = self.publish_task.take() {
            task.abort();
        }

        if let Some(sid) = self.track_sid.take() {
            let _ = room
                .local_participant()
                .unpublish_track(&TrackSid::from(sid))
                .await;
        }

        self.video_source = None;
        emit_local_preview_ended("camera");
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.capture_thread.is_some()
    }
}

fn run_camera_capture(
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<I420Buffer>,
    index: CameraIndex,
) -> Result<(), String> {
    let requested = RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
    let mut camera = Camera::new(index, requested).map_err(|error| error.to_string())?;
    camera.open_stream().map_err(|error| error.to_string())?;

    let frame_interval = Duration::from_millis(1_000 / CAMERA_FPS as u64);
    let mut next_frame_at = Instant::now();

    while !stop.load(Ordering::SeqCst) {
        if Instant::now() < next_frame_at {
            thread::sleep(Duration::from_millis(5));
            continue;
        }

        let frame = match camera.frame() {
            Ok(frame) => frame,
            Err(error) => {
                log::warn!("camera frame read failed: {error}");
                thread::sleep(Duration::from_millis(20));
                continue;
            }
        };

        let decoded = frame
            .decode_image::<RgbFormat>()
            .map_err(|error| error.to_string())?;
        let (width, height) = decoded.dimensions();
        if width == 0 || height == 0 {
            continue;
        }

        let rgb = decoded.into_raw();
        let buffer = rgb_to_i420(&rgb, width as usize, height as usize)?;
        maybe_emit_local_preview_frame("camera", &buffer);
        if tx.blocking_send(buffer).is_err() {
            let _ = camera.stop_stream();
            return Ok(());
        }

        next_frame_at = Instant::now() + frame_interval;
    }

    let _ = camera.stop_stream();
    Ok(())
}
