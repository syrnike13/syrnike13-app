#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <utility>

namespace syrnike::desktop_native::media {

class GenerationFence {
 public:
  bool advance(const std::string& session_id, std::uint64_t generation) {
    std::lock_guard lock(mutex_);
    if (generation < generation_) return false;
    if (
      generation == generation_ && !session_id_.empty() && session_id_ != session_id
    ) return false;
    session_id_ = session_id;
    generation_ = generation;
    return true;
  }

  void set(const std::string& session_id, std::uint64_t generation) {
    std::lock_guard lock(mutex_);
    session_id_ = session_id;
    generation_ = generation;
  }

  [[nodiscard]] bool isCurrent(
    const std::string& session_id,
    std::uint64_t generation
  ) const {
    std::lock_guard lock(mutex_);
    return session_id_ == session_id && generation_ == generation;
  }

  [[nodiscard]] std::pair<std::string, std::uint64_t> current() const {
    std::lock_guard lock(mutex_);
    return {session_id_, generation_};
  }

  void restoreIfCurrent(
    const std::string& candidate_session,
    std::uint64_t candidate_generation,
    const std::string& previous_session,
    std::uint64_t previous_generation
  ) {
    std::lock_guard lock(mutex_);
    if (session_id_ != candidate_session || generation_ != candidate_generation) return;
    session_id_ = previous_session;
    generation_ = previous_generation;
  }

 private:
  mutable std::mutex mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
};

}  // namespace syrnike::desktop_native::media
