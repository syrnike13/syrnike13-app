#include "screen/cpu_screen_converter.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace syrnike::windows_media::screen {

ScreenConversionResult CpuScreenConverter::convert(
    ScreenPipelineFrame& frame, std::span<std::uint8_t> output_bgra,
    std::uint32_t output_width, std::uint32_t output_height) {
  if (!frame) throw std::invalid_argument("screen frame is unavailable");
  const auto metadata = frame.metadata();
  if (metadata.format != capture::FramePixelFormat::Bgra8 ||
      metadata.width == 0 || metadata.height == 0 ||
      output_width < kScreenMarkerColumns * kScreenMarkerTileSize ||
      output_height < kScreenMarkerRows * kScreenMarkerTileSize) {
    throw std::invalid_argument("unsupported screen conversion dimensions");
  }
  const auto input_bytes = static_cast<std::uint64_t>(metadata.width) *
                           metadata.height * 4ULL;
  const auto output_bytes = static_cast<std::uint64_t>(output_width) *
                            output_height * 4ULL;
  if (input_bytes > kMaximumCpuReadbackBytes ||
      input_bytes > std::numeric_limits<std::size_t>::max() ||
      output_bytes > output_bgra.size()) {
    throw std::invalid_argument("screen conversion buffer limit exceeded");
  }

  if (input_width_ != metadata.width || input_height_ != metadata.height ||
      stats_.current_generation != metadata.generation) {
    std::vector<std::uint8_t> replacement(
        static_cast<std::size_t>(input_bytes));
    input_bgra_.swap(replacement);
    input_width_ = metadata.width;
    input_height_ = metadata.height;
    stats_.current_generation = metadata.generation;
    ++stats_.buffer_reconfigurations;
    stats_.input_buffer_bytes = input_bgra_.size();
    stats_.peak_input_buffer_bytes =
        (std::max)(stats_.peak_input_buffer_bytes, input_bgra_.size());
  }

  const auto readback_started = std::chrono::steady_clock::now();
  frame.copyBgraTo(input_bgra_, static_cast<std::size_t>(metadata.width) * 4U);
  const auto readback_finished = std::chrono::steady_clock::now();

  for (std::uint32_t output_y = 0; output_y < output_height; ++output_y) {
    const auto source_y = static_cast<std::uint64_t>(output_y) *
                          metadata.height / output_height;
    for (std::uint32_t output_x = 0; output_x < output_width; ++output_x) {
      const auto source_x = static_cast<std::uint64_t>(output_x) *
                            metadata.width / output_width;
      const auto* source =
          input_bgra_.data() +
          (source_y * metadata.width + source_x) * 4ULL;
      auto* destination =
          output_bgra.data() +
          (static_cast<std::uint64_t>(output_y) * output_width + output_x) *
              4ULL;
      std::memcpy(destination, source, 4);
    }
  }
  const auto captured_at_ms = captureTimestampEpochMilliseconds(
      metadata.capture_timestamp_100ns);
  writeScreenFrameMarker(output_bgra,
                         static_cast<std::size_t>(output_width) * 4,
                         metadata.sequence, captured_at_ms,
                         metadata.generation, metadata.width,
                         metadata.height);
  const auto converted = std::chrono::steady_clock::now();
  ++stats_.converted;
  const auto age_100ns =
      (std::max)(screenSteadyTimestamp100ns() -
                     metadata.capture_timestamp_100ns,
                 std::int64_t{0});
  return ScreenConversionResult{
      metadata,
      captured_at_ms,
      static_cast<std::uint64_t>(age_100ns / 10'000),
      static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::microseconds>(
              readback_finished - readback_started)
              .count()),
      static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::microseconds>(
              converted - readback_finished)
              .count())};
}

CpuScreenConverterStats CpuScreenConverter::stats() const noexcept {
  return stats_;
}

}  // namespace syrnike::windows_media::screen
