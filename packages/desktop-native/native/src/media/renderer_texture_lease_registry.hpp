#pragma once

#include <cstddef>
#include <condition_variable>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "../common/native_message_policy.hpp"

namespace syrnike::desktop_native::media {

struct RendererTextureLeaseFence {
  NativeCommandType event_type = NativeCommandType::Count;
  std::string session_id;
  std::uint64_t media_generation = 0;
  std::string track_id;

  friend bool operator==(
      const RendererTextureLeaseFence&,
      const RendererTextureLeaseFence&) = default;
};

struct RendererTextureLeaseOwner {
  RendererTextureLeaseFence fence;
  std::uint64_t renderer_generation = 0;

  friend bool operator==(
      const RendererTextureLeaseOwner&,
      const RendererTextureLeaseOwner&) = default;
};

struct RendererTextureLeaseStats {
  std::size_t outstanding_leases = 0;
  std::size_t outstanding_generations = 0;
  std::size_t maximum_leases = 0;
  std::size_t maximum_leases_per_generation = 0;
  std::size_t maximum_generations_per_stream = 0;
};

enum class RendererTextureLeaseRetainStatus : std::uint8_t {
  Retained,
  InvalidOwner,
  ProcessCapacity,
  GenerationCapacity,
  StreamGenerationCapacity,
  SequenceExhausted,
};

struct RendererTextureLeaseRetainResult {
  RendererTextureLeaseRetainStatus status =
      RendererTextureLeaseRetainStatus::InvalidOwner;
  std::uint64_t sequence = 0;
  std::size_t generation_leases = 0;
  std::size_t remaining_in_generation = 0;

  [[nodiscard]] bool retained() const noexcept {
    return status == RendererTextureLeaseRetainStatus::Retained;
  }
};

struct RendererTextureLeaseWakeObservation {
  std::uint64_t revision = 0;
  bool changed = false;
  bool closed = false;
};

// A renderer generation and its registry entries share this small wake state.
// Release never calls back into the bridge or retains a TrackWorker. Closing a
// retiring worker makes every late exact fence inert while keeping this state
// alive until the registry releases its final entry.
class RendererTextureLeaseWakeState final {
 public:
  [[nodiscard]] std::uint64_t revision() const noexcept {
    std::lock_guard lock(mutex_);
    return revision_;
  }

  [[nodiscard]] RendererTextureLeaseWakeObservation waitForChange(
      std::uint64_t observed_revision) noexcept {
    std::unique_lock lock(mutex_);
    changed_.wait(lock, [&] {
      return closed_ || revision_ != observed_revision;
    });
    return RendererTextureLeaseWakeObservation{
        revision_, revision_ != observed_revision, closed_};
  }

  void close() noexcept {
    {
      std::lock_guard lock(mutex_);
      if (closed_) return;
      closed_ = true;
    }
    changed_.notify_all();
  }

 private:
  friend class RendererTextureLeaseRegistry;

  void notifyReleased() noexcept {
    {
      std::lock_guard lock(mutex_);
      if (closed_) return;
      ++revision_;
    }
    changed_.notify_all();
  }

  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::uint64_t revision_ = 0;
  bool closed_ = false;
};

// Process-wide ownership for textures delivered through Electron. A native
// resource leaves this registry only after the exact event, session, media
// generation, track, and renderer sequence are acknowledged. Each stream may
// retain three leases in its active renderer generation plus one bounded
// three-lease replacement generation; the process admits at most 64 leases.
// Capacity limits reject new delivery and never evict an unfenced resource.
class RendererTextureLeaseRegistry final {
 public:
  static constexpr std::size_t kMaximumLeases = 64;
  static constexpr std::size_t kMaximumLeasesPerGeneration = 3;
  static constexpr std::size_t kMaximumGenerationsPerStream = 2;

  explicit RendererTextureLeaseRegistry(
      std::size_t maximum_leases = kMaximumLeases,
      std::size_t maximum_leases_per_generation =
          kMaximumLeasesPerGeneration,
      std::size_t maximum_generations_per_stream =
          kMaximumGenerationsPerStream)
      : maximum_leases_(maximum_leases),
        maximum_leases_per_generation_(maximum_leases_per_generation),
        maximum_generations_per_stream_(maximum_generations_per_stream) {
    if (maximum_leases_ == 0 || maximum_leases_per_generation_ == 0 ||
        maximum_generations_per_stream_ == 0) {
      throw std::invalid_argument(
          "renderer texture lease limits must be positive");
    }
  }

  [[nodiscard]] std::uint64_t beginGeneration() {
    std::lock_guard lock(mutex_);
    if (next_generation_ ==
        (std::numeric_limits<std::uint64_t>::max)()) {
      throw std::overflow_error("renderer texture generation exhausted");
    }
    return ++next_generation_;
  }

