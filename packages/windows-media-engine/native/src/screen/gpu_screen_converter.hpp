#pragma once

#include <d3d11.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>

#include "capture/monitor_capture.hpp"

namespace syrnike::windows_media::screen {

inline constexpr std::size_t kGpuConversionSlotCapacity = 3;

struct ScreenVideoProfile {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t frames_per_second = 0;
  std::uint32_t bitrate = 0;
};

inline constexpr ScreenVideoProfile kScreenProfile1080p60{
    1920, 1080, 60, 8'000'000};
inline constexpr ScreenVideoProfile kScreenProfile1440p30{
    2560, 1440, 30, 10'000'000};
inline constexpr ScreenVideoProfile kScreenProfile720p30{
    1280, 720, 30, 4'000'000};

struct GpuScreenConverterStats {
  std::uint64_t submitted = 0;
  std::uint64_t converted = 0;
  std::uint64_t pool_exhausted = 0;
  std::uint64_t adapter_mismatches = 0;
  std::uint64_t processor_reconfigurations = 0;
  std::uint64_t gpu_timing_measurements = 0;
  std::uint64_t gpu_timing_unavailable = 0;
  std::size_t gpu_timings_pending = 0;
  std::uint64_t gpu_duration_total_us = 0;
  std::uint64_t gpu_duration_last_us = 0;
  std::uint64_t gpu_duration_max_us = 0;
  std::size_t pool_capacity = kGpuConversionSlotCapacity;
  std::size_t slots_in_use = 0;
  std::size_t maximum_in_use = 0;
  std::uint64_t texture_bytes = 0;
};

namespace detail {
struct GpuScreenConverterState;
}

class GpuNv12SlotLease final {
 public:
  GpuNv12SlotLease() = default;
  ~GpuNv12SlotLease();
  GpuNv12SlotLease(GpuNv12SlotLease&& other) noexcept;
  GpuNv12SlotLease& operator=(GpuNv12SlotLease&& other) noexcept;
  GpuNv12SlotLease(const GpuNv12SlotLease&) = delete;
  GpuNv12SlotLease& operator=(const GpuNv12SlotLease&) = delete;

  explicit operator bool() const noexcept;
  [[nodiscard]] std::uint32_t slot() const noexcept;
  [[nodiscard]] ID3D11Texture2D* texture() const noexcept;
  void release() noexcept;

 private:
  GpuNv12SlotLease(std::shared_ptr<detail::GpuScreenConverterState> state,
                   std::uint32_t slot);
  std::shared_ptr<detail::GpuScreenConverterState> state_;
  std::uint32_t slot_ = 0;
  friend class GpuScreenConverter;
};

// Bounded BGRA-to-NV12 D3D11 VideoProcessor. convert() only enqueues GPU work;
// it never maps, flushes, or waits for completion.
class GpuScreenConverter final {
 public:
  GpuScreenConverter(
      std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
      ScreenVideoProfile profile, bool lab_frame_marker = false);
  ~GpuScreenConverter();
  GpuScreenConverter(const GpuScreenConverter&) = delete;
  GpuScreenConverter& operator=(const GpuScreenConverter&) = delete;

  [[nodiscard]] std::optional<GpuNv12SlotLease> convert(
      const capture::D3d11FrameView& frame,
      const capture::FrameMetadata& metadata);
  [[nodiscard]] ScreenVideoProfile profile() const noexcept;
  [[nodiscard]] GpuScreenConverterStats stats() const noexcept;

 private:
  std::shared_ptr<detail::GpuScreenConverterState> state_;
};

}  // namespace syrnike::windows_media::screen
