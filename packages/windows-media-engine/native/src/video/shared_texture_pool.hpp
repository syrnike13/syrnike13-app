#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <optional>
#include <span>
#include <string>

#include "capture/d3d11_device.hpp"

namespace syrnike::windows_media::video {

enum class SlotState { Free, Delivered, Retired, Quarantined };
struct TextureLease {
  std::uint64_t generation = 0;
  std::uint64_t sequence = 0;
  std::uint32_t slot = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::int64_t timestamp_us = 0;
  std::uintptr_t handle =
      0;  // Utility-local HANDLE. Never sent to the renderer.
  std::int64_t ingress_us = 0;
  std::string publication_id;
  std::string participant_identity;
};
struct PoolSnapshot {
  std::uint64_t generation = 0;
  std::uint64_t accepted = 0;
  std::uint64_t dropped = 0;
  std::uint64_t released = 0;
  std::uint64_t invalid_releases = 0;
  std::uint64_t backing_bytes = 0;
  std::uint32_t delivered = 0;
  std::uint32_t retired = 0;
  std::uint32_t quarantined = 0;
  std::uint32_t retired_generations = 0;
  double oldest_age_ms = 0;
  double release_p50_ms = 0;
  double release_p95_ms = 0;
  double release_max_ms = 0;
  double stalled_ms = 0;
};

// One fixed pool for the entire utility process, including retired owners.
// No timeout or renderer IPC is an authoritative release. Only the Electron
// main allReferencesReleased callback may return a delivered lease.
class SharedTexturePool final {
 public:
  static constexpr std::size_t kSlots = 4;
  static constexpr std::uint64_t kBudget = 256ULL * 1024 * 1024;
  static SharedTexturePool& processPool();
  std::uint64_t beginGeneration();
  void retire(std::uint64_t generation);
  std::optional<TextureLease> upload(std::uint64_t generation,
                                     std::uint32_t width, std::uint32_t height,
                                     std::int64_t timestamp_us,
                                     std::span<const std::uint8_t> bgra,
                                     std::int64_t ingress_us = 0);
  bool release(std::uint64_t generation, std::uint64_t sequence,
               std::uint32_t slot);
  PoolSnapshot snapshot() const;
  std::uint64_t generation() const;

 private:
  struct Slot {
    SlotState state = SlotState::Free;
    TextureLease lease;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
    std::chrono::steady_clock::time_point delivered_at;
  };
  SharedTexturePool() = default;
  ~SharedTexturePool();
  void clear(Slot& slot);
  mutable std::mutex mutex_;
  std::shared_ptr<capture::D3d11DeviceOwner> device_;
  std::array<Slot, kSlots> slots_;
  std::array<std::uint64_t, 16> active_generations_{};
  PoolSnapshot metrics_;
  std::uint64_t sequence_ = 0;
  std::array<double, 1024> release_samples_{};
};
}  // namespace syrnike::windows_media::video
