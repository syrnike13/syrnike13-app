// Copyright 2026 LiveKit, Inc.
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

use crate::impl_thread_safety;

/// Callback invoked for native video publish pipeline timing events.
pub type OnVideoPublishTiming = Box<dyn Fn(ffi::VideoPublishTimingEvent) + Send + Sync + 'static>;
/// Callback invoked for native video subscribe pipeline timing events.
pub type OnVideoSubscribeTiming =
    Box<dyn Fn(ffi::VideoSubscribeTimingEvent) + Send + Sync + 'static>;

#[cxx::bridge(namespace = "livekit_ffi")]
pub mod ffi {
    #[repr(i32)]
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum VideoPublishTimingStage {
        EncoderUpload,
        EncoderOutput,
        WebrtcPacketize,
    }

    #[repr(i32)]
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum VideoSubscribeTimingStage {
        WebrtcReceive,
        DecoderUpload,
        DecoderOutput,
    }

    #[derive(Debug, Clone, Copy)]
    pub struct VideoPublishTimingEvent {
        pub stage: VideoPublishTimingStage,
        pub timestamp_us: u64,
        pub capture_timestamp_us: u64,
        pub frame_id: u32,
    }

    #[derive(Debug, Clone, Copy)]
    pub struct VideoSubscribeTimingEvent {
        pub stage: VideoSubscribeTimingStage,
        pub timestamp_us: u64,
        pub capture_timestamp_us: u64,
        pub frame_id: u32,
    }

    unsafe extern "C++" {
        include!("livekit/packet_trailer.h");
        include!("livekit/packet_trailer_h264.h");
        include!("livekit/rtp_sender.h");
        include!("livekit/rtp_receiver.h");
        include!("livekit/peer_connection_factory.h");

        type RtpSender = crate::rtp_sender::ffi::RtpSender;
        type RtpReceiver = crate::rtp_receiver::ffi::RtpReceiver;
        type PeerConnectionFactory = crate::peer_connection_factory::ffi::PeerConnectionFactory;

        /// Handler for packet trailer embedding/extraction on RTP streams.
        pub type PacketTrailerHandler;

        /// Enable/disable timestamp embedding.
        fn set_enabled(self: &PacketTrailerHandler, enabled: bool);

        /// Check if timestamp embedding is enabled.
        fn enabled(self: &PacketTrailerHandler) -> bool;

        /// Lookup the user timestamp for a given RTP timestamp (receiver side).
        /// Returns -1 if not found. The entry is removed after lookup.
        /// Also caches the frame_id for retrieval via last_lookup_frame_id().
        fn lookup_timestamp(self: &PacketTrailerHandler, rtp_timestamp: u32) -> u64;

        /// Returns the frame_id from the most recent successful
        /// lookup_timestamp() call.
        fn last_lookup_frame_id(self: &PacketTrailerHandler) -> u32;

        /// Returns the user_data from the most recent successful
        /// lookup_timestamp() call. Empty if none.
        fn last_lookup_user_data(self: &PacketTrailerHandler) -> Vec<u8>;

        /// Store frame metadata for a given capture timestamp (sender side).
        fn store_frame_metadata(
            self: &PacketTrailerHandler,
            capture_timestamp_us: i64,
            user_timestamp: u64,
            frame_id: u32,
            user_data: &[u8],
        );

        /// Set a callback for sender-side publish timing events.
        fn set_publish_timing_observer(
            self: &PacketTrailerHandler,
            observer: Box<VideoPublishTimingObserverWrapper>,
        );

        /// Clear the sender-side publish timing callback.
        fn clear_publish_timing_observer(self: &PacketTrailerHandler);

        /// Set a callback for receiver-side subscribe timing events.
        fn set_subscribe_timing_observer(
            self: &PacketTrailerHandler,
            observer: Box<VideoSubscribeTimingObserverWrapper>,
        );

        /// Clear the receiver-side subscribe timing callback.
        fn clear_subscribe_timing_observer(self: &PacketTrailerHandler);

        /// Emit a receiver-side subscribe timing event.
        fn emit_subscribe_timing(
            self: &PacketTrailerHandler,
            stage: VideoSubscribeTimingStage,
            user_timestamp: u64,
            frame_id: u32,
        );

        /// Create a new packet trailer handler for a sender.
        fn new_packet_trailer_sender(
            peer_factory: SharedPtr<PeerConnectionFactory>,
            sender: SharedPtr<RtpSender>,
        ) -> SharedPtr<PacketTrailerHandler>;

        /// Create a new packet trailer handler for a receiver.
        fn new_packet_trailer_receiver(
            peer_factory: SharedPtr<PeerConnectionFactory>,
            receiver: SharedPtr<RtpReceiver>,
        ) -> SharedPtr<PacketTrailerHandler>;

        fn h264_insert_trailer_for_test(access_unit: &[u8], trailer: &[u8]) -> Vec<u8>;
        fn h264_extract_trailer_for_test(access_unit: &[u8]) -> Vec<u8>;
        fn h264_strip_trailer_for_test(access_unit: &[u8]) -> Vec<u8>;
        fn h264_is_decodable_keyframe_for_test(access_unit: &[u8]) -> bool;
        fn h264_should_forward_access_unit_to_decoder_for_test(
            access_unit: &[u8],
            is_keyframe: bool,
            first_complete_keyframe_seen: bool,
        ) -> bool;
    }

    extern "Rust" {
        type VideoPublishTimingObserverWrapper;
        type VideoSubscribeTimingObserverWrapper;

        fn on_publish_timing(
            self: &VideoPublishTimingObserverWrapper,
            event: VideoPublishTimingEvent,
        );

        fn on_subscribe_timing(
            self: &VideoSubscribeTimingObserverWrapper,
            event: VideoSubscribeTimingEvent,
        );
    }
}

