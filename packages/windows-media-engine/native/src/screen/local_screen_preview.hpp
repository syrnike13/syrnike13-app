#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <mutex>
#include <optional>

#include "capture/monitor_capture.hpp"

namespace syrnike::windows_media::screen {

enum class PreviewState { off, starting, running, degraded, stopped };
const char* previewStateName(PreviewState state) noexcept;

struct PreviewFrame {
  std::uint64_t generation = 0, sequence = 0, revision = 0;
  std::uint64_t publication_generation = 0, source_generation = 0;
  std::uint32_t slot = 0, width = 1280, height = 720;
  std::int64_t timestamp_us = 0;
  std::uintptr_t handle = 0;
};
struct PreviewStats {
  PreviewState state = PreviewState::off;
  bool desired = false, publication_active = false;
  std::uint64_t revision = 0, generation = 0, accepted = 0, delivered = 0;
  std::uint64_t released = 0, pool_drops = 0, pressure_drops = 0;
  std::uint64_t superseded = 0, invalid_releases = 0, failures = 0;
  std::uint64_t backing_bytes = 0, offer_max_us = 0, gpu_max_us = 0;
  std::uint64_t process_budget = 0;
  std::uint32_t last_gpu_result = 0;
  std::uint64_t failure_age_us = 0;
  std::uint32_t outstanding = 0, pending = 0, quarantined = 0;
};

// Process-wide optional partition. Publication and remote receive reservations
// cannot be borrowed by preview, including across publication/renderer epochs.
class LocalScreenPreview final {
 public:
  static constexpr std::size_t kSlots = 2;
  static constexpr std::uint64_t kPublicationReserve = 192ULL << 20;
  static constexpr std::uint64_t kRemoteReserve = 256ULL << 20;
  static constexpr std::uint64_t kPreviewBudget = 8ULL << 20;
  static constexpr std::uint64_t kProcessBudget =
      kPublicationReserve + kRemoteReserve + kPreviewBudget;
  static LocalScreenPreview& processPreview();
  bool beginPublication(std::uint64_t publication_generation);
  void stopPublication();
  // Serialized desired state: stale control messages cannot resurrect preview.
  bool demand(std::uint64_t revision, bool enabled);
  bool setProcessBudget(std::uint64_t bytes);
  // Called only AFTER encoder admission. Never waits for a mutex, GPU fence,
  // renderer, or texture release. Does not retain the source or encoder lease.
  void offer(const capture::D3d11FrameView& frame,
             const capture::FrameMetadata& metadata) noexcept;
  std::optional<PreviewFrame> takeFrame();
  bool release(std::uint64_t generation, std::uint64_t sequence,
               std::uint32_t slot);
  PreviewStats stats() const;

 private:
  enum class SlotState { free, copying, ready, delivered, retired, retiring, quarantined };
  struct Slot {
    SlotState state = SlotState::free;
    PreviewFrame frame;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
    Microsoft::WRL::ComPtr<ID3D11Query> query;
    Microsoft::WRL::ComPtr<IDXGIKeyedMutex> keyed;
    std::chrono::steady_clock::time_point submitted;
  };
  LocalScreenPreview() = default;
  ~LocalScreenPreview();
  void retireLocked();
  void clearLocked(Slot& slot);
  void pollLocked();
  void allocateLocked();
  mutable std::mutex mutex_;
  std::shared_ptr<capture::D3d11DeviceOwner> device_;
  Microsoft::WRL::ComPtr<ID3D11VideoDevice> video_device_;
  Microsoft::WRL::ComPtr<ID3D11VideoContext> video_context_;
  Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
  Microsoft::WRL::ComPtr<ID3D11VideoProcessor> processor_;
  std::uint32_t input_width_ = 0, input_height_ = 0;
  std::array<Slot, kSlots> slots_;
  PreviewStats stats_;
  std::uint64_t publication_generation_ = 0, sequence_ = 0;
  std::atomic_uint64_t contention_drops_{0};
};
}  // namespace syrnike::windows_media::screen
