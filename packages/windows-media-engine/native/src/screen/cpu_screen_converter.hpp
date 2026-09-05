#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

#include "screen/screen_frame_marker.hpp"
#include "screen/screen_frame_pipeline.hpp"

namespace syrnike::windows_media::screen {

inline constexpr std::uint32_t kCpuReferenceWidth = 1280;
inline constexpr std::uint32_t kCpuReferenceHeight = 720;
inline constexpr std::uint32_t kCpuReferenceFramesPerSecond = 30;
inline constexpr std::uint64_t kMaximumCpuReadbackBytes =
    7680ULL * 4320ULL * 4ULL;

struct ScreenConversionResult {
  capture::FrameMetadata source;
  std::uint64_t captured_at_epoch_ms = 0;
  std::uint64_t capture_age_before_readback_ms = 0;
  std::uint64_t readback_duration_us = 0;
  std::uint64_t conversion_duration_us = 0;
};

struct CpuScreenConverterStats {
  std::uint64_t converted = 0;
  std::uint64_t buffer_reconfigurations = 0;
  std::size_t input_buffer_bytes = 0;
  std::size_t peak_input_buffer_bytes = 0;
  std::uint64_t current_generation = 0;
};

class CpuScreenConverter final {
 public:
  ScreenConversionResult convert(ScreenPipelineFrame& frame,
                                 std::span<std::uint8_t> output_bgra,
                                 std::uint32_t output_width,
                                 std::uint32_t output_height);
  CpuScreenConverterStats stats() const noexcept;

 private:
  std::vector<std::uint8_t> input_bgra_;
  CpuScreenConverterStats stats_;
  std::uint32_t input_width_ = 0;
  std::uint32_t input_height_ = 0;
};

}  // namespace syrnike::windows_media::screen
