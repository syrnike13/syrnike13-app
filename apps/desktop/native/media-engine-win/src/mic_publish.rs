use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::AudioSourceOptions;
use tokio::sync::mpsc;
use tokio::task::JoinHandle as TokioJoinHandle;
use wasapi::{initialize_mta, AudioClient, DeviceEnumerator, Direction, StreamMode, WaveFormat};

const SAMPLE_RATE: u32 = 48_000;
const NUM_CHANNELS: u32 = 1;
const CHUNK_FRAMES: usize = 480;

pub struct MicPublisher {
    stop: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
    publish_task: Option<TokioJoinHandle<()>>,
    audio_source: Option<NativeAudioSource>,
    track_sid: Option<String>,
}

impl MicPublisher {
    pub fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            publish_task: None,
            audio_source: None,
            track_sid: None,
        }
    }

    pub async fn start(&mut self, room: Arc<Room>) -> Result<(), String> {
        self.stop().await?;

        let audio_source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, NUM_CHANNELS, 0);
        let track = LocalAudioTrack::create_audio_track(
            "microphone",
            RtcAudioSource::Native(audio_source.clone()),
        );

        let publication = room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| error.to_string())?;

        let (pcm_tx, mut pcm_rx) = mpsc::channel::<Vec<i16>>(8);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stop);

        let capture_thread = thread::Builder::new()
            .name("mic-capture".into())
            .spawn(move || {
                if let Err(error) = run_mic_capture(stop_flag, pcm_tx) {
                    log::warn!("mic capture stopped: {error}");
                }
            })
            .map_err(|error| error.to_string())?;

        let publish_task = tokio::spawn(async move {
            while let Some(samples) = pcm_rx.recv().await {
                if samples.is_empty() {
                    continue;
                }

                let samples_per_channel = samples.len() as u32;
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
        });

        self.stop = stop;
        self.capture_thread = Some(capture_thread);
        self.publish_task = Some(publish_task);
        self.audio_source = Some(audio_source);
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

        self.audio_source = None;
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.capture_thread.is_some()
    }
}

fn run_mic_capture(
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<Vec<i16>>,
) -> Result<(), String> {
    if initialize_mta().is_err() {
        return Err("failed to initialize COM MTA".to_string());
    }

    let device = DeviceEnumerator::new()
        .map_err(|error| error.to_string())?
        .get_default_device(&Direction::Capture)
        .map_err(|error| error.to_string())?;

    let wave_format = WaveFormat::new(
        16,
        16,
        &wasapi::SampleType::Int,
        SAMPLE_RATE as usize,
        NUM_CHANNELS as usize,
        None,
    );
    let blockalign = wave_format.get_blockalign() as usize;
    let chunk_bytes = blockalign * CHUNK_FRAMES;

    let mut audio_client = AudioClient::new(&device).map_err(|error| error.to_string())?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 200_000,
    };

    audio_client
        .initialize_client(&wave_format, &Direction::Capture, &mode)
        .map_err(|error| error.to_string())?;

    let event = audio_client
        .set_get_eventhandle()
        .map_err(|error| error.to_string())?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|error| error.to_string())?;

    let mut sample_queue = std::collections::VecDeque::<u8>::new();
    audio_client.start_stream().map_err(|error| error.to_string())?;

    while !stop.load(Ordering::SeqCst) {
        while sample_queue.len() >= chunk_bytes {
            let chunk: Vec<u8> = sample_queue.drain(..chunk_bytes).collect();
            let samples = i16_bytes_to_samples(&chunk);
            if tx.blocking_send(samples).is_err() {
                let _ = audio_client.stop_stream();
                return Ok(());
            }
        }

        let new_frames = capture_client
            .get_next_packet_size()
            .map_err(|error| error.to_string())?
            .unwrap_or(0);

        if new_frames > 0 {
            let additional = (new_frames as usize * blockalign)
                .saturating_sub(sample_queue.capacity() - sample_queue.len());
            sample_queue.reserve(additional);
            capture_client
                .read_from_device_to_deque(&mut sample_queue)
                .map_err(|error| error.to_string())?;
        }

        if event.wait_for_event(50).is_err() && stop.load(Ordering::SeqCst) {
            break;
        }
    }

    let _ = audio_client.stop_stream();
    Ok(())
}

fn i16_bytes_to_samples(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect()
}
