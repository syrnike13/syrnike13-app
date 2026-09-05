#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <thread>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"
#include "screen/hardware_h264_capability.hpp"

namespace syrnike::windows_media::screen {

inline constexpr std::size_t kEncodedH264SlotCapacity = 3;
inline constexpr std::size_t kEncodedH264SlotBytes = 2 * 1024 * 1024;

enum class HardwareH264EncoderState {
  idle,
  starting,
  running,
  draining,
  stopped,
  failed,
};

struct HardwareH264EncoderStats {
  std::uint64_t submitted = 0;
  std::uint64_t input_superseded = 0;
  std::uint64_t encoded = 0;
  std::uint64_t output_superseded = 0;
  std::uint64_t output_pool_exhausted = 0;
  std::uint64_t output_oversized = 0;
  std::uint64_t output_stalls = 0;
  std::uint64_t keyframes = 0;
  std::uint64_t encoded_bytes = 0;
  std::size_t input_slots_in_use = 0;
  std::size_t output_slots_in_use = 0;
  std::size_t output_pool_capacity = kEncodedH264SlotCapacity;
  std::size_t maximum_output_slots_in_use = 0;
  std::uint64_t output_pool_bytes =
      kEncodedH264SlotCapacity * kEncodedH264SlotBytes;
};

struct EncodedH264FrameView {
  std::span<const std::byte> bytes;
  std::int64_t timestamp_us = 0;
  std::int64_t duration_us = 0;
  bool keyframe = false;
  std::uint64_t sequence = 0;
};

namespace detail {
struct HardwareH264EncoderStateData;
}

class EncodedH264SlotLease final {
 public:
  EncodedH264SlotLease() = default;
  ~EncodedH264SlotLease();
  EncodedH264SlotLease(EncodedH264SlotLease&& other) noexcept;
  EncodedH264SlotLease& operator=(EncodedH264SlotLease&& other) noexcept;
  EncodedH264SlotLease(const EncodedH264SlotLease&) = delete;
  EncodedH264SlotLease& operator=(const EncodedH264SlotLease&) = delete;

  explicit operator bool() const noexcept;
  [[nodiscard]] std::uint32_t slot() const noexcept;
  [[nodiscard]] EncodedH264FrameView frame() const noexcept;
  void release() noexcept;

 private:
  EncodedH264SlotLease(
      std::shared_ptr<detail::HardwareH264EncoderStateData> state,
      std::uint32_t slot);
  std::shared_ptr<detail::HardwareH264EncoderStateData> state_;
  std::uint32_t slot_ = 0;
  friend class HardwareH264Encoder;
};

// Owns one strict hardware Media Foundation H.264 transform. Input is a
// latest-wins slot; encoded output uses a fixed pool and is returned by lease.
// All Media Foundation calls stay on the encoder worker thread.
class HardwareH264Encoder final {
 public:
  HardwareH264Encoder(
      std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
      ScreenVideoProfile profile);
  ~HardwareH264Encoder();
  HardwareH264Encoder(const HardwareH264Encoder&) = delete;
  HardwareH264Encoder& operator=(const HardwareH264Encoder&) = delete;

  [[nodiscard]] std::optional<HardwareH264Failure> start(
      std::chrono::milliseconds deadline);
  [[nodiscard]] bool submit(GpuNv12SlotLease frame,
                            std::int64_t timestamp_us,
                            std::int64_t duration_us);
  [[nodiscard]] std::optional<EncodedH264SlotLease> takeEncoded();
  void requestKeyFrame() noexcept;
  [[nodiscard]] bool stop(std::chrono::milliseconds deadline) noexcept;

  [[nodiscard]] HardwareH264EncoderState state() const noexcept;
  [[nodiscard]] HardwareH264EncoderStats stats() const noexcept;
  [[nodiscard]] std::optional<HardwareH264Failure> failure() const;
  [[nodiscard]] std::string transformName() const;

 private:
  std::shared_ptr<detail::HardwareH264EncoderStateData> state_;
  std::thread worker_;
};

}  // namespace syrnike::windows_media::screen
