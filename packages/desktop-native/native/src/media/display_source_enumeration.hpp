#pragma once

#include <algorithm>
#include <cstddef>
#include <functional>
#include <limits>
#include <mutex>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace syrnike::desktop_native::media {

// A native reply retains one visible page plus one metadata-only lookahead.
// Thumbnail pixels are never owned by this container, so 500 sources retain
// the same 25 records as 25 sources.
inline constexpr std::size_t kDisplaySourceMetadataPageSize = 24;
inline constexpr std::size_t kDisplaySourceMetadataReplyBudget =
    kDisplaySourceMetadataPageSize + 1;

template <typename Item>
class DisplaySourceMetadataPage {
 public:
  explicit DisplaySourceMetadataPage(std::size_t page)
      : skip_remaining_(page >
                std::numeric_limits<std::size_t>::max() /
                    kDisplaySourceMetadataPageSize
            ? std::numeric_limits<std::size_t>::max()
            : page * kDisplaySourceMetadataPageSize) {
    items_.reserve(kDisplaySourceMetadataReplyBudget);
  }

  template <typename Factory>
  bool visit(Factory&& factory) {
    if (skip_remaining_ > 0) {
      --skip_remaining_;
      return true;
    }
    if (items_.size() >= kDisplaySourceMetadataReplyBudget) return false;
    items_.push_back(std::invoke(std::forward<Factory>(factory)));
    return items_.size() < kDisplaySourceMetadataReplyBudget;
  }

  const std::vector<Item>& items() const noexcept { return items_; }

  bool hasNextPage() const noexcept {
    return items_.size() > kDisplaySourceMetadataPageSize;
  }

  bool full() const noexcept {
    return items_.size() >= kDisplaySourceMetadataReplyBudget;
  }

  std::vector<Item> release() && { return std::move(items_); }

 private:
  std::size_t skip_remaining_ = 0;
  std::vector<Item> items_;
};

class DisplaySourceEnumerationFence {
 public:
  bool begin(std::string enumeration_id) {
    if (enumeration_id.empty()) return false;
    std::lock_guard lock(mutex_);
    if (shutdown_) return false;
    current_enumeration_id_ = std::move(enumeration_id);
    return true;
  }

  bool isCurrent(std::string_view enumeration_id) const {
    std::lock_guard lock(mutex_);
    return !shutdown_ && !enumeration_id.empty() &&
        current_enumeration_id_ == enumeration_id;
  }

  void cancel(std::string_view enumeration_id) {
    std::lock_guard lock(mutex_);
    if (current_enumeration_id_ == enumeration_id) {
      current_enumeration_id_.clear();
    }
  }

  void shutdown() {
    std::lock_guard lock(mutex_);
    shutdown_ = true;
    current_enumeration_id_.clear();
  }

 private:
  mutable std::mutex mutex_;
  std::string current_enumeration_id_;
  bool shutdown_ = false;
};

}  // namespace syrnike::desktop_native::media
