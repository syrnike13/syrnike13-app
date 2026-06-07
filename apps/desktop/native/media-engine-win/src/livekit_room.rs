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

use crate::camera_publish::CameraPublisher;
use crate::event_emitter::emit_engine_event;
use crate::mic_denoise::NoiseSuppressionMode;
use crate::mic_processing::MicProcessingConfig;
use crate::mic_publish::MicPublisher;
use crate::protocol::{EventMessage, RoomConnectResult, ScreenStartParams, ScreenStartResult};
use crate::room_stats::extract_rtt_ms;
use crate::remote_audio::{
    emit_participants_snapshot, emit_room_connected, emit_room_disconnected, RemoteAudioForwarder,
};
use crate::remote_video::{
    emit_track_published, emit_track_unpublished, RemoteVideoForwarder,
};
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
    mic_publisher: MicPublisher,
    camera_publisher: CameraPublisher,
    remote_audio: RemoteAudioForwarder,
    mic_enabled: bool,
    mic_device_id: Option<String>,
    mic_processing: MicProcessingConfig,
    camera_enabled: bool,
    camera_device_id: Option<String>,
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
                mic_publisher: MicPublisher::new(),
                camera_publisher: CameraPublisher::new(),
                remote_audio: RemoteAudioForwarder::new(),
                mic_enabled: false,
                mic_device_id: None,
                mic_processing: MicProcessingConfig::default(),
                camera_enabled: false,
                camera_device_id: None,
            }),
        }
    }

    pub async fn connect(&self, url: String, token: String) -> Result<RoomConnectResult, String> {
        let mut inner = self.inner.lock().await;
        self.stop_tone_locked(&mut inner).await;
        self.stop_event_task_locked(&mut inner);
        if let Some(room) = inner.room.as_ref() {
            inner.mic_publisher.stop(room).await?;
            inner.camera_publisher.stop(room).await?;
        }
        inner.remote_audio.stop();

        if let Some(room) = inner.room.take() {
            room.close().await;
        }

        let (room, mut events) = Room::connect(&url, &token, RoomOptions::default())
            .await
            .map_err(|error| error.to_string())?;

        let room = Arc::new(room);
        let room_name = room.name();
        let sid = room.sid();

        emit_room_connected(&room);
        emit_participants_snapshot(&room);

        let observed = room.clone();
        inner.event_task = Some(tokio::spawn(async move {
            let mut remote_audio = RemoteAudioForwarder::new();
            let mut remote_video = RemoteVideoForwarder::new();

            while let Some(event) = events.recv().await {
                match event {
                    RoomEvent::TrackSubscribed {
                        track,
                        publication,
                        participant,
                    } => {
                        let user_id = participant.identity().to_string();
                        let source = publication.source();
                        emit_track_published(
                            &user_id,
                            source,
                            publication.is_subscribed(),
                            publication.is_muted(),
                        );

                        match track {
                            RemoteTrack::Audio(audio_track) => {
                                remote_audio.subscribe_track(user_id, audio_track);
                            }
                            RemoteTrack::Video(video_track) => {
                                remote_video.subscribe_track(
                                    user_id,
                                    source,
                                    video_track,
                                );
                            }
                        }
                        emit_participants_snapshot(&observed);
                    }
                    RoomEvent::TrackUnsubscribed { publication, participant, .. } => {
                        emit_track_unpublished(
                            &participant.identity().to_string(),
                            publication.source(),
                        );
                        emit_participants_snapshot(&observed);
                    }
                    RoomEvent::TrackUnpublished { publication, participant } => {
                        emit_track_unpublished(
                            &participant.identity().to_string(),
                            publication.source(),
                        );
                        emit_participants_snapshot(&observed);
                    }
                    RoomEvent::ParticipantConnected(_) | RoomEvent::ParticipantDisconnected(_) => {
                        emit_participants_snapshot(&observed);
                    }
                    RoomEvent::ActiveSpeakersChanged { speakers } => {
                        let user_ids: Vec<String> = speakers
                            .iter()
                            .map(|speaker| speaker.identity().to_string())
                            .collect();
                        emit_engine_event(
                            "room.activeSpeakers",
                            serde_json::json!({ "userIds": user_ids }),
                        );
                    }
                    RoomEvent::Disconnected { .. } => {
                        emit_room_disconnected();
                        break;
                    }
                    _ => {}
                }
            }

            remote_audio.stop();
            remote_video.stop();
        }));

        inner.room = Some(room);
        inner.mic_enabled = false;
        inner.camera_enabled = false;

        Ok(RoomConnectResult { room_name, sid })
    }

    pub async fn set_mic_enabled(
        &self,
        enabled: bool,
        noise_suppression: Option<NoiseSuppressionMode>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let room = inner
            .room
            .as_ref()
            .ok_or_else(|| "room is not connected".to_string())?
            .clone();

        if let Some(mode) = noise_suppression {
            inner.mic_processing.noise_suppression = mode;
        }

        if enabled == inner.mic_enabled {
            inner.mic_publisher.set_processing(inner.mic_processing);
            return Ok(());
        }

        if enabled {
            inner
                .mic_publisher
                .set_device_id(inner.mic_device_id.clone());
            inner
                .mic_publisher
                .start(room.clone(), inner.mic_processing)
                .await?;
        } else {
            inner.mic_publisher.stop(&room).await?;
        }

        inner.mic_enabled = enabled;
        emit_participants_snapshot(&room);
        Ok(())
    }

    pub async fn set_mic_noise_suppression(
        &self,
        mode: NoiseSuppressionMode,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        inner.mic_processing.noise_suppression = mode;
        self.restart_mic_locked(&mut inner).await
    }

    pub async fn set_mic_device(&self, device_id: Option<String>) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        inner.mic_device_id = device_id.filter(|value| !value.is_empty());
        inner
            .mic_publisher
            .set_device_id(inner.mic_device_id.clone());
        self.restart_mic_locked(&mut inner).await
    }

    pub async fn set_mic_processing(
        &self,
        voice_gate_enabled: Option<bool>,
        voice_gate_threshold: Option<f32>,
        noise_suppression: Option<NoiseSuppressionMode>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().await;

        if let Some(enabled) = voice_gate_enabled {
            inner.mic_processing.voice_gate_enabled = enabled;
        }
        if let Some(threshold) = voice_gate_threshold {
            inner.mic_processing.voice_gate_threshold = threshold;
        }
        if let Some(mode) = noise_suppression {
            inner.mic_processing.noise_suppression = mode;
        }

        self.restart_mic_locked(&mut inner).await
    }

    pub async fn get_rtt_ms(&self) -> Result<Option<u32>, String> {
        let inner = self.inner.lock().await;
        let room = inner
            .room
            .as_ref()
            .ok_or_else(|| "room is not connected".to_string())?;
        let stats = room.get_stats().await.map_err(|error| error.to_string())?;
        Ok(extract_rtt_ms(&stats))
    }

    pub async fn set_camera_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let room = inner
            .room
            .as_ref()
            .ok_or_else(|| "room is not connected".to_string())?
            .clone();

        if enabled == inner.camera_enabled {
            return Ok(());
        }

        if enabled {
            inner
                .camera_publisher
                .set_device_id(inner.camera_device_id.clone());
            inner.camera_publisher.start(room.clone()).await?;
        } else {
            inner.camera_publisher.stop(&room).await?;
        }

        inner.camera_enabled = enabled;
        emit_participants_snapshot(&room);
        Ok(())
    }

    pub async fn set_camera_device(&self, device_id: Option<String>) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        inner.camera_device_id = device_id.filter(|value| !value.is_empty());
        inner
            .camera_publisher
            .set_device_id(inner.camera_device_id.clone());
        self.restart_camera_locked(&mut inner).await
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
        let result = inner.screen_publisher.start(room.clone(), params).await?;
        emit_participants_snapshot(&room);
        Ok(result)
    }

    pub async fn stop_screen(&self) -> Result<(), String> {
        let inner = self.inner.lock().await;
        let result = inner.screen_publisher.stop().await;
        if let Some(room) = inner.room.as_ref() {
            emit_participants_snapshot(room);
        }
        result
    }

    pub async fn disconnect(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        inner.screen_publisher.stop().await?;
        if let Some(room) = inner.room.as_ref() {
            inner.mic_publisher.stop(room).await?;
            inner.camera_publisher.stop(room).await?;
        }
        inner.remote_audio.stop();
        self.stop_tone_locked(&mut inner).await;
        self.stop_event_task_locked(&mut inner);

        if let Some(room) = inner.room.take() {
            room.close().await;
        }

        inner.mic_enabled = false;
        inner.camera_enabled = false;
        emit_room_disconnected();
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

    async fn restart_camera_locked(&self, inner: &mut LiveKitRoomInner) -> Result<(), String> {
        if !inner.camera_enabled {
            return Ok(());
        }

        let room = inner
            .room
            .as_ref()
            .ok_or_else(|| "room is not connected".to_string())?
            .clone();

        inner.camera_publisher.stop(&room).await?;
        inner
            .camera_publisher
            .set_device_id(inner.camera_device_id.clone());
        inner.camera_publisher.start(room.clone()).await?;
        emit_participants_snapshot(&room);
        Ok(())
    }

    async fn restart_mic_locked(&self, inner: &mut LiveKitRoomInner) -> Result<(), String> {
        inner.mic_publisher.set_processing(inner.mic_processing);

        if !inner.mic_enabled {
            return Ok(());
        }

        let room = inner
            .room
            .as_ref()
            .ok_or_else(|| "room is not connected".to_string())?
            .clone();

        inner.mic_publisher.stop(&room).await?;
        inner
            .mic_publisher
            .set_device_id(inner.mic_device_id.clone());
        inner
            .mic_publisher
            .start(room.clone(), inner.mic_processing)
            .await?;
        emit_participants_snapshot(&room);
        Ok(())
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
