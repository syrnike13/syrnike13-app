#pragma once

#include <cstdint>

namespace syrnike::windows_media::capture {
// Shared by screen and camera previews, including retired exported textures.
// Publication and remote receive partitions are never available here.
inline constexpr std::uint64_t kOptionalPreviewBytes = 8ULL << 20;
bool reserveOptionalPreview(std::uint64_t bytes) noexcept;
void releaseOptionalPreview(std::uint64_t bytes) noexcept;
std::uint64_t optionalPreviewBytes() noexcept;
}  // namespace syrnike::windows_media::capture
