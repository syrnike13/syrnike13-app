// Copyright 2025 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use super::{colorcvt, FfiHandle};
use crate::{proto, server, FfiError, FfiHandleId, FfiResult};
use livekit::webrtc::{
    prelude::*,
    video_frame::{FrameMetadata, VideoFrame},
};

pub struct FfiVideoSource {
    pub handle_id: FfiHandleId,
    pub source_type: proto::VideoSourceType,
    pub source_mode: proto::VideoSourceMode,
    pub source: RtcVideoSource,
}

impl FfiHandle for FfiVideoSource {}

fn frame_metadata_from_proto(metadata: Option<proto::FrameMetadata>) -> Option<FrameMetadata> {
    let metadata = metadata?;
    let frame_metadata = FrameMetadata {
        user_timestamp: metadata.user_timestamp,
        frame_id: metadata.frame_id,
        user_data: metadata.user_data,
    };

    (frame_metadata.user_timestamp.is_some()
        || frame_metadata.frame_id.is_some()
        || frame_metadata.user_data.is_some())
    .then_some(frame_metadata)
}

impl FfiVideoSource {
    pub fn setup(
        server: &'static server::FfiServer,
        new_source: proto::NewVideoSourceRequest,
    ) -> FfiResult<proto::OwnedVideoSource> {
        let source_type = new_source.r#type();
        let source_mode = new_source.mode();
        #[allow(unreachable_patterns)]
        let source_inner = match source_type {
            #[cfg(not(target_arch = "wasm32"))]
            proto::VideoSourceType::VideoSourceNative => {
                use livekit::webrtc::video_source::native::NativeVideoSource;

                let is_screencast = new_source.is_screencast.unwrap_or(false);
                let resolution = new_source.resolution.into();
                let video_source = match source_mode {
                    proto::VideoSourceMode::Default => {
                        NativeVideoSource::new(resolution, is_screencast)
                    }
                    proto::VideoSourceMode::D3d11Hardware => {
                        #[cfg(target_os = "windows")]
                        {
                            NativeVideoSource::new_d3d11_hardware(resolution, is_screencast)
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            return Err(FfiError::InvalidRequest(
                                "D3D11 hardware video sources are supported only on Windows".into(),
                            ));
                        }
                    }
                };
                RtcVideoSource::Native(video_source)
            }
            _ => return Err(FfiError::InvalidRequest("unsupported video source type".into())),
        };

        let handle_id = server.next_id();
        let video_source = Self { handle_id, source_type, source_mode, source: source_inner };
        let source_info = proto::VideoSourceInfo::from(&video_source);
        server.store_handle(handle_id, video_source);

        Ok(proto::OwnedVideoSource {
            handle: proto::FfiOwnedHandle { id: handle_id },
            info: source_info,
        })
    }

    pub unsafe fn capture_frame(
        &self,
        _server: &'static server::FfiServer,
        capture: proto::CaptureVideoFrameRequest,
    ) -> FfiResult<()> {
        if self.source_mode == proto::VideoSourceMode::D3d11Hardware {
            return Err(FfiError::InvalidRequest(
                "D3D11 hardware video sources accept only D3D11 texture frames".into(),
            ));
        }

        match self.source {
            #[cfg(not(target_arch = "wasm32"))]
            RtcVideoSource::Native(ref source) => {
                let buffer = colorcvt::to_libwebrtc_buffer(capture.buffer.clone());
                let frame = VideoFrame {
                    rotation: capture.rotation().into(),
                    timestamp_us: capture.timestamp_us,
                    frame_metadata: frame_metadata_from_proto(capture.metadata),
                    buffer,
                };

                source.capture_frame(&frame);
            }
            _ => {}
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    pub fn capture_d3d11_frame(
        &self,
        capture: proto::CaptureD3d11VideoFrameRequest,
    ) -> FfiResult<()> {
        if self.source_mode != proto::VideoSourceMode::D3d11Hardware {
            return Err(FfiError::InvalidRequest(
                "D3D11 texture frames require a D3D11 hardware video source".into(),
            ));
        }

        match self.source {
            RtcVideoSource::Native(ref source) => {
                if !source.capture_d3d11_frame(
                    capture.shared_texture_handle,
                    capture.adapter_luid,
                    capture.acquire_key,
                    capture.release_key,
                    capture.width,
                    capture.height,
                    capture.timestamp_us,
                ) {
                    return Err(FfiError::InvalidRequest(
                        "D3D11 frame was rejected by the native video source".into(),
                    ));
                }
            }
            _ => return Err(FfiError::InvalidRequest("unsupported video source type".into())),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::frame_metadata_from_proto;
    use crate::proto;

    #[test]
    fn empty_proto_frame_metadata_is_ignored() {
        assert!(frame_metadata_from_proto(Some(proto::FrameMetadata::default())).is_none());
    }

    #[test]
    fn proto_frame_metadata_preserves_present_fields() {
        let metadata = frame_metadata_from_proto(Some(proto::FrameMetadata {
            user_timestamp: Some(123),
            frame_id: Some(456),
            user_data: Some(vec![7, 8, 9]),
        }))
        .unwrap();

        assert_eq!(metadata.user_timestamp, Some(123));
        assert_eq!(metadata.frame_id, Some(456));
        assert_eq!(metadata.user_data, Some(vec![7, 8, 9]));
    }
}
