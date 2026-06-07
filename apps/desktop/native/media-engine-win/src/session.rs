use serde_json::Value;

use crate::livekit_room::LiveKitRoom;
use crate::protocol::{
    EventMessage, PingResult, RequestMessage, ResponseMessage, RoomConnectParams,
    ScreenStartParams, ENGINE_NAME, ENGINE_VERSION,
};

pub struct EngineSession {
    livekit_room: LiveKitRoom,
    shutting_down: bool,
}

impl EngineSession {
    pub fn new() -> Self {
        Self {
            livekit_room: LiveKitRoom::new(),
            shutting_down: false,
        }
    }

    pub async fn handle_line(&mut self, line: String) -> Option<String> {
        let request: RequestMessage = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                return Some(serialize(&ResponseMessage::failure(
                    0,
                    "INVALID_REQUEST",
                    format!("failed to parse request: {error}"),
                )));
            }
        };

        let response = self.handle_request(request).await;
        Some(serialize(&response))
    }

    pub fn ready_event(&self, pipe_name: &str) -> String {
        serialize(&EventMessage::new(
            "engine.ready",
            serde_json::json!({
                "version": ENGINE_VERSION,
                "engine": ENGINE_NAME,
                "pipe": pipe_name,
            }),
        ))
    }

    pub fn should_shutdown(&self) -> bool {
        self.shutting_down
    }

    async fn handle_request(&mut self, request: RequestMessage) -> ResponseMessage {
        match request.method.as_str() {
            "engine.ping" => ResponseMessage::success(
                request.id,
                PingResult {
                    version: ENGINE_VERSION.into(),
                    engine: ENGINE_NAME.into(),
                    livekit: true,
                },
            ),
            "engine.shutdown" => {
                self.shutting_down = true;
                let _ = self.livekit_room.disconnect().await;
                ResponseMessage::success(request.id, Value::Null)
            }
            "room.connect" => match serde_json::from_value::<RoomConnectParams>(request.params) {
                Ok(params) => match self.livekit_room.connect(params.url, params.token).await {
                    Ok(result) => ResponseMessage::success(request.id, result),
                    Err(message) => {
                        ResponseMessage::failure(request.id, "ROOM_CONNECT_FAILED", message)
                    }
                },
                Err(error) => ResponseMessage::failure(
                    request.id,
                    "INVALID_PARAMS",
                    format!("room.connect params invalid: {error}"),
                ),
            },
            "room.disconnect" => match self.livekit_room.disconnect().await {
                Ok(()) => ResponseMessage::success(request.id, Value::Null),
                Err(message) => {
                    ResponseMessage::failure(request.id, "ROOM_DISCONNECT_FAILED", message)
                }
            },
            "room.publishTestTone" => match self.livekit_room.publish_test_tone().await {
                Ok(()) => ResponseMessage::success(request.id, Value::Null),
                Err(message) => {
                    ResponseMessage::failure(request.id, "ROOM_PUBLISH_TEST_TONE_FAILED", message)
                }
            },
            "screen.start" => match serde_json::from_value::<ScreenStartParams>(request.params) {
                Ok(params) => match self.livekit_room.start_screen(params).await {
                    Ok(result) => ResponseMessage::success(request.id, result),
                    Err(message) => {
                        ResponseMessage::failure(request.id, "SCREEN_START_FAILED", message)
                    }
                },
                Err(error) => ResponseMessage::failure(
                    request.id,
                    "INVALID_PARAMS",
                    format!("screen.start params invalid: {error}"),
                ),
            },
            "screen.stop" => match self.livekit_room.stop_screen().await {
                Ok(()) => ResponseMessage::success(request.id, Value::Null),
                Err(message) => ResponseMessage::failure(request.id, "SCREEN_STOP_FAILED", message),
            },
            other => ResponseMessage::failure(
                request.id,
                "UNKNOWN_METHOD",
                format!("unsupported method: {other}"),
            ),
        }
    }
}

fn serialize<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}
