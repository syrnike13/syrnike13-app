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

use crate::impl_thread_safety;

#[cxx::bridge(namespace = "livekit_ffi")]
pub mod ffi {
    #[derive(Debug)]
    #[repr(i32)]
    pub enum VideoFrameBufferType {
        Native,
        I420,
        I420A,
        I422,
        I444,
        I010,
        NV12,
    }

    unsafe extern "C++" {
        include!("livekit/video_frame_buffer.h");
        #[cfg(target_os = "windows")]
        include!("livekit/windows_d3d11_h264_encoder.h");

        type VideoFrameBuffer;
        type PlanarYuvBuffer;
        type PlanarYuv8Buffer;
        type PlanarYuv16BBuffer;
        type BiplanarYuvBuffer;
        type BiplanarYuv8Buffer;
        type I420Buffer;
        type I420ABuffer;
        type I422Buffer;
        type I444Buffer;
        type I010Buffer;
        type NV12Buffer;
        type PlatformImageBuffer;

        fn buffer_type(self: &VideoFrameBuffer) -> VideoFrameBufferType;
        fn width(self: &VideoFrameBuffer) -> u32;
        fn height(self: &VideoFrameBuffer) -> u32;

        /// # SAFETY
        /// If the buffer type is I420, the buffer must be cloned before
        unsafe fn to_i420(self: &VideoFrameBuffer) -> UniquePtr<I420Buffer>;

        /// # SAFETY
        /// The functions require ownership
        unsafe fn get_i420(self: Pin<&mut VideoFrameBuffer>) -> UniquePtr<I420Buffer>;
        unsafe fn get_i420a(self: Pin<&mut VideoFrameBuffer>) -> UniquePtr<I420ABuffer>;
        unsafe fn get_i422(self: Pin<&mut VideoFrameBuffer>) -> UniquePtr<I422Buffer>;
        unsafe fn get_i444(self: Pin<&mut VideoFrameBuffer>) -> UniquePtr<I444Buffer>;
        unsafe fn get_i010(self: Pin<&mut VideoFrameBuffer>) -> UniquePtr<I010Buffer>;
        unsafe fn get_nv12(self: Pin<&mut VideoFrameBuffer>) -> UniquePtr<NV12Buffer>;

        fn chroma_width(self: &PlanarYuvBuffer) -> u32;
        fn chroma_height(self: &PlanarYuvBuffer) -> u32;
        fn stride_y(self: &PlanarYuvBuffer) -> u32;
        fn stride_u(self: &PlanarYuvBuffer) -> u32;
        fn stride_v(self: &PlanarYuvBuffer) -> u32;

        fn data_y(self: &PlanarYuv8Buffer) -> *const u8;
        fn data_u(self: &PlanarYuv8Buffer) -> *const u8;
        fn data_v(self: &PlanarYuv8Buffer) -> *const u8;

        fn data_y(self: &PlanarYuv16BBuffer) -> *const u16;
        fn data_u(self: &PlanarYuv16BBuffer) -> *const u16;
        fn data_v(self: &PlanarYuv16BBuffer) -> *const u16;

        fn chroma_width(self: &BiplanarYuvBuffer) -> u32;
        fn chroma_height(self: &BiplanarYuvBuffer) -> u32;
        fn stride_y(self: &BiplanarYuvBuffer) -> u32;
        fn stride_uv(self: &BiplanarYuvBuffer) -> u32;

        fn data_y(self: &BiplanarYuv8Buffer) -> *const u8;
        fn data_uv(self: &BiplanarYuv8Buffer) -> *const u8;

        fn stride_a(self: &I420ABuffer) -> u32;
        fn data_a(self: &I420ABuffer) -> *const u8;

        fn scale(self: &I420Buffer, scaled_width: i32, scaled_height: i32)
            -> UniquePtr<I420Buffer>;
        fn scale(
            self: &I420ABuffer,
            scaled_width: i32,
            scaled_height: i32,
        ) -> UniquePtr<I420ABuffer>;
        fn scale(self: &I422Buffer, scaled_width: i32, scaled_height: i32)
            -> UniquePtr<I422Buffer>;
        fn scale(self: &I444Buffer, scaled_width: i32, scaled_height: i32)
            -> UniquePtr<I444Buffer>;
        fn scale(self: &I010Buffer, scaled_width: i32, scaled_height: i32)
            -> UniquePtr<I010Buffer>;
        fn scale(self: &NV12Buffer, scaled_width: i32, scaled_height: i32)
            -> UniquePtr<NV12Buffer>;

        fn copy_i420_buffer(i420: &UniquePtr<I420Buffer>) -> UniquePtr<I420Buffer>;
        fn new_i420_buffer(
            width: i32,
            height: i32,
            stride_y: i32,
            stride_u: i32,
            stride_v: i32,
        ) -> UniquePtr<I420Buffer>;

        fn new_i422_buffer(
            width: i32,
            height: i32,
            stride_y: i32,
            stride_u: i32,
            stride_v: i32,
        ) -> UniquePtr<I422Buffer>;

        fn new_i444_buffer(
            width: i32,
            height: i32,
            stride_y: i32,
            stride_u: i32,
            stride_v: i32,
        ) -> UniquePtr<I444Buffer>;

        fn new_i010_buffer(
            width: i32,
            height: i32,
            stride_y: i32,
            stride_u: i32,
            stride_v: i32,
        ) -> UniquePtr<I010Buffer>;

        fn new_nv12_buffer(
            width: i32,
            height: i32,
            stride_y: i32,
            stride_uv: i32,
        ) -> UniquePtr<NV12Buffer>;

        unsafe fn new_native_buffer_from_platform_image_buffer(
            platform_native_buffer: *mut PlatformImageBuffer,
        ) -> UniquePtr<VideoFrameBuffer>;
        unsafe fn native_buffer_to_platform_image_buffer(
            buffer: &UniquePtr<VideoFrameBuffer>,
        ) -> *mut PlatformImageBuffer;

        unsafe fn yuv_to_vfb(yuv: *const PlanarYuvBuffer) -> *const VideoFrameBuffer;
        unsafe fn biyuv_to_vfb(yuv: *const BiplanarYuvBuffer) -> *const VideoFrameBuffer;
        unsafe fn yuv8_to_yuv(yuv8: *const PlanarYuv8Buffer) -> *const PlanarYuvBuffer;
        unsafe fn yuv16b_to_yuv(yuv16b: *const PlanarYuv16BBuffer) -> *const PlanarYuvBuffer;
        unsafe fn biyuv8_to_biyuv(biyuv8: *const BiplanarYuv8Buffer) -> *const BiplanarYuvBuffer;
        unsafe fn i420_to_yuv8(i420: *const I420Buffer) -> *const PlanarYuv8Buffer;
        unsafe fn i420a_to_yuv8(i420a: *const I420ABuffer) -> *const PlanarYuv8Buffer;
        unsafe fn i422_to_yuv8(i422: *const I422Buffer) -> *const PlanarYuv8Buffer;
        unsafe fn i444_to_yuv8(i444: *const I444Buffer) -> *const PlanarYuv8Buffer;
        unsafe fn i010_to_yuv16b(i010: *const I010Buffer) -> *const PlanarYuv16BBuffer;
        unsafe fn nv12_to_biyuv8(nv12: *const NV12Buffer) -> *const BiplanarYuv8Buffer;

        fn _unique_video_frame_buffer() -> UniquePtr<VideoFrameBuffer>;

        #[cfg(target_os = "windows")]
        fn windows_d3d11_h264_accepts_buffer_for_test(buffer: &VideoFrameBuffer) -> bool;
        #[cfg(target_os = "windows")]
        fn windows_d3d11_h264_repair_keyframe_for_test(
            initial_keyframe: &[u8],
            forced_keyframe: &[u8],
        ) -> Vec<u8>;
        #[cfg(target_os = "windows")]
        fn windows_d3d11_h264_merge_keyframe_intent_for_test(
            pending: bool,
            requested: bool,
            superseded: bool,
        ) -> bool;
    }
}