impl_thread_safety!(ffi::PacketTrailerHandler, Send + Sync);

pub struct VideoPublishTimingObserverWrapper {
    observer: OnVideoPublishTiming,
}

impl VideoPublishTimingObserverWrapper {
    pub fn new(observer: OnVideoPublishTiming) -> Self {
        Self { observer }
    }

    fn on_publish_timing(&self, event: ffi::VideoPublishTimingEvent) {
        (self.observer)(event);
    }
}

pub struct VideoSubscribeTimingObserverWrapper {
    observer: OnVideoSubscribeTiming,
}

impl VideoSubscribeTimingObserverWrapper {
    pub fn new(observer: OnVideoSubscribeTiming) -> Self {
        Self { observer }
    }

    fn on_subscribe_timing(&self, event: ffi::VideoSubscribeTimingEvent) {
        (self.observer)(event);
    }
}

#[cfg(test)]
mod tests {
    use super::ffi;

    fn annex_b_nal_types(access_unit: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut offset = 0;
        while offset + 3 <= access_unit.len() {
            let start_code_len = if access_unit[offset..].starts_with(&[0, 0, 1]) {
                3
            } else if access_unit[offset..].starts_with(&[0, 0, 0, 1]) {
                4
            } else {
                offset += 1;
                continue;
            };
            let payload = offset + start_code_len;
            if payload < access_unit.len() {
                types.push(access_unit[payload] & 0x1f);
            }
            offset = payload + 1;
        }
        types
    }

    #[test]
    fn h264_sei_packet_trailer_round_trips_without_corrupting_access_unit() {
        let access_unit = vec![
            0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x06, 0xe2, 0, 0, 0, 1,
            0x65, 0x88, 0, 0, 1, 0x02,
        ];
        let trailer = vec![1, 8, 0, 0, 0, 0, 0, 0, 0x2a, 2, 4, 0, 0, 0, 7, 16, 0xef, 0xbe];

        let encoded = ffi::h264_insert_trailer_for_test(&access_unit, &trailer);

        assert_ne!(encoded, access_unit);
        assert_eq!(ffi::h264_extract_trailer_for_test(&encoded), trailer);
        assert_eq!(ffi::h264_strip_trailer_for_test(&encoded), access_unit);
    }

    #[test]
    fn h264_metadata_sei_precedes_all_vcl_nalus_in_multi_slice_access_unit() {
        let access_unit = vec![
            0, 0, 0, 1, 0x09, 0xf0, // AUD
            0, 0, 1, 0x67, 0x42, 0x00, 0x1f, // SPS, 3-byte start code
            0, 0, 0, 1, 0x68, 0xce, 0x06, 0xe2, // PPS
            0, 0, 1, 0x06, 0x01, 0x01, 0x80, // Existing SEI
            0, 0, 0, 1, 0x65, 0x88, 0x84, // First IDR slice
            0, 0, 1, 0x65, 0x99, 0x84, // Second IDR slice
        ];
        let trailer = vec![0x10, 0x20, 0x30];

        let encoded = ffi::h264_insert_trailer_for_test(&access_unit, &trailer);

        assert_eq!(annex_b_nal_types(&encoded), [9, 7, 8, 6, 6, 5, 5]);
        assert_eq!(ffi::h264_extract_trailer_for_test(&encoded), trailer);
        assert_eq!(ffi::h264_strip_trailer_for_test(&encoded), access_unit);
    }

    #[test]
    fn h264_metadata_sei_precedes_vcl_when_parameter_sets_are_absent() {
        let access_unit = vec![
            0, 0, 1, 0x41, 0xaa, 0xbb, // First non-IDR slice
            0, 0, 0, 1, 0x41, 0xcc, 0xdd, // Second non-IDR slice
        ];
        let trailer = vec![0x44, 0x55];

        let encoded = ffi::h264_insert_trailer_for_test(&access_unit, &trailer);

        assert_eq!(annex_b_nal_types(&encoded), [6, 1, 1]);
        assert_eq!(ffi::h264_extract_trailer_for_test(&encoded), trailer);
        assert_eq!(ffi::h264_strip_trailer_for_test(&encoded), access_unit);
    }

    #[test]
    fn late_subscriber_holds_h264_until_complete_sps_pps_idr() {
        let delta = vec![0, 0, 0, 1, 0x41, 0xaa, 0xbb];
        let incomplete_key = vec![0, 0, 0, 1, 0x65, 0xb8];
        let complete_key = vec![
            0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x06, 0xe2, 0, 0, 0, 1,
            0x65, 0xb8,
        ];
        let later_delta = vec![0, 0, 0, 1, 0x41, 0xcc, 0xdd];

        assert!(!ffi::h264_is_decodable_keyframe_for_test(&delta));
        assert!(!ffi::h264_is_decodable_keyframe_for_test(&incomplete_key));
        assert!(ffi::h264_is_decodable_keyframe_for_test(&complete_key));

        assert!(!ffi::h264_should_forward_access_unit_to_decoder_for_test(&delta, false, false));
        assert!(!ffi::h264_should_forward_access_unit_to_decoder_for_test(
            &incomplete_key,
            true,
            false,
        ));
        assert!(ffi::h264_should_forward_access_unit_to_decoder_for_test(
            &complete_key,
            true,
            false,
        ));
        assert!(ffi::h264_should_forward_access_unit_to_decoder_for_test(
            &later_delta,
            false,
            true,
        ));
        assert!(!ffi::h264_should_forward_access_unit_to_decoder_for_test(
            &later_delta,
            false,
            false,
        ));
    }
}
