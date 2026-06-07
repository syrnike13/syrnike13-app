use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::AudioSourceOptions;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::protocol::{EventMessage, RoomConnectResult, ScreenStartParams, ScreenStartResult};
use crate::screen_publish::ScreenPublisher;

pub struct LiveKitRoom {
    inner: Mutex<LiveKitRoomInner>,
}

struct LiveKitRoomInner {
    room: Option<Arc<Room>>,
    event_task: Option<JoinHandle<()>>,
    tone_task: Option<JoinHandle<()>>,
    tone_stop: Option<Arc<AtomicBool>>,
    screen_publisher: ScreenPublisher,
}

impl LiveKitRoom {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(LiveKitRoomInner {
                room: None,
                event_task: None,
                tone_task: None,
                tone_stop: None,
                screen_publisher: ScreenPublisher::new(),
            }),
        }
    }

    pub async fn connect(&self, url: String, token: String) -> Result<RoomConnectResult, String> {
        let mut inner = self.inner.lock().await;
        self.stop_tone_locked(&mut inner).await;
        self.stop_event_task_locked(&mut inner);

        if let Some(room) = inner.room.take() {
            room.close().await;
        }

        let (room, mut events) = Room::connect(&url, &token, RoomOptions::default())
            .await
            .map_err(|error| error.to_string())?;

        let room = Arc::new(room);
        let room_name = room.name();
        let sid = room.sid();

        let observed = room.clone();
        inner.event_task = Some(tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                log::debug!("livekit event: {:?}", event);
                let _ = &observed;
            }
        }));

        inner.room = Some(room);

        Ok(RoomConnectResult { room_name, sid })
    }

    pub async fn start_screen(
        &self,
        params: ScreenStartParams,
    ) -> Result<ScreenStartResult, String> {
        let inner = self.inner.lock().await;
        let room = inner
            .room
            .as_ref()
            .ok_or_else(|| "room is not connected".to_string())?
            .clone();
        inner.screen_publisher.start(room, params).await
    }

    pub async fn stop_screen(&self) -> Result<(), String> {
        let inner = self.inner.lock().await;
        inner.screen_publisher.stop().await
    }

    pub async fn disconnect(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        inner.screen_publisher.stop().await?;
        self.stop_tone_locked(&mut inner).await;
        self.stop_event_task_locked(&mut inner);

        if let Some(room) = inner.room.take() {
            room.close().await;
        }

        Ok(())
    }

    pub async fn publish_test_tone(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let room = inner
            .room
            .as_ref()
            .ok_or_else(|| "room is not connected".to_string())?
            .clone();

        self.stop_tone_locked(&mut inner).await;

        let source = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 0);
        let track = LocalAudioTrack::create_audio_track(
            "test-tone",
            RtcAudioSource::Native(source.clone()),
        );

        room.local_participant()
            .publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| error.to_string())?;

        let stop = Arc::new(AtomicBool::new(true));
        let stop_flag = stop.clone();
        inner.tone_stop = Some(stop);
        inner.tone_task = Some(tokio::spawn(async move {
            if let Err(error) = run_test_tone(source, stop_flag).await {
                log::warn!("test tone stopped: {error}");
            }
        }));

        Ok(())
    }

    pub fn room_state_event(&self) -> EventMessage {
        EventMessage::new("room.state", serde_json::json!({ "connected": true }))
    }

    fn stop_event_task_locked(&self, inner: &mut LiveKitRoomInner) {
        if let Some(task) = inner.event_task.take() {
            task.abort();
        }
    }

    async fn stop_tone_locked(&self, inner: &mut LiveKitRoomInner) {
        if let Some(stop) = inner.tone_stop.take() {
            stop.store(false, Ordering::SeqCst);
        }
        if let Some(task) = inner.tone_task.take() {
            let _ = task.await;
        }
    }
}

async fn run_test_tone(
    source: NativeAudioSource,
    running: Arc<AtomicBool>,
) -> Result<(), String> {
    let sample_rate = 48_000u32;
    let frequency = 440.0f32;
    let samples_per_channel = (sample_rate / 100) as usize;
    let mut phase = 0.0f32;
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(10));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    while running.load(Ordering::SeqCst) {
        interval.tick().await;

        let mut data = Vec::with_capacity(samples_per_channel);
        for _ in 0..samples_per_channel {
            let sample = (phase.sin() * i16::MAX as f32 * 0.2) as i16;
            data.push(sample);
            phase += 2.0 * std::f32::consts::PI * frequency / sample_rate as f32;
        }

        let frame = AudioFrame {
            data: data.into(),
            sample_rate,
            num_channels: 1,
            samples_per_channel: samples_per_channel as u32,
        };

        source
            .capture_frame(&frame)
            .await
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}
