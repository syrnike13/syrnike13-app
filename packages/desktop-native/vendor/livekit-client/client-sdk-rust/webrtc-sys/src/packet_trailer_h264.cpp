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

#include "livekit/packet_trailer_h264.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstddef>
#include <string>
#include <utility>

#include "h264_annex_b.h"

namespace livekit_ffi {
namespace h264 {

namespace {

constexpr uint8_t kSeiNalType = 6;
constexpr uint32_t kUserDataUnregisteredPayloadType = 5;
constexpr std::array<uint8_t, 16> kPacketTrailerUuid = {
    0x6c, 0x69, 0x76, 0x65, 0x6b, 0x69, 0x74, 0x2d,
    0x70, 0x6b, 0x74, 0x2d, 0x74, 0x72, 0x6c, 0x72};

std::vector<uint8_t> UnescapeRbsp(webrtc::ArrayView<const uint8_t> escaped);

void WriteSeiValue(size_t value, std::vector<uint8_t>& out) {
  while (value >= 0xff) {
    out.push_back(0xff);
    value -= 0xff;
  }
  out.push_back(static_cast<uint8_t>(value));
}

bool ReadSeiValue(webrtc::ArrayView<const uint8_t> data,
                  size_t& pos,
                  size_t& value) {
  value = 0;
  while (pos < data.size() && data[pos] == 0xff) {
    value += 0xff;
    ++pos;
  }
  if (pos >= data.size()) return false;
  value += data[pos++];
  return true;
}

class RbspBitReader final {
 public:
  explicit RbspBitReader(webrtc::ArrayView<const uint8_t> escaped)
      : escaped_(escaped) {}

  bool ReadBit(bool& value) {
    SkipEmulationPreventionByte();
    if (byte_offset_ >= escaped_.size()) return false;
    const uint8_t byte = escaped_[byte_offset_];
    value = ((byte >> (7 - bit_offset_)) & 1) != 0;
    if (++bit_offset_ == 8) {
      bit_offset_ = 0;
      ++byte_offset_;
      zero_count_ = byte == 0 ? zero_count_ + 1 : 0;
    }
    return true;
  }

 private:
  void SkipEmulationPreventionByte() {
    if (bit_offset_ == 0 && zero_count_ >= 2 &&
        byte_offset_ < escaped_.size() && escaped_[byte_offset_] == 3) {
      ++byte_offset_;
      zero_count_ = 0;
    }
  }

