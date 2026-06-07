use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ENGINE_NAME: &str = "syrnike-media-engine";

#[derive(Debug, Deserialize)]
pub struct RequestMessage {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct ResponseMessage {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct EventMessage {
    pub event: String,
    pub params: Value,
}

#[derive(Debug, Deserialize)]
pub struct RoomConnectParams {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub version: String,
    pub engine: String,
    pub livekit: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomConnectResult {
    pub room_name: String,
    pub sid: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenStartParams {
    pub source_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    #[serde(default)]
    pub max_bitrate: Option<u32>,
    #[serde(default = "default_with_audio")]
    pub with_audio: bool,
    #[serde(default)]
    pub exclude_process_id: Option<u32>,
    #[serde(default)]
    pub self_window_hwnd: Option<isize>,
}

fn default_with_audio() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicSetEnabledParams {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSetEnabledParams {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenStartResult {
    pub active_method: String,
    pub audio_mode: Option<String>,
}

impl ResponseMessage {
    pub fn success(id: u64, result: impl Serialize) -> Self {
        Self {
            id,
            ok: true,
            result: Some(serde_json::to_value(result).unwrap_or(Value::Null)),
            error: None,
        }
    }

    pub fn failure(id: u64, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

impl EventMessage {
    pub fn new(event: impl Into<String>, params: impl Serialize) -> Self {
        Self {
            event: event.into(),
            params: serde_json::to_value(params).unwrap_or(Value::Null),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_message() {
        let request: RequestMessage = serde_json::from_str(
            r#"{"id":1,"method":"engine.ping","params":{}}"#,
        )
        .expect("request should parse");

        assert_eq!(request.id, 1);
        assert_eq!(request.method, "engine.ping");
    }

    #[test]
    fn serializes_success_response() {
        let response = ResponseMessage::success(
            7,
            PingResult {
                version: "0.1.0".into(),
                engine: ENGINE_NAME.into(),
                livekit: true,
            },
        );

        let json = serde_json::to_string(&response).expect("response should serialize");
        assert!(json.contains("\"ok\":true"));
        assert!(json.contains("\"livekit\":true"));
    }
}
