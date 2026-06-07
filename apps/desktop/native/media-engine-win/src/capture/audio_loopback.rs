use std::collections::VecDeque;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use wasapi::{initialize_mta, AudioClient, Direction, StreamMode, WaveFormat};

use crate::capture::target::process_id_for_hwnd;

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;
const CHUNK_FRAMES: usize = 960;

pub struct AudioCaptureSession {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl AudioCaptureSession {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn try_start_process_audio(hwnd: isize) -> Result<(u16, AudioCaptureSession), String> {
    let process_id =
        process_id_for_hwnd(hwnd).ok_or_else(|| "window has no process id".to_string())?;
    spawn_audio_capture(process_id, true)
}

pub fn try_start_system_audio_exclude(
    exclude_process_id: u32,
) -> Result<(u16, AudioCaptureSession), String> {
    if exclude_process_id == 0 {
        return Err("exclude process id is required".to_string());
    }
    spawn_audio_capture(exclude_process_id, false)
}

fn spawn_audio_capture(
    process_id: u32,
    include_tree: bool,
) -> Result<(u16, AudioCaptureSession), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);

    let thread = thread::Builder::new()
        .name(if include_tree {
            "process-audio-capture".into()
        } else {
            "system-audio-exclude-capture".into()
        })
        .spawn(move || {
            if let Err(error) = run_audio_loopback_loop(listener, process_id, include_tree, stop_flag)
            {
                eprintln!("[audio-loopback] {error}");
            }
        })
        .map_err(|error| error.to_string())?;

    Ok((
        port,
        AudioCaptureSession {
            stop,
            thread: Some(thread),
        },
    ))
}

fn run_audio_loopback_loop(
    listener: TcpListener,
    process_id: u32,
    include_tree: bool,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let mut client: Option<TcpStream> = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);

    while client.is_none() && std::time::Instant::now() < deadline && !stop.load(Ordering::SeqCst)
    {
        if let Ok((stream, _addr)) = listener.accept() {
            client = Some(stream);
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    let mut stream = client.ok_or_else(|| "audio stream client timeout".to_string())?;
    stream
        .set_nodelay(true)
        .map_err(|error| error.to_string())?;

    if initialize_mta().is_err() {
        return Err("failed to initialize COM MTA".to_string());
    }

    let wave_format = WaveFormat::new(32, 32, &wasapi::SampleType::Float, SAMPLE_RATE, CHANNELS, None);
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
            write_packet(&mut stream, &chunk)?;
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

fn write_packet(stream: &mut TcpStream, payload: &[u8]) -> Result<(), String> {
    let length = payload.len() as u32;
    stream
        .write_all(&length.to_le_bytes())
        .map_err(|error| error.to_string())?;
    stream
        .write_all(payload)
        .map_err(|error| error.to_string())?;
    Ok(())
}
