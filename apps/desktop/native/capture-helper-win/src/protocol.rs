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
}

