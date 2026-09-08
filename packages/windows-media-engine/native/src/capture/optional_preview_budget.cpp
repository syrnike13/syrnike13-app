#include "capture/optional_preview_budget.hpp"

#include <atomic>
#include <exception>

namespace syrnike::windows_media::capture {
namespace { std::atomic_uint64_t backing{0}; }
bool reserveOptionalPreview(std::uint64_t bytes) noexcept {
  auto current = backing.load();
  while (bytes <= kOptionalPreviewBytes && current <= kOptionalPreviewBytes - bytes) {
    if (backing.compare_exchange_weak(current, current + bytes)) return true;
  }
  return false;
}
void releaseOptionalPreview(std::uint64_t bytes) noexcept {
  if (backing.fetch_sub(bytes) < bytes) std::terminate();
}
std::uint64_t optionalPreviewBytes() noexcept { return backing.load(); }
}  // namespace syrnike::windows_media::capture
