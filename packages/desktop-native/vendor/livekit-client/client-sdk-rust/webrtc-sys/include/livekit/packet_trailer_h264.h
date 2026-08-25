/*
 * Copyright 2026 LiveKit, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#pragma once

#include <cstdint>
#include <optional>
#include <vector>

#include "api/array_view.h"
#include "api/frame_transformer_interface.h"
#include "livekit/packet_trailer.h"
#include "rust/cxx.h"

namespace livekit_ffi {
namespace h264 {

/// Returns true if the frame's MIME type identifies it as H264.
bool IsH264Frame(const webrtc::TransformableFrameInterface& frame);

/// Returns true when an Annex-B access unit contains SPS and PPS before an
/// IDR picture, with no delta slices mixed into that picture.
bool IsDecodableKeyframeAccessUnit(webrtc::ArrayView<const uint8_t> data);

enum class DecoderGateDecision : std::uint8_t {
  Forward,
  AwaitCompleteKeyframe,
  ResetParameterSetAfterSlice,
  ResetInvalidSliceHeader,
  ResetMixedPictureParameterSet,
};

/// Classifies an access unit and updates the decoder gate. A reset decision
/// means the caller must request decoder recovery before accepting deltas.
DecoderGateDecision EvaluateAccessUnitForDecoder(
    webrtc::ArrayView<const uint8_t> data,
    bool is_keyframe,
    bool& first_complete_keyframe_seen);

/// Returns true when this access unit may be passed to the inner H264 decoder.
/// Delta or incomplete units are held until the first complete SPS/PPS/IDR
/// keyframe has been observed. Later units remain gated against mixed slice
/// parameter sets; rejecting one resets the gate until a complete keyframe.
bool ShouldForwardAccessUnitToDecoder(
    webrtc::ArrayView<const uint8_t> data,
    bool is_keyframe,
    bool& first_complete_keyframe_seen);

/// Inserts a LiveKit packet trailer as an H264 user_data_unregistered SEI NAL
/// before the first VCL NAL, preserving the access unit's RTP marker boundary.
std::vector<uint8_t> InsertTrailerSei(
    webrtc::ArrayView<const uint8_t> data,
    webrtc::ArrayView<const uint8_t> trailer);

/// Extracts and removes the LiveKit SEI NAL from an H264 Annex-B access unit.
std::optional<PacketTrailerMetadata> ExtractTrailer(
    webrtc::ArrayView<const uint8_t> data,
    std::vector<uint8_t>& out_data);

}  // namespace h264

rust::Vec<uint8_t> h264_insert_trailer_for_test(
    rust::Slice<const uint8_t> access_unit,
    rust::Slice<const uint8_t> trailer);
rust::Vec<uint8_t> h264_extract_trailer_for_test(
    rust::Slice<const uint8_t> access_unit);
rust::Vec<uint8_t> h264_strip_trailer_for_test(
    rust::Slice<const uint8_t> access_unit);
bool h264_is_decodable_keyframe_for_test(
    rust::Slice<const uint8_t> access_unit);
bool h264_should_forward_access_unit_to_decoder_for_test(
    rust::Slice<const uint8_t> access_unit,
    bool is_keyframe,
    bool first_complete_keyframe_seen);

}  // namespace livekit_ffi
