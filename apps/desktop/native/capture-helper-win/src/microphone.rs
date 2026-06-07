use std::collections::VecDeque;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use wasapi::{
    get_default_device, initialize_mta, Device, DeviceCollection, Direction, StreamMode, WaveFormat,
};
use windows::Win32::Media::Audio::AudioCategory_Communications;

use crate::deep_filter_net3::MicrophoneDenoise;
use crate::protocol::NativeMediaDeviceInfo;
use crate::session::AudioCaptureSession;

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 1;

pub fn start_microphone_capture(
    device_id: Option<String>,
    echo_cancellation: bool,
    input_volume: f32,
    noise_suppression: &str,
) -> Result<(u16, AudioCaptureSession), String> {
    let denoise = MicrophoneDenoise::new(noise_suppression)?;
    let noise_suppression_mode = denoise.mode_name();
    if denoise.sample_rate() != SAMPLE_RATE {
        return Err(format!(
            "unsupported DeepFilterNet3 sample rate: {}",
            denoise.sample_rate()
        ));
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let (startup_tx, startup_rx) = sync_channel(1);

    let thread = thread::Builder::new()
        .name("microphone-capture".into())
        .spawn(move || {
            let startup_error_tx = startup_tx.clone();
            if let Err(error) = run_microphone_loop(
                listener,
                device_id,
                echo_cancellation,
                input_volume,
                denoise,
                stop_flag,
                startup_tx,
            ) {
                let _ = startup_error_tx.send(Err(error.clone()));
                eprintln!("[microphone] {error}");
            }
        })
        .map_err(|error| error.to_string())?;

    match startup_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            stop.store(true, Ordering::SeqCst);
            let _ = thread.join();
            return Err(error);
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            return Err("microphone capture startup timeout".to_string());
        }
    }

    Ok((
        port,
        AudioCaptureSession {
            stop,
            thread: Some(thread),
            noise_suppression_mode,
        },
    ))
}

fn run_microphone_loop(
    listener: TcpListener,
    device_id: Option<String>,
    echo_cancellation: bool,
    input_volume: f32,
    mut denoise: MicrophoneDenoise,
    stop: Arc<AtomicBool>,
    startup_tx: SyncSender<Result<(), String>>,
) -> Result<(), String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    if initialize_mta().is_err() {
        return Err("failed to initialize COM MTA".to_string());
    }

    let device = capture_device_by_id(device_id.as_deref())?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| error.to_string())?;
    let chunk_frames = denoise.hop_size();

    let wave_format = WaveFormat::new(
        32,
        32,
        &wasapi::SampleType::Float,
        SAMPLE_RATE,
        CHANNELS,
        None,
    );
    let blockalign = wave_format.get_blockalign() as usize;
    let chunk_bytes = blockalign * chunk_frames;
    let (_default_time, min_time) = audio_client
        .get_device_period()
        .map_err(|error| error.to_string())?;
    configure_microphone_stream_category(&audio_client, echo_cancellation)?;

    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };
    audio_client
        .initialize_client(&wave_format, &Direction::Capture, &mode)
        .map_err(|error| error.to_string())?;
    enable_echo_cancellation(&audio_client, echo_cancellation)?;

    let event = audio_client
        .set_get_eventhandle()
        .map_err(|error| error.to_string())?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|error| error.to_string())?;
    let _ = startup_tx.send(Ok(()));

    let mut client: Option<TcpStream> = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);

    while client.is_none() && std::time::Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        if let Ok((stream, _addr)) = listener.accept() {
            client = Some(stream);
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    let mut stream = client.ok_or_else(|| "microphone stream client timeout".to_string())?;
    stream
        .set_nodelay(true)
        .map_err(|error| error.to_string())?;

    let mut sample_queue: VecDeque<u8> = VecDeque::new();
    audio_client
        .start_stream()
        .map_err(|error| error.to_string())?;

    while !stop.load(Ordering::SeqCst) {
        while sample_queue.len() >= chunk_bytes {
            let mut chunk: Vec<u8> = sample_queue.drain(..chunk_bytes).collect();
            denoise.process_f32le_mono(&mut chunk)?;
            apply_input_volume(&mut chunk, input_volume);
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

fn configure_microphone_stream_category(
    audio_client: &wasapi::AudioClient,
    echo_cancellation: bool,
) -> Result<(), String> {
    if !echo_cancellation {
        return Ok(());
    }

    audio_client
        .set_audio_stream_category(AudioCategory_Communications)
        .map_err(|error| format!("failed to enable microphone communications category: {error}"))?;
    Ok(())
}

fn enable_echo_cancellation(
    audio_client: &wasapi::AudioClient,
    echo_cancellation: bool,
) -> Result<(), String> {
    if !echo_cancellation {
        return Ok(());
    }

    if !audio_client
        .is_aec_supported()
        .map_err(|error| format!("failed to check microphone echo cancellation support: {error}"))?
    {
        return Err("microphone echo cancellation is not supported by this device".to_string());
    }

    let render_endpoint_id = get_default_device(&Direction::Render)
        .and_then(|device| device.get_id())
        .map_err(|error| format!("failed to resolve echo cancellation render endpoint: {error}"))?;

    audio_client
        .get_aec_control()
        .and_then(|control| control.set_echo_cancellation_render_endpoint(Some(render_endpoint_id)))
        .map_err(|error| format!("failed to enable microphone echo cancellation: {error}"))?;

    Ok(())
}

pub fn list_microphone_devices() -> Result<Vec<NativeMediaDeviceInfo>, String> {
    if initialize_mta().is_err() {
        return Err("failed to initialize COM MTA".to_string());
    }

    let collection =
        DeviceCollection::new(&Direction::Capture).map_err(|error| error.to_string())?;
    let mut devices = Vec::new();
    for device in &collection {
        let device = device.map_err(|error| error.to_string())?;
        devices.push(NativeMediaDeviceInfo {
            device_id: device.get_id().map_err(|error| error.to_string())?,
            kind: "audioinput",
            label: device
                .get_friendlyname()
                .or_else(|_| device.get_description())
                .unwrap_or_else(|_| "Microphone".to_string()),
        });
    }
    Ok(devices)
}

fn capture_device_by_id(device_id: Option<&str>) -> Result<Device, String> {
    let requested = device_id
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default" && !value.starts_with("default:"));

    let Some(requested) = requested else {
        return get_default_device(&Direction::Capture).map_err(|error| error.to_string());
    };

    let collection =
        DeviceCollection::new(&Direction::Capture).map_err(|error| error.to_string())?;
    for device in &collection {
        let device = device.map_err(|error| error.to_string())?;
        let id = device.get_id().map_err(|error| error.to_string())?;
        if id == requested {
            return Ok(device);
        }
    }

    Err(format!("microphone device not found: {requested}"))
}

fn apply_input_volume(chunk: &mut [u8], input_volume: f32) {
    if (input_volume - 1.0).abs() < f32::EPSILON {
        return;
    }

    for sample in chunk.chunks_exact_mut(4) {
        let value = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
        let scaled = (value * input_volume).clamp(-1.0, 1.0).to_le_bytes();
        sample.copy_from_slice(&scaled);
    }
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
