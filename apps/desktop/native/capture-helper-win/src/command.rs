use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct StartCommand {
    pub cmd: String,

    pub kind: Option<String>,

    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,

    #[serde(rename = "sessionKind")]
    pub session_kind: Option<String>,

    pub target: Option<TargetPayload>,

    pub width: Option<u32>,

    pub height: Option<u32>,

    pub fps: Option<u32>,

    pub bitrate: Option<u32>,

    #[serde(rename = "streamMode")]
    pub stream_mode: Option<String>,
    pub audio: Option<bool>,
    #[serde(rename = "excludeProcessId")]
    pub exclude_process_id: Option<u32>,
    #[serde(rename = "selfWindowHwnd")]
    pub self_window_hwnd: Option<isize>,
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
    #[serde(rename = "sampleRate")]
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    #[serde(rename = "echoCancellation")]
    pub echo_cancellation: Option<bool>,
    #[serde(rename = "noiseSuppression")]
    pub noise_suppression: Option<String>,
    #[serde(rename = "inputVolume")]
    pub input_volume: Option<f32>,
}

#[derive(Debug, Deserialize)]
pub struct TargetPayload {
    pub id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exclude_process_id_from_start_command() {
        let command: StartCommand = serde_json::from_str(
            r#"{"cmd":"start","sessionId":"session-1","sessionKind":"screen","target":{"id":"screen:0:0"},"excludeProcessId":4242,"selfWindowHwnd":99}"#,
        )
        .expect("start command");

        assert_eq!(command.session_id.as_deref(), Some("session-1"));
        assert_eq!(command.session_kind.as_deref(), Some("screen"));
        assert_eq!(command.exclude_process_id, Some(4242));
        assert_eq!(command.self_window_hwnd, Some(99));
    }

    #[test]
    fn parses_audio_input_device_list_command() {
        let command: StartCommand =
            serde_json::from_str(r#"{"cmd":"list_devices","kind":"audioinput"}"#)
                .expect("list devices command");

        assert_eq!(command.cmd, "list_devices");
        assert_eq!(command.kind.as_deref(), Some("audioinput"));
    }
}
