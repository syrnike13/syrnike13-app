use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::audio_loopback::{try_start_process_audio, try_start_system_audio_exclude};
use crate::protocol::{emit, Event};
use crate::encoder::{EncoderBackend, VideoEncoder};
use crate::frame_buffer::{pack_bgra_frame, pack_bgra_frame_header, SharedFrameBuffer};
use crate::hybrid::{CaptureMethod, HybridCapturer};
use crate::protocol::StreamMode;
use crate::session::{AudioCaptureSession, CaptureSession};
use crate::target::CaptureTarget;

pub struct CaptureSessionConfig {
    pub encoder_backend: EncoderBackend,
    pub stream_mode: StreamMode,
    pub frame_buffer_path: Option<String>,
    pub audio_port: Option<u16>,
    pub audio_mode: Option<&'static str>,
}

pub fn start_capture_session(
    session_id: String,
    session_kind: &'static str,
    target: CaptureTarget,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    stream_mode: StreamMode,
    with_audio: bool,
    exclude_process_id: Option<u32>,
    self_window_hwnd: Option<isize>,
) -> Result<(u16, CaptureSession, CaptureSessionConfig), String> {
    let encoder_backend = match stream_mode {
        StreamMode::H264 => VideoEncoder::new(width, height, bitrate)?.1,
        StreamMode::Bgra => EncoderBackend::OpenH264,
    };

    let (shared_buffer, frame_buffer_path) = if stream_mode == StreamMode::Bgra {
        let (buffer, path) = SharedFrameBuffer::create(width, height)?;
        (Some(buffer), Some(path))
    } else {
        (None, None)
    };

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);

    let (audio_port, audio_mode, audio_session) =
        start_window_process_audio(&target, with_audio, exclude_process_id, self_window_hwnd)?;

    let thread = thread::spawn(move || {
        if let Err(error) = run_capture_loop(
            listener,
            target,
            width,
            height,
            fps,
            bitrate,
            stream_mode,
            shared_buffer,
            stop_flag,
        ) {
            crate::protocol::emit_error("capture_loop", error);
        }
    });

    Ok((
        port,
        CaptureSession::new(session_id, session_kind, stop, Some(thread), audio_session),
        CaptureSessionConfig {
            encoder_backend,
            stream_mode,
            frame_buffer_path,
            audio_port,
            audio_mode,
        },
    ))
}

fn start_window_process_audio(
    target: &CaptureTarget,
    with_audio: bool,
    exclude_process_id: Option<u32>,
    self_window_hwnd: Option<isize>,
) -> Result<
    (
        Option<u16>,
        Option<&'static str>,
        Option<AudioCaptureSession>,
    ),
    String,
> {
    if !with_audio {
        return Ok((None, None, None));
    }

    if target
        .hwnd
        .is_some_and(|hwnd| self_window_hwnd.is_some_and(|self_hwnd| hwnd == self_hwnd))
    {
        return Ok((None, Some("none"), None));
    }

    if let Some(hwnd) = target.hwnd {
        match try_start_process_audio(hwnd) {
            Ok((port, session)) => return Ok((Some(port), Some("process"), Some(session))),
            Err(error) => eprintln!("[media-engine] process audio unavailable: {error}"),
        }
    }

    match exclude_process_id {
        Some(process_id) => match try_start_system_audio_exclude(process_id) {
            Ok((port, session)) => Ok((Some(port), Some("system_exclude"), Some(session))),
            Err(error) => {
                eprintln!("[media-engine] system audio exclude unavailable: {error}");
                Ok((None, Some("none"), None))
            }
        },
        None => {
            eprintln!(
                "[media-engine] system audio exclude unavailable: missing exclude process id",
            );
            Ok((None, Some("none"), None))
        }
    }
}

fn run_capture_loop(
    listener: TcpListener,
    target: CaptureTarget,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    stream_mode: StreamMode,
    mut shared_buffer: Option<SharedFrameBuffer>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let mut client: Option<TcpStream> = None;
    let deadline = Instant::now() + Duration::from_secs(10);

    while client.is_none() && Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        if let Ok((stream, _addr)) = listener.accept() {
            client = Some(stream);
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    let mut stream = client.ok_or_else(|| "stream client timeout".to_string())?;
    stream
        .set_nodelay(true)
        .map_err(|error| error.to_string())?;

    let mut capturer = HybridCapturer::new(target, width, height)?;
    let mut encoder = if stream_mode == StreamMode::H264 {
        Some(VideoEncoder::new(width, height, bitrate)?.0)
    } else {
        None
    };

    let frame_interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
    let mut method_counts = [0u64; 4];
    let mut last_stats = Instant::now();
    let mut previous_method = capturer.method();

    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();

        if let Some(reason) = capturer.take_downgrade_reason() {
            emit(&Event::Downgrade {
                from: previous_method.as_str(),
                to: capturer.method().as_str(),
                reason,
            });
            previous_method = capturer.method();
        }

        let frame = capturer.capture()?;
        let payload = match stream_mode {
            StreamMode::H264 => {
                let encoder = encoder
                    .as_mut()
                    .ok_or_else(|| "h264 encoder missing".to_string())?;
                let encoded = encoder.encode_bgra(&frame.bgra, frame.stride)?;
                if encoded.is_empty() {
                    continue;
                }
                encoded
            }
            StreamMode::Bgra => {
                if let Some(buffer) = shared_buffer.as_mut() {
                    buffer.write_bgra_frame(
                        frame.width as u32,
                        frame.height as u32,
                        frame.stride as u32,
                        &frame.bgra,
                    )?;
                    pack_bgra_frame_header(
                        frame.width as u32,
                        frame.height as u32,
                        frame.stride as u32,
                    )
                    .to_vec()
                } else {
                    pack_bgra_frame(
                        frame.width as u32,
                        frame.height as u32,
                        frame.stride as u32,
                        &frame.bgra,
                    )
                }
            }
        };

        let method_index = match frame.method {
            CaptureMethod::Wgc => 0,
            CaptureMethod::Dxgi => 1,
            CaptureMethod::GdiBlt => 2,
            CaptureMethod::GdiPrint => 3,
        };
        method_counts[method_index] += 1;

        write_packet(&mut stream, &payload)?;

        if last_stats.elapsed() >= Duration::from_secs(1) {
            emit(&Event::FrameMethod {
                method: frame.method.as_str(),
                count: method_counts[method_index],
                active_method: frame.method.as_str(),
            });
            last_stats = Instant::now();
        }

        let elapsed = started.elapsed();
        if elapsed < frame_interval {
            thread::sleep(frame_interval - elapsed);
        }
    }

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
