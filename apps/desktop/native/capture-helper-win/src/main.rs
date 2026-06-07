#[cfg(feature = "screen")]
mod audio_loopback;
mod command;
#[cfg(feature = "screen")]
mod encoder;
#[cfg(feature = "screen")]
mod frame_buffer;
#[cfg(feature = "screen")]
mod hybrid;
#[cfg(feature = "screen")]
mod mf_encoder;
#[cfg(feature = "microphone")]
mod microphone;
#[cfg(feature = "screen")]
mod monitor;
#[cfg(feature = "screen")]
mod openh264_encoder;
mod protocol;
mod session;
#[cfg(feature = "screen")]
mod stream;
#[cfg(feature = "screen")]
mod target;
#[cfg(feature = "screen")]
mod wgc;

use std::io::{BufRead, BufReader};
use std::sync::Mutex;

use command::StartCommand;
use protocol::{emit, emit_error, Event};
use session::{audio_only_session, CaptureSession};
#[cfg(feature = "screen")]
use target::parse_target;

static SESSION: Mutex<Option<CaptureSession>> = Mutex::new(None);

fn agent_debug_log(hypothesis_id: &str, location: &str, message: &str, data_json: &str) {
    let Ok(path) = std::env::var("SYRNIKE_DEBUG_LOG") else {
        return;
    };
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let _ = writeln!(
            file,
            r#"{{"sessionId":"d604d7","hypothesisId":"{hypothesis_id}","location":"{location}","message":"{message}","data":{data_json},"timestamp":{timestamp}}}"#
        );
    }
}

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
    let command: StartCommand = serde_json::from_str(line).map_err(|error| error.to_string())?;

    match command.cmd.as_str() {
        "stop" => {
            stop_session();
            Ok(())
        }
        "list_devices" => {
            let kind = command.kind.as_deref().unwrap_or("audioinput");
            if kind != "audioinput" {
                return Err(format!("unsupported device kind {kind}"));
            }
            #[cfg(not(feature = "microphone"))]
            {
                return Err("microphone capture is not compiled into this helper".to_string());
            }
            #[cfg(feature = "microphone")]
            {
                emit(&Event::DeviceList {
                    devices: microphone::list_microphone_devices()?,
                });
                Ok(())
            }
        }
        "start" => {
            stop_session();
            let session_id = command
                .session_id
                .clone()
                .ok_or_else(|| "missing sessionId".to_string())?;
            let session_kind = match command.session_kind.as_deref() {
                Some("screen") => "screen",
                Some("microphone") => "microphone",
                Some(other) => return Err(format!("unsupported session kind {other}")),
                None => return Err("missing sessionKind".to_string()),
            };

            // #region agent log
            agent_debug_log(
                "D",
                "main.rs:handle_command",
                "handling start command",
                &format!(
                    r#"{{"sessionId":"{}","kind":"{}","deviceId":"{}"}}"#,
                    session_id,
                    session_kind,
                    command.device_id.as_deref().unwrap_or("default")
                ),
            );
            // #endregion

            emit(&Event::SessionLifecycle {
                session_id: session_id.clone(),
                kind: session_kind,
                status: "starting",
                port: None,
                audio_port: None,
                audio_mode: None,
                audio_sample_rate: None,
                audio_channels: None,
                message: None,
            });

            if session_kind == "microphone" {
                #[cfg(not(feature = "microphone"))]
                {
                    return Err("microphone capture is not compiled into this helper".to_string());
                }
                #[cfg(feature = "microphone")]
                {
                    let (audio_port, audio_session) = microphone::start_microphone_capture(
                        command.device_id.clone(),
                        command.echo_cancellation.unwrap_or(false),
                        command.input_volume.unwrap_or(1.0),
                    )?;

                    // #region agent log
                    agent_debug_log(
                        "D",
                        "main.rs:handle_command",
                        "emitting microphone ready",
                        &format!(r#"{{"sessionId":"{}","audioPort":{}}}"#, session_id, audio_port),
                    );
                    // #endregion

                    emit(&Event::Ready {
                        port: 0,
                        stream_mode: "audio",
                        encoder: "pcm",
                        frame_buffer_path: None,
                        audio_port: Some(audio_port),
                        audio_mode: Some("microphone"),
                        audio_sample_rate: Some(command.sample_rate.unwrap_or(48_000)),
                        audio_channels: Some(command.channels.unwrap_or(1)),
                    });
                    emit(&Event::SessionLifecycle {
                        session_id: session_id.clone(),
                        kind: session_kind,
                        status: "running",
                        port: None,
                        audio_port: Some(audio_port),
                        audio_mode: Some("microphone"),
                        audio_sample_rate: Some(command.sample_rate.unwrap_or(48_000)),
                        audio_channels: Some(command.channels.unwrap_or(1)),
                        message: None,
                    });

                    let mut guard = SESSION
                        .lock()
                        .map_err(|_| "session lock poisoned".to_string())?;
                    *guard = Some(audio_only_session(session_id, session_kind, audio_session));
                    return Ok(());
                }
            }

            #[cfg(not(feature = "screen"))]
            {
                return Err("screen capture is not compiled into this helper".to_string());
            }
            #[cfg(feature = "screen")]
            {
                let target_payload = command.target.ok_or_else(|| "missing target".to_string())?;
                let capture_target = parse_target(&target_payload.id)
                    .ok_or_else(|| format!("invalid source id {}", target_payload.id))?;

                let width = command.width.unwrap_or(1920);
                let height = command.height.unwrap_or(1080);
                let fps = command.fps.unwrap_or(30);
                let bitrate = command.bitrate.unwrap_or(4_000_000);
                let stream_mode = parse_stream_mode(command.stream_mode.as_deref());

                let with_audio = command.audio.unwrap_or(false);
                let (port, session, config) = match stream::start_capture_session(
                    session_id.clone(),
                    session_kind,
                    capture_target,
                    width,
                    height,
                    fps,
                    bitrate,
                    stream_mode,
                    with_audio,
                    command.exclude_process_id,
                    command.self_window_hwnd,
                ) {
                    Ok(value) => value,
                    Err(error) => {
                        emit(&Event::SessionLifecycle {
                            session_id,
                            kind: session_kind,
                            status: "error",
                            port: None,
                            audio_port: None,
                            audio_mode: None,
                            audio_sample_rate: None,
                            audio_channels: None,
                            message: Some(error.clone()),
                        });
                        return Err(error);
                    }
                };

                emit(&Event::Ready {
                    port,
                    stream_mode: config.stream_mode.as_str(),
                    encoder: config.encoder_backend.as_str(),
                    frame_buffer_path: config.frame_buffer_path.clone(),
                    audio_port: config.audio_port,
                    audio_mode: config.audio_mode,
                    audio_sample_rate: None,
                    audio_channels: None,
                });
                emit(&Event::SessionLifecycle {
                    session_id,
                    kind: session_kind,
                    status: "running",
                    port: Some(port),
                    audio_port: config.audio_port,
                    audio_mode: config.audio_mode,
                    audio_sample_rate: None,
                    audio_channels: None,
                    message: None,
                });

                let mut guard = SESSION
                    .lock()
                    .map_err(|_| "session lock poisoned".to_string())?;
                *guard = Some(session);
                Ok(())
            }
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
