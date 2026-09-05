#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

namespace syrnike::windows_media::screen {

inline constexpr std::uint16_t kScreenMarkerMagic = 0x534d;
inline constexpr std::size_t kScreenMarkerBits = 144;
inline constexpr std::size_t kScreenMarkerColumns = 24;
inline constexpr std::size_t kScreenMarkerRows = 6;
inline constexpr std::size_t kScreenMarkerTileSize = 12;
inline constexpr std::size_t kScreenMarkerWidth =
    kScreenMarkerColumns * kScreenMarkerTileSize;
inline constexpr std::size_t kScreenMarkerHeight =
    kScreenMarkerRows * kScreenMarkerTileSize;
inline constexpr std::size_t kScreenMarkerBgraBytes =
    kScreenMarkerWidth * kScreenMarkerHeight * 4;

void writeScreenFrameMarker(std::span<std::uint8_t> output_bgra,
                            std::size_t output_stride,
                            std::uint64_t sequence,
                            std::uint64_t captured_at_ms,
                            std::uint64_t generation,
                            std::uint32_t source_width,
                            std::uint32_t source_height);

}  // namespace syrnike::windows_media::screen
