use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]

pub enum StreamMode {
    H264,

    Bgra,
}

impl StreamMode {
    pub fn as_str(self) -> &'static str {
        match self {
            StreamMode::H264 => "h264",

            StreamMode::Bgra => "bgra",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]

pub enum Event {
    DeviceList {
        devices: Vec<NativeMediaDeviceInfo>,
    },

    SessionLifecycle {
        session_id: String,
        kind: &'static str,
        status: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_port: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_mode: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_sample_rate: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_channels: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },

    Ready {
        port: u16,
        stream_mode: &'static str,
        encoder: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        frame_buffer_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_port: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_mode: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_sample_rate: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_channels: Option<u16>,
    },

    FrameMethod {
        method: &'static str,

        count: u64,

        active_method: &'static str,
    },

    Downgrade {
        from: &'static str,

        to: &'static str,

        reason: String,
    },

    Error {
        code: &'static str,

        message: String,
    },

    Stopped,
}

#[derive(Debug, Serialize)]
pub struct NativeMediaDeviceInfo {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub kind: &'static str,
    pub label: String,
}

pub fn emit(event: &Event) {
    if let Ok(line) = serde_json::to_string(event) {
        println!("{line}");

        let _ = std::io::Write::flush(&mut std::io::stdout());
    }
}

pub fn emit_error(code: &'static str, message: impl Into<String>) {
    emit(&Event::Error {
        code,
        message: message.into(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_ready_with_frame_buffer() {
        let json = serde_json::to_string(&Event::Ready {
            port: 1234,
            stream_mode: "bgra",
            encoder: "openh264",
            frame_buffer_path: Some("C:\\Temp\\frame.bin".to_string()),
            audio_port: Some(4321),
            audio_mode: Some("process"),
            audio_sample_rate: None,
            audio_channels: None,
        })
        .expect("json");

        assert!(json.contains("\"type\":\"ready\""));
        assert!(json.contains("\"frame_buffer_path\":\"C:\\\\Temp\\\\frame.bin\""));
        assert!(json.contains("\"stream_mode\":\"bgra\""));
    }

    #[test]
    fn serializes_downgrade_event() {
        let json = serde_json::to_string(&Event::Downgrade {
            from: "wgc",
            to: "dxgi",
            reason: "timeout".to_string(),
        })
        .expect("json");

        assert!(json.contains("\"type\":\"downgrade\""));
        assert!(json.contains("\"reason\":\"timeout\""));
    }

    #[test]
    fn serializes_session_lifecycle_event() {
        let json = serde_json::to_string(&Event::SessionLifecycle {
            session_id: "session-1".to_string(),
            kind: "screen",
            status: "running",
            port: Some(1234),
            audio_port: Some(4321),
            audio_mode: Some("system_exclude"),
            audio_sample_rate: Some(48_000),
            audio_channels: Some(1),
            message: None,
        })
        .expect("json");

        assert!(json.contains("\"type\":\"session_lifecycle\""));
        assert!(json.contains("\"session_id\":\"session-1\""));
        assert!(json.contains("\"kind\":\"screen\""));
        assert!(json.contains("\"status\":\"running\""));
        assert!(json.contains("\"port\":1234"));
        assert!(json.contains("\"audio_port\":4321"));
        assert!(json.contains("\"audio_mode\":\"system_exclude\""));
        assert!(json.contains("\"audio_sample_rate\":48000"));
        assert!(json.contains("\"audio_channels\":1"));
    }

    #[test]
    fn serializes_device_list_event() {
        let json = serde_json::to_string(&Event::DeviceList {
            devices: vec![NativeMediaDeviceInfo {
                device_id: "{0.0.1.00000000}.native-mic".to_string(),
                kind: "audioinput",
                label: "Native microphone".to_string(),
            }],
        })
        .expect("json");

        assert!(json.contains("\"type\":\"device_list\""));
        assert!(json.contains("\"deviceId\":\"{0.0.1.00000000}.native-mic\""));
        assert!(json.contains("\"kind\":\"audioinput\""));
        assert!(json.contains("\"label\":\"Native microphone\""));
    }
}
