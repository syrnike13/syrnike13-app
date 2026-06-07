use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use tokio::sync::mpsc;
use wasapi::{initialize_mta, AudioClient, Direction, StreamMode, WaveFormat};

use crate::capture::target::{process_id_for_hwnd, CaptureTarget};

const SAMPLE_RATE: u32 = 48_000;
const NUM_CHANNELS: u32 = 2;
const CHUNK_FRAMES: usize = 960;

pub struct AudioLoopbackCapture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

pub enum AudioLoopbackTarget {
    Process { process_id: u32 },
    SystemExclude { exclude_process_id: u32 },
}

impl AudioLoopbackCapture {
    pub fn start(
        target: AudioLoopbackTarget,
        tx: mpsc::Sender<Vec<i16>>,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stop);

        let thread = thread::Builder::new()
            .name("screen-audio-loopback".into())
            .spawn(move || {
                if let Err(error) = run_audio_loopback(target, stop_flag, tx) {
                    log::warn!("screen audio loopback stopped: {error}");
                }
            })
            .map_err(|error| error.to_string())?;

        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn resolve_audio_loopback_target(
    target: &CaptureTarget,
    with_audio: bool,
    exclude_process_id: u32,
    self_window_hwnd: Option<isize>,
) -> Option<AudioLoopbackTarget> {
    if !with_audio {
        return None;
    }

    if target
        .hwnd
        .is_some_and(|hwnd| self_window_hwnd.is_some_and(|self_hwnd| hwnd == self_hwnd))
    {
        return None;
    }

    if let Some(hwnd) = target.hwnd {
        let process_id = process_id_for_hwnd(hwnd)?;
        return Some(AudioLoopbackTarget::Process { process_id });
    }

    if exclude_process_id == 0 {
        return None;
    }

    Some(AudioLoopbackTarget::SystemExclude {
        exclude_process_id,
    })
}

pub fn audio_mode_label(target: &AudioLoopbackTarget) -> &'static str {
    match target {
        AudioLoopbackTarget::Process { .. } => "process",
        AudioLoopbackTarget::SystemExclude { .. } => "system_exclude",
    }
}

fn run_audio_loopback(
    target: AudioLoopbackTarget,
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<Vec<i16>>,
) -> Result<(), String> {
    if initialize_mta().is_err() {
        return Err("failed to initialize COM MTA".to_string());
    }

    let (process_id, include_tree) = match target {
        AudioLoopbackTarget::Process { process_id } => (process_id, true),
        AudioLoopbackTarget::SystemExclude {
            exclude_process_id,
        } => (exclude_process_id, false),
    };

    let wave_format = WaveFormat::new(
        32,
        32,
        &wasapi::SampleType::Float,
        SAMPLE_RATE as usize,
        NUM_CHANNELS as usize,
        None,
    );
    let blockalign = wave_format.get_blockalign() as usize;
    let chunk_bytes = blockalign * CHUNK_FRAMES;

    let mut audio_client =
        AudioClient::new_application_loopback_client(process_id, include_tree)
            .map_err(|error| error.to_string())?;

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

    let mut sample_queue: VecDeque<u8> = VecDeque::new();
    audio_client.start_stream().map_err(|error| error.to_string())?;

    while !stop.load(Ordering::SeqCst) {
        while sample_queue.len() >= chunk_bytes {
            let chunk: Vec<u8> = sample_queue.drain(..chunk_bytes).collect();
            let samples = float_bytes_to_i16_stereo(&chunk);
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

fn float_bytes_to_i16_stereo(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(4)
        .map(|chunk| {
            let bits = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let sample = f32::from_bits(bits).clamp(-1.0, 1.0);
            (sample * i16::MAX as f32) as i16
        })
        .collect()
}