impl_thread_safety!(ffi::VideoFrameBuffer, Send + Sync);
impl_thread_safety!(ffi::PlanarYuvBuffer, Send + Sync);
impl_thread_safety!(ffi::PlanarYuv8Buffer, Send + Sync);
impl_thread_safety!(ffi::PlanarYuv16BBuffer, Send + Sync);
impl_thread_safety!(ffi::BiplanarYuvBuffer, Send + Sync);
impl_thread_safety!(ffi::BiplanarYuv8Buffer, Send + Sync);
impl_thread_safety!(ffi::I420Buffer, Send + Sync);
impl_thread_safety!(ffi::I420ABuffer, Send + Sync);
impl_thread_safety!(ffi::I422Buffer, Send + Sync);
impl_thread_safety!(ffi::I444Buffer, Send + Sync);
impl_thread_safety!(ffi::I010Buffer, Send + Sync);
impl_thread_safety!(ffi::NV12Buffer, Send + Sync);

#[cfg(all(test, target_os = "windows"))]
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
            types.push(access_unit[offset + start_code_len] & 0x1f);
            offset += start_code_len + 1;
        }
        types
    }

    #[test]
    fn d3d11_h264_encoder_rejects_i420_without_rtti_cast() {
        let i420 = ffi::new_i420_buffer(2, 2, 2, 1, 1);
        let yuv8 = unsafe { ffi::i420_to_yuv8(&*i420) };
        let yuv = unsafe { ffi::yuv8_to_yuv(yuv8) };
        let buffer = unsafe { ffi::yuv_to_vfb(yuv) };

        assert!(!ffi::windows_d3d11_h264_accepts_buffer_for_test(unsafe { &*buffer }));
    }

    #[test]
    fn d3d11_h264_forced_keyframe_reuses_cached_parameter_sets() {
        let initial_keyframe =
            [0, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0, 0, 1, 0x68, 0xce, 6, 0xe2, 0, 0, 0, 1, 0x65, 0x88];
        let forced_keyframe = [0, 0, 1, 0x65, 0x99, 0x84, 0, 0, 0, 1, 0x65, 0xaa, 0x84];

        let repaired =
            ffi::windows_d3d11_h264_repair_keyframe_for_test(&initial_keyframe, &forced_keyframe);

        assert_eq!(annex_b_nal_types(&repaired), [7, 8, 5, 5]);
        assert!(repaired.ends_with(&forced_keyframe));
    }

    #[test]
    fn d3d11_h264_complete_forced_keyframe_is_byte_exact() {
        let complete_keyframe =
            [0, 0, 1, 0x67, 0x42, 0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 6, 0xe2, 0, 0, 1, 0x65, 0x88];

        assert_eq!(
            ffi::windows_d3d11_h264_repair_keyframe_for_test(
                &complete_keyframe,
                &complete_keyframe,
            ),
            complete_keyframe
        );
    }

    #[test]
    fn d3d11_h264_parameter_sets_after_idr_are_prepended_before_it() {
        let initial_keyframe =
            [0, 0, 1, 0x67, 0x42, 0, 0x1f, 0, 0, 1, 0x68, 0xce, 6, 0xe2, 0, 0, 1, 0x65, 0x88];
        let late_parameter_sets =
            [0, 0, 1, 0x65, 0x99, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0, 0, 1, 0x68, 0xce, 6, 0xe2];

        let repaired = ffi::windows_d3d11_h264_repair_keyframe_for_test(
            &initial_keyframe,
            &late_parameter_sets,
        );

        assert_eq!(annex_b_nal_types(&repaired), [7, 8, 5, 7, 8]);
    }

    #[test]
    fn d3d11_h264_keyframe_intent_survives_latest_wins_queue() {
        assert!(ffi::windows_d3d11_h264_merge_keyframe_intent_for_test(false, false, true));
        assert!(ffi::windows_d3d11_h264_merge_keyframe_intent_for_test(true, false, false));
        assert!(ffi::windows_d3d11_h264_merge_keyframe_intent_for_test(false, true, false));
    }
}
