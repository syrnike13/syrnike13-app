mod camera_publish;
mod capture;
mod devices;
mod event_emitter;
mod local_preview;
mod livekit_room;
mod mic_denoise;
mod mic_gate;
mod mic_processing;
mod mic_publish;
mod pipe;
mod protocol;
mod remote_audio;
mod remote_video;
mod room_stats;
mod screen_publish;
mod session;

use std::env;
use std::io::{self, Write};
use std::sync::Arc;

use session::EngineSession;
use tokio::sync::Mutex;

const DEFAULT_PIPE_PREFIX: &str = "syrnike-media";

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let pipe_name = parse_pipe_name(env::args().skip(1).collect());
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime should start");

    if let Err(error) = rt.block_on(run(pipe_name)) {
        eprintln!("[media-engine] fatal error: {error}");
        std::process::exit(1);
    }
}

async fn run(pipe_name: String) -> io::Result<()> {
    let session = Arc::new(Mutex::new(EngineSession::new()));
    {
        let session = session.lock().await;
        emit_stdout_line(&session.ready_event(&pipe_name))?;
    }

    let observed = session.clone();
    pipe::serve_named_pipe(&pipe_name, move |line| {
        let session = observed.clone();
        async move {
            let mut session = session.lock().await;
            session.handle_line(line).await
        }
    })
    .await?;

    Ok(())
}

fn parse_pipe_name(args: Vec<String>) -> String {
    let mut pipe_name: Option<String> = None;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--pipe" => {
                if let Some(value) = args.get(index + 1) {
                    pipe_name = Some(value.clone());
                    index += 2;
                    continue;
                }
            }
            "--parent-pid" => {
                if let Some(value) = args.get(index + 1) {
                    pipe_name = Some(format!("{DEFAULT_PIPE_PREFIX}-{value}"));
                    index += 2;
                    continue;
                }
            }
            _ => {}
        }
        index += 1;
    }

    pipe_name.unwrap_or_else(|| format!("{DEFAULT_PIPE_PREFIX}-{}", std::process::id()))
}

fn emit_stdout_line(line: &str) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(line.as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}
