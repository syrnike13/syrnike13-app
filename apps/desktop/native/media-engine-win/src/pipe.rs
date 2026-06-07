use std::io;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[cfg(windows)]
use tokio::net::windows::named_pipe::ServerOptions;

#[cfg(not(windows))]
compile_error!("syrnike-media-engine-win only supports Windows");

pub async fn serve_named_pipe<F, Fut>(pipe_name: &str, mut on_line: F) -> io::Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    let pipe_path = normalize_pipe_name(pipe_name);
    log::info!("waiting for control client on {pipe_path}");

    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_path)?;

    server.connect().await?;
    log::info!("control client connected");

    let (reader, mut writer) = server.into_split();
    let mut lines = BufReader::new(reader).lines();

    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(response) = on_line(trimmed.to_string()).await {
            writer.write_all(response.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }
    }

    Ok(())
}

fn normalize_pipe_name(pipe_name: &str) -> String {
    if pipe_name.starts_with(r"\\.\pipe\") {
        pipe_name.to_string()
    } else {
        format!(r"\\.\pipe\{pipe_name}")
    }
}