  webrtc::ArrayView<const uint8_t> escaped_;
  size_t byte_offset_ = 0;
  uint8_t bit_offset_ = 0;
  uint8_t zero_count_ = 0;
};

bool ReadUnsignedExpGolomb(RbspBitReader& reader, uint32_t& value) {
  size_t leading_zero_bits = 0;
  bool bit = false;
  for (;;) {
    if (!reader.ReadBit(bit)) return false;
    if (bit) break;
    if (++leading_zero_bits > 31) return false;
  }
  uint32_t suffix = 0;
  for (size_t i = 0; i < leading_zero_bits; ++i) {
    if (!reader.ReadBit(bit)) return false;
    suffix = (suffix << 1) | static_cast<uint32_t>(bit);
  }
  value = ((uint32_t{1} << leading_zero_bits) - 1) + suffix;
  return true;
}

std::optional<uint32_t> SlicePpsId(webrtc::ArrayView<const uint8_t> payload) {
  RbspBitReader reader(payload);
  uint32_t ignored = 0;
  uint32_t pps_id = 0;
  if (!ReadUnsignedExpGolomb(reader, ignored) ||
      !ReadUnsignedExpGolomb(reader, ignored) ||
      !ReadUnsignedExpGolomb(reader, pps_id)) {
    return std::nullopt;
  }
  return pps_id;
}

std::vector<uint8_t> EscapeRbsp(webrtc::ArrayView<const uint8_t> rbsp) {
  std::vector<uint8_t> escaped;
  escaped.reserve(rbsp.size());
  int zero_count = 0;
  for (uint8_t byte : rbsp) {
    if (zero_count >= 2 && byte <= 3) {
      escaped.push_back(3);
      zero_count = 0;
    }
    escaped.push_back(byte);
    zero_count = byte == 0 ? zero_count + 1 : 0;
  }
  return escaped;
}

std::vector<uint8_t> UnescapeRbsp(webrtc::ArrayView<const uint8_t> escaped) {
  std::vector<uint8_t> rbsp;
  rbsp.reserve(escaped.size());
  int zero_count = 0;
  for (uint8_t byte : escaped) {
    if (zero_count >= 2 && byte == 3) {
      zero_count = 0;
      continue;
    }
    rbsp.push_back(byte);
    zero_count = byte == 0 ? zero_count + 1 : 0;
  }
  return rbsp;
}

std::optional<std::vector<uint8_t>> ExtractTrailerPayload(
    webrtc::ArrayView<const uint8_t> data,
    std::vector<uint8_t>& out_data) {
  AnnexBNaluIterator nalus(data.data(), data.size());
  while (const auto nalu = nalus.Next()) {
    if (nalu->payload >= nalu->end ||
        (data[nalu->payload] & 0x1f) != kSeiNalType) {
      continue;
    }

    auto rbsp = UnescapeRbsp(data.subview(nalu->payload + 1,
                                          nalu->end - nalu->payload - 1));
    size_t pos = 0;
    while (pos < rbsp.size() && rbsp[pos] != 0x80) {
      size_t payload_type = 0;
      size_t payload_size = 0;
      if (!ReadSeiValue(rbsp, pos, payload_type) ||
          !ReadSeiValue(rbsp, pos, payload_size) ||
          payload_size > rbsp.size() - pos) {
        break;
      }

      const size_t payload_end = pos + payload_size;
      if (payload_type == kUserDataUnregisteredPayloadType &&
          payload_size >= kPacketTrailerUuid.size() &&
          std::equal(kPacketTrailerUuid.begin(), kPacketTrailerUuid.end(),
                     rbsp.begin() + pos)) {
        std::vector<uint8_t> trailer(
            rbsp.begin() + pos + kPacketTrailerUuid.size(),
            rbsp.begin() + payload_end);
        out_data.reserve(data.size() - (nalu->end - nalu->start));
        out_data.insert(out_data.end(), data.begin(),
                        data.begin() + nalu->start);
        out_data.insert(out_data.end(), data.begin() + nalu->end, data.end());
        return trailer;
      }
      pos = payload_end;
    }
  }

  out_data.assign(data.begin(), data.end());
  return std::nullopt;
}

}  // namespace

bool IsH264Frame(const webrtc::TransformableFrameInterface& frame) {
  std::string mime_type = frame.GetMimeType();
  std::transform(mime_type.begin(), mime_type.end(), mime_type.begin(),
                 [](unsigned char c) {
                   return static_cast<char>(std::tolower(c));
                 });
  return mime_type.find("h264") != std::string::npos;
}

bool IsDecodableKeyframeAccessUnit(webrtc::ArrayView<const uint8_t> data) {
  bool has_sps_before_idr = false;
  bool has_pps_before_idr = false;
  bool has_idr = false;
  std::optional<uint32_t> picture_pps_id;
  AnnexBNaluIterator nalus(data.data(), data.size());
  while (const auto nalu = nalus.Next()) {
    if (nalu->payload >= nalu->end) continue;
    const uint8_t type = data[nalu->payload] & 0x1f;
    if (!has_idr && type == 7) has_sps_before_idr = true;
    if (!has_idr && type == 8) has_pps_before_idr = true;
    if (type >= 1 && type <= 5 && type != 5) return false;
    if (type != 5) continue;
    has_idr = true;
    const auto pps_id = SlicePpsId(
        data.subview(nalu->payload + 1, nalu->end - nalu->payload - 1));
    if (!pps_id.has_value()) return false;
    if (picture_pps_id.has_value() && picture_pps_id != pps_id) return false;
    picture_pps_id = pps_id;
  }
  return has_sps_before_idr && has_pps_before_idr && has_idr;
}

bool ShouldForwardAccessUnitToDecoder(
    webrtc::ArrayView<const uint8_t> data,
    bool is_keyframe,
    bool& first_complete_keyframe_seen) {
  if (first_complete_keyframe_seen) return true;
  if (is_keyframe && IsDecodableKeyframeAccessUnit(data)) {
    first_complete_keyframe_seen = true;
    return true;
  }
  return false;
}

std::vector<uint8_t> InsertTrailerSei(
    webrtc::ArrayView<const uint8_t> data,
    webrtc::ArrayView<const uint8_t> trailer) {
  std::vector<uint8_t> rbsp;
  WriteSeiValue(kUserDataUnregisteredPayloadType, rbsp);
  WriteSeiValue(kPacketTrailerUuid.size() + trailer.size(), rbsp);
  rbsp.insert(rbsp.end(), kPacketTrailerUuid.begin(), kPacketTrailerUuid.end());
  rbsp.insert(rbsp.end(), trailer.begin(), trailer.end());
  rbsp.push_back(0x80);
  auto escaped_rbsp = EscapeRbsp(rbsp);

  size_t insert_at = data.size();
  AnnexBNaluIterator nalus(data.data(), data.size());
  while (const auto nalu = nalus.Next()) {
    if (nalu->payload >= nalu->end) continue;
    const uint8_t nal_type = data[nalu->payload] & 0x1f;
    if (nal_type >= 1 && nal_type <= 5) {
      insert_at = nalu->start;
      break;
    }
  }

  std::vector<uint8_t> result;
  result.reserve(data.size() + 5 + escaped_rbsp.size());
  result.insert(result.end(), data.begin(), data.begin() + insert_at);
  result.insert(result.end(), {0, 0, 0, 1, kSeiNalType});
  result.insert(result.end(), escaped_rbsp.begin(), escaped_rbsp.end());
  result.insert(result.end(), data.begin() + insert_at, data.end());
  return result;
}

std::optional<PacketTrailerMetadata> ExtractTrailer(
    webrtc::ArrayView<const uint8_t> data,
    std::vector<uint8_t>& out_data) {
  auto trailer = ExtractTrailerPayload(data, out_data);
  if (!trailer.has_value()) return std::nullopt;
  auto metadata = ParseTrailerPayload(*trailer);
  if (!metadata.has_value()) {
    out_data.assign(data.begin(), data.end());
  }
  return metadata;
}

}  // namespace h264

namespace {

rust::Vec<uint8_t> ToRustVec(webrtc::ArrayView<const uint8_t> data) {
  rust::Vec<uint8_t> result;
  result.reserve(data.size());
  for (uint8_t byte : data) result.push_back(byte);
  return result;
}

}  // namespace

rust::Vec<uint8_t> h264_insert_trailer_for_test(
    rust::Slice<const uint8_t> access_unit,
    rust::Slice<const uint8_t> trailer) {
  auto encoded = h264::InsertTrailerSei(access_unit, trailer);
  return ToRustVec(encoded);
}

rust::Vec<uint8_t> h264_extract_trailer_for_test(
    rust::Slice<const uint8_t> access_unit) {
  std::vector<uint8_t> stripped;
  auto trailer = h264::ExtractTrailerPayload(access_unit, stripped);
  return trailer.has_value() ? ToRustVec(*trailer) : rust::Vec<uint8_t>{};
}

rust::Vec<uint8_t> h264_strip_trailer_for_test(
    rust::Slice<const uint8_t> access_unit) {
  std::vector<uint8_t> stripped;
  h264::ExtractTrailerPayload(access_unit, stripped);
  return ToRustVec(stripped);
}

bool h264_is_decodable_keyframe_for_test(
    rust::Slice<const uint8_t> access_unit) {
  return h264::IsDecodableKeyframeAccessUnit(access_unit);
}

bool h264_should_forward_access_unit_to_decoder_for_test(
    rust::Slice<const uint8_t> access_unit,
    bool is_keyframe,
    bool first_complete_keyframe_seen) {
  bool seen = first_complete_keyframe_seen;
  return h264::ShouldForwardAccessUnitToDecoder(
      access_unit, is_keyframe, seen);
}

}  // namespace livekit_ffi
