#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
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
#include "screen/local_screen_preview.hpp"
#include "screen/adaptive_screen_policy.hpp"
#include "screen/screen_keyframe_control.hpp"

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
  PreviewStats preview;
  OutgoingNetworkObservation network;
  std::uint64_t publish_age_last_us = 0;
  std::uint64_t stale_encoded_drops = 0;
  std::uint64_t total_publication_consumed = 0;
  std::uint64_t profile_generation = 1;
  std::uint64_t profile_changes = 0;
  std::uint64_t desired_revision = 0;
  std::uint64_t applied_revision = 0;
  std::uint64_t keyframe_requests = 0;
  std::size_t current_profile = 0;
  bool adaptive_enabled = false;
  bool reconfiguring = false;
  AdaptiveReason decision_reason = AdaptiveReason::healthy;
};

using ScreenPublicationAdapterFactory = std::function<
    std::shared_ptr<ScreenPublicationAdapter>(
        std::function<void()> request_key_frame)>;

// Coordinates the GPU-native path without owning Room. The adapter factory is
// given a bounded keyframe-intent sink, never a mutable encoder handle.
class ProductionScreenPipeline final {
 public:
  ProductionScreenPipeline(
      std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
      std::shared_ptr<ScreenFramePipeline> capture_pipeline,
      ScreenVideoProfile profile,
      ScreenPublicationAdapterFactory adapter_factory,
      ScreenPublicationDeadlines publication_deadlines = {},
      bool lab_frame_marker = false);
  ~ProductionScreenPipeline();
  ProductionScreenPipeline(const ProductionScreenPipeline&) = delete;
  ProductionScreenPipeline& operator=(const ProductionScreenPipeline&) =
      delete;

  [[nodiscard]] ScreenStartResult start(std::string track_name,
                                        std::chrono::milliseconds deadline);
  [[nodiscard]] bool enableAdaptiveQuality(std::uint32_t supported_profiles,
                                           std::size_t user_maximum);
  [[nodiscard]] bool setMaximumQuality(std::uint64_t revision,
                                       std::size_t user_maximum) noexcept;
  [[nodiscard]] ScreenCommandResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept;
  [[nodiscard]] ProductionScreenPipelineState state() const noexcept;
  [[nodiscard]] ProductionScreenPipelineStats stats() const noexcept;
  [[nodiscard]] std::optional<ScreenPublicationFailure> failure() const;

 private:
  void run() noexcept;
  void handleEvent(ScreenPublicationEvent event) noexcept;
  void runAdaptiveControl();
  void reconfigure(std::size_t target_profile, std::uint64_t desired_revision);
  [[nodiscard]] ScreenCommandResult drainGeneration(
      std::chrono::steady_clock::time_point deadline, bool capture_stopped) noexcept;
  void createGeneration(ScreenVideoProfile profile);
  [[nodiscard]] ScreenStartResult startGeneration(std::chrono::milliseconds deadline);

  std::shared_ptr<capture::D3d11DeviceOwner> device_owner_;
  std::shared_ptr<ScreenFramePipeline> capture_pipeline_;
  ScreenVideoProfile profile_;
  std::unique_ptr<GpuScreenConverter> converter_;
  std::shared_ptr<HardwareH264Encoder> encoder_;
  std::shared_ptr<ScreenPublicationAdapter> adapter_;
  std::unique_ptr<ProductionScreenSender> sender_;
  ScreenPublicationAdapterFactory adapter_factory_;
  ScreenPublicationDeadlines publication_deadlines_;
  bool lab_frame_marker_ = false;
  std::string track_name_;
  std::shared_ptr<std::atomic_uint64_t> keyframe_intents_;
  ScreenKeyframeControl keyframes_;
  std::uint32_t supported_profiles_ = 0;
  std::size_t user_maximum_ = 4;
  AdaptivePolicyState policy_state_;
  std::optional<ProductionScreenPipelineStats> previous_policy_stats_;
  std::uint64_t last_policy_ms_ = 0;
  std::uint64_t retired_publication_consumed_ = 0;
  std::uint64_t attempt_revision_ = 0;
  std::chrono::steady_clock::time_point profile_deadline_{};
  mutable std::mutex mutex_;
  ProductionScreenPipelineState state_ = ProductionScreenPipelineState::idle;
  ProductionScreenPipelineStats stats_;
  std::optional<ScreenPublicationFailure> failure_;
  std::array<std::optional<EncodedH264SlotLease>,
             kEncodedH264SlotCapacity>
      submitted_slots_;
  std::uint64_t generation_ = 0;
  std::int64_t last_encoder_timestamp_us_ = 0;
  std::int64_t minimum_capture_timestamp_100ns_ = 0;
  bool published_ = false;
  bool stop_requested_ = false;
  bool worker_done_ = false;
  bool owns_preview_ = false;
  std::condition_variable worker_changed_;
  std::thread worker_;
};

}  // namespace syrnike::windows_media::screen
