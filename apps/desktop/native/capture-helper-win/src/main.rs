mod audio_loopback;
mod encoder;
mod frame_buffer;
mod hybrid;
mod mf_encoder;
mod monitor;
mod openh264_encoder;
mod protocol;
mod stream;
mod target;
mod wgc;

use std::io::{BufRead, BufReader};
use std::sync::Mutex;

use protocol::{emit, emit_error, Event};
use stream::CaptureSession;
use target::{parse_target, StartCommand};

static SESSION: Mutex<Option<CaptureSession>> = Mutex::new(None);

fn main() {
    let stdin = BufReader::new(std::io::stdin());
    for line in stdin.lines() {
        let line = match line {
            Ok(value) => value,
            Err(error) => {
                emit_error("stdin", error.to_string());
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        if let Err(error) = handle_command(&line) {
            emit_error("command", error);
        }
    }

    stop_session();
}

fn parse_stream_mode(value: Option<&str>) -> protocol::StreamMode {
    match value {
        Some("bgra") | Some("raw") => protocol::StreamMode::Bgra,
        _ => protocol::StreamMode::H264,
    }
}

fn handle_command(line: &str) -> Result<(), String> {
    let command: StartCommand =
        serde_json::from_str(line).map_err(|error| error.to_string())?;

    match command.cmd.as_str() {
        "stop" => {
            stop_session();
            Ok(())
        }
        "start" => {
            stop_session();

            let target_payload = command
                .target
                .ok_or_else(|| "missing target".to_string())?;
            let capture_target = parse_target(&target_payload.id)
                .ok_or_else(|| format!("invalid source id {}", target_payload.id))?;

            let width = command.width.unwrap_or(1920);
            let height = command.height.unwrap_or(1080);
            let fps = command.fps.unwrap_or(30);
            let bitrate = command.bitrate.unwrap_or(4_000_000);
            let stream_mode = parse_stream_mode(command.stream_mode.as_deref());

            let with_audio = command.audio.unwrap_or(false);
            let (port, session, config) = stream::start_capture_session(
                capture_target,
                width,
                height,
                fps,
                bitrate,
                stream_mode,
                with_audio,
            )?;

            emit(&Event::Ready {
                port,
                stream_mode: config.stream_mode.as_str(),
                encoder: config.encoder_backend.as_str(),
                frame_buffer_path: config.frame_buffer_path.clone(),
                audio_port: config.audio_port,
                audio_mode: config.audio_mode,
            });

            let mut guard = SESSION
                .lock()
                .map_err(|_| "session lock poisoned".to_string())?;
            *guard = Some(session);
            Ok(())
        }
        other => Err(format!("unknown command {other}")),
    }
}

fn stop_session() {
    if let Ok(mut guard) = SESSION.lock() {
        if let Some(session) = guard.take() {
            session.stop();
        }
    }
}