  [[nodiscard]] RendererTextureLeaseRetainResult tryRetain(
      const RendererTextureLeaseOwner& owner,
      std::shared_ptr<void> resource,
      std::shared_ptr<RendererTextureLeaseWakeState> wake_state = {}) {
    if (!isValidNativeCommandType(owner.fence.event_type) ||
        owner.fence.session_id.empty() ||
        owner.fence.track_id.empty() || owner.renderer_generation == 0 ||
        !resource) {
      return {
          .status = RendererTextureLeaseRetainStatus::InvalidOwner,
      };
    }

    std::lock_guard lock(mutex_);
    if (entries_.size() >= maximum_leases_) {
      return {
          .status = RendererTextureLeaseRetainStatus::ProcessCapacity,
      };
    }
    if (next_sequence_ == (std::numeric_limits<std::uint64_t>::max)()) {
      return {
          .status = RendererTextureLeaseRetainStatus::SequenceExhausted,
      };
    }

    std::size_t owner_leases = 0;
    std::vector<std::uint64_t> stream_generations;
    for (const auto& [_, entry] : entries_) {
      if (entry.owner.fence != owner.fence) continue;
      if (entry.owner.renderer_generation == owner.renderer_generation) {
        ++owner_leases;
      }
      bool generation_seen = false;
      for (const auto generation : stream_generations) {
        if (generation == entry.owner.renderer_generation) {
          generation_seen = true;
          break;
        }
      }
      if (!generation_seen) {
        stream_generations.push_back(entry.owner.renderer_generation);
      }
    }
    if (owner_leases >= maximum_leases_per_generation_) {
      return {
          .status = RendererTextureLeaseRetainStatus::GenerationCapacity,
          .generation_leases = owner_leases,
      };
    }
    bool owner_generation_seen = false;
    for (const auto generation : stream_generations) {
      if (generation == owner.renderer_generation) {
        owner_generation_seen = true;
        break;
      }
    }
    if (!owner_generation_seen &&
        stream_generations.size() >= maximum_generations_per_stream_) {
      return {
          .status = RendererTextureLeaseRetainStatus::StreamGenerationCapacity,
      };
    }

    const auto sequence = ++next_sequence_;
    entries_.emplace(
        sequence,
        Entry{owner, std::move(resource), std::move(wake_state)});
    const auto generation_leases = owner_leases + 1;
    return {
        .status = RendererTextureLeaseRetainStatus::Retained,
        .sequence = sequence,
        .generation_leases = generation_leases,
        .remaining_in_generation =
            maximum_leases_per_generation_ - generation_leases,
    };
  }

  [[nodiscard]] bool generationHasCapacity(
      const RendererTextureLeaseOwner& owner) const noexcept {
    std::lock_guard lock(mutex_);
    std::size_t owner_leases = 0;
    for (const auto& [_, entry] : entries_) {
      if (entry.owner == owner) ++owner_leases;
    }
    return owner_leases < maximum_leases_per_generation_;
  }

  bool release(
      const RendererTextureLeaseFence& fence,
      std::uint64_t sequence) noexcept {
    return releaseMatching(sequence, [&fence](const Entry& entry) {
      return entry.owner.fence == fence;
    });
  }

  // Internal drop callbacks already capture the globally unique sequence that
  // was retained. External renderer acknowledgements must use release(fence)
  // so a stale media generation cannot authorize a newer lease.
  bool releaseExact(
      const std::string& track_id,
      std::uint64_t sequence) noexcept {
    return releaseMatching(sequence, [&track_id](const Entry& entry) {
      return entry.owner.fence.track_id == track_id;
    });
  }

  [[nodiscard]] RendererTextureLeaseStats stats() const {
    std::lock_guard lock(mutex_);
    std::vector<RendererTextureLeaseOwner> generations;
    generations.reserve(entries_.size());
    for (const auto& [_, entry] : entries_) {
      bool seen = false;
      for (const auto& owner : generations) {
        if (owner == entry.owner) {
          seen = true;
          break;
        }
      }
      if (!seen) generations.push_back(entry.owner);
    }
    return RendererTextureLeaseStats{
        entries_.size(),
        generations.size(),
        maximum_leases_,
        maximum_leases_per_generation_,
        maximum_generations_per_stream_,
    };
  }

 private:
  struct Entry {
    RendererTextureLeaseOwner owner;
    std::shared_ptr<void> resource;
    std::shared_ptr<RendererTextureLeaseWakeState> wake_state;
  };

  template <typename Matches>
  bool releaseMatching(
      std::uint64_t sequence,
      Matches&& matches) noexcept {
    std::shared_ptr<void> resource;
    std::shared_ptr<RendererTextureLeaseWakeState> wake_state;
    {
      std::lock_guard lock(mutex_);
      const auto found = entries_.find(sequence);
      if (found == entries_.end() || !matches(found->second)) {
        return false;
      }
      resource = std::move(found->second.resource);
      wake_state = std::move(found->second.wake_state);
      entries_.erase(found);
    }
    resource.reset();
    if (wake_state) wake_state->notifyReleased();
    return true;
  }

  const std::size_t maximum_leases_;
  const std::size_t maximum_leases_per_generation_;
  const std::size_t maximum_generations_per_stream_;
  mutable std::mutex mutex_;
  std::uint64_t next_generation_ = 0;
  std::uint64_t next_sequence_ = 0;
  std::unordered_map<std::uint64_t, Entry> entries_;
};

inline RendererTextureLeaseRegistry& rendererTextureLeaseRegistry() {
  static RendererTextureLeaseRegistry registry;
  return registry;
}

inline bool releaseRendererTextureLease(
    const RendererTextureLeaseFence& fence,
    std::uint64_t sequence) noexcept {
  return rendererTextureLeaseRegistry().release(fence, sequence);
}

inline bool releaseRendererTextureLeaseExact(
    const std::string& track_id,
    std::uint64_t sequence) noexcept {
  return rendererTextureLeaseRegistry().releaseExact(track_id, sequence);
}

inline RendererTextureLeaseStats rendererTextureLeaseStats() {
  return rendererTextureLeaseRegistry().stats();
}

}  // namespace syrnike::desktop_native::media
