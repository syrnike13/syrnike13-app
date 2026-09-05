#include "screen/screen_frame_marker.hpp"

#include <stdexcept>

namespace syrnike::windows_media::screen {
namespace {

bool markerBit(std::uint64_t sequence, std::uint64_t captured_at_ms,
               std::uint64_t generation, std::uint32_t source_width,
               std::uint32_t source_height, std::size_t index) {
  if (index < 16)
    return ((kScreenMarkerMagic >> (15 - index)) & 1U) != 0;
  if (index < 48)
    return ((sequence >> (47 - index)) & 1ULL) != 0;
  if (index < 96)
    return ((captured_at_ms >> (95 - index)) & 1ULL) != 0;
  if (index < 112)
    return ((generation >> (111 - index)) & 1ULL) != 0;
  if (index < 128)
    return ((static_cast<std::uint64_t>(source_width) >> (127 - index)) &
            1ULL) != 0;
  return ((static_cast<std::uint64_t>(source_height) >> (143 - index)) &
          1ULL) != 0;
}

}  // namespace

void writeScreenFrameMarker(std::span<std::uint8_t> output_bgra,
                            std::size_t output_stride,
                            std::uint64_t sequence,
                            std::uint64_t captured_at_ms,
                            std::uint64_t generation,
                            std::uint32_t source_width,
                            std::uint32_t source_height) {
  if (output_stride < kScreenMarkerWidth * 4 ||
      output_bgra.size() < output_stride * kScreenMarkerHeight)
    throw std::invalid_argument("screen marker destination is too small");
  for (std::size_t bit = 0; bit < kScreenMarkerBits; ++bit) {
    const auto column = bit % kScreenMarkerColumns;
    const auto row = bit / kScreenMarkerColumns;
    const std::uint8_t value = markerBit(
                                   sequence, captured_at_ms, generation,
                                   source_width, source_height, bit)
                                   ? 255
                                   : 0;
    for (std::size_t tile_y = 0; tile_y < kScreenMarkerTileSize; ++tile_y) {
      const auto y = row * kScreenMarkerTileSize + tile_y;
      for (std::size_t tile_x = 0; tile_x < kScreenMarkerTileSize; ++tile_x) {
        const auto x = column * kScreenMarkerTileSize + tile_x;
        auto* pixel = output_bgra.data() + y * output_stride + x * 4;
        pixel[0] = value;
        pixel[1] = value;
        pixel[2] = value;
        pixel[3] = 255;
      }
    }
  }
}

}  // namespace syrnike::windows_media::screen
