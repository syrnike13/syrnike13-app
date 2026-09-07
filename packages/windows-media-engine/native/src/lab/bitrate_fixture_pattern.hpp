#pragma once
#include <cstdint>
#include <vector>
namespace syrnike::windows_media::lab {
// Deterministic moving tiled image, shared by the MFT probe and WGC fixture.
// Spatial blocks keep this a compressible scene rather than pixel white noise.
inline std::vector<std::uint32_t> bitrateFixturePattern(std::uint32_t phase,
    std::uint32_t width = 1920, std::uint32_t height = 1080) {
  std::vector<std::uint32_t> pixels(static_cast<std::size_t>(width) * height);
  for (std::uint32_t y = 0; y < height; ++y)
    for (std::uint32_t x = 0; x < width; ++x) {
      const auto value = (((x + phase * 8) / 32) * 2654435761U) ^ ((y / 32) * 2246822519U);
      pixels[static_cast<std::size_t>(y) * width + x] = 0xff000000U | (value & 0xffffffU);
    }
  return pixels;
}
}
