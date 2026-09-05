#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"
#include "screen/hardware_h264_encoder.hpp"
#include "screen/production_screen_sender.hpp"
#include "screen/screen_frame_pipeline.hpp"

namespace syrnike::windows_media::screen {

enum class ProductionScreenPipelineState {
  idle,
  starting,
  running,
  stopping,
  stopped,
  failed,
};

struct ProductionScreenMemoryBudget {
  std::uint64_t capture_texture_bytes = 0;
  std::uint64_t conversion_texture_bytes = 0;
  std::uint64_t encoded_output_bytes = 0;
  std::uint64_t total_bytes = 0;
};

struct ProductionScreenPipelineStats {
  capture::D3d11AdapterLuid adapter_luid;
  std::uint64_t capture_frames = 0;
  std::uint64_t frame_rate_drops = 0;
  std::uint64_t missing_gpu_frames = 0;
  std::uint64_t conversion_drops = 0;
  std::uint64_t encoder_rejections = 0;
  std::uint64_t publication_rejections = 0;
  std::uint64_t slot_releases = 0;
  std::uint64_t capture_age_last_us = 0;
  std::uint64_t capture_age_max_us = 0;
  std::string encoder_implementation;
  ScreenFramePipelineStats capture;
  GpuScreenConverterStats converter;
  HardwareH264EncoderStats encoder;
  ProductionScreenSenderStats sender;
  ProductionScreenMemoryBudget memory;
};

using ScreenPublicationAdapterFactory = std::function<
    std::shared_ptr<ScreenPublicationAdapter>(
        const std::shared_ptr<HardwareH264Encoder>&)>;

// Coordinates the GPU-native path without owning Room. The adapter factory is
// given the encoder only to wire key-frame/rate-control callbacks.
class ProductionScreenPipeline final {
 public:
  ProductionScreenPipeline(
      std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
      std::shared_ptr<ScreenFramePipeline> capture_pipeline,
      ScreenVideoProfile profile,
      ScreenPublicationAdapterFactory adapter_factory,
      ScreenPublicationDeadlines publication_deadlines = {});
  ~ProductionScreenPipeline();
  ProductionScreenPipeline(const ProductionScreenPipeline&) = delete;
  ProductionScreenPipeline& operator=(const ProductionScreenPipeline&) =
      delete;

  [[nodiscard]] ScreenStartResult start(std::string track_name,
                                        std::chrono::milliseconds deadline);
  [[nodiscard]] ScreenCommandResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept;
  [[nodiscard]] ProductionScreenPipelineState state() const noexcept;
  [[nodiscard]] ProductionScreenPipelineStats stats() const noexcept;
  [[nodiscard]] std::optional<ScreenPublicationFailure> failure() const;

 private:
  void run() noexcept;
  void handleEvent(ScreenPublicationEvent event) noexcept;

  std::shared_ptr<capture::D3d11DeviceOwner> device_owner_;
  std::shared_ptr<ScreenFramePipeline> capture_pipeline_;
  ScreenVideoProfile profile_;
  GpuScreenConverter converter_;
  std::shared_ptr<HardwareH264Encoder> encoder_;
  std::unique_ptr<ProductionScreenSender> sender_;
  mutable std::mutex mutex_;
  ProductionScreenPipelineState state_ = ProductionScreenPipelineState::idle;
  ProductionScreenPipelineStats stats_;
  std::optional<ScreenPublicationFailure> failure_;
  std::array<std::optional<EncodedH264SlotLease>,
             kEncodedH264SlotCapacity>
      submitted_slots_;
  std::uint64_t generation_ = 0;
  std::int64_t last_encoder_timestamp_us_ = 0;
  bool published_ = false;
  bool stop_requested_ = false;
  std::thread worker_;
};

}  // namespace syrnike::windows_media::screen
