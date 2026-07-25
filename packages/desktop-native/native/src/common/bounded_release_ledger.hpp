#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <iterator>
#include <list>
#include <string>
#include <unordered_map>
#include <utility>

namespace syrnike::desktop_native {

// Records releases that race frame retirement. Entries are track-scoped and
// bounded, so malformed or duplicate JS releases cannot create an unbounded
// tombstone set or release another track's frame.
class BoundedReleaseLedger final {
 public:
  explicit BoundedReleaseLedger(std::size_t capacity = 4'096)
    : capacity_(capacity) {}

  bool remember(
    std::string track_id,
    std::uint64_t sequence,
    std::uint64_t highest_issued_sequence
  ) {
    if (track_id.empty() || sequence == 0 ||
        sequence > highest_issued_sequence || capacity_ == 0) {
      return false;
    }
    Key key{track_id, sequence};
    if (entries_.contains(key)) return false;
    if (entries_.size() == capacity_) {
      const auto oldest = order_.front();
      entries_.erase(oldest);
      order_.pop_front();
    }
    order_.push_back(key);
    auto order = std::prev(order_.end());
    entries_.emplace(
      std::move(key),
      Entry{order}
    );
    return true;
  }

  bool consume(const std::string& track_id, std::uint64_t sequence) {
    const auto found = entries_.find(Key{track_id, sequence});
    if (found == entries_.end()) return false;
    order_.erase(found->second.order);
    entries_.erase(found);
    return true;
  }

  [[nodiscard]] std::size_t size() const noexcept {
    return entries_.size();
  }

 private:
  struct Key {
    std::string track_id;
    std::uint64_t sequence = 0;

    bool operator==(const Key&) const = default;
  };

  struct KeyHash {
    std::size_t operator()(const Key& key) const noexcept {
      const auto track_hash = std::hash<std::string>{}(key.track_id);
      const auto sequence_hash = std::hash<std::uint64_t>{}(key.sequence);
      return track_hash ^ (
        sequence_hash + 0x9e3779b9u + (track_hash << 6) + (track_hash >> 2)
      );
    }
  };

  struct Entry {
    std::list<Key>::iterator order;
  };

  std::size_t capacity_;
  std::list<Key> order_;
  std::unordered_map<Key, Entry, KeyHash> entries_;
};

}  // namespace syrnike::desktop_native
