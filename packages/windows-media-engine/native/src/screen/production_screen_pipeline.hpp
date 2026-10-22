#pragma once
#include "screen/screen_frame_cadence.hpp"
#include "screen/screen_encoded_continuity.hpp"

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
  std::uint64_t output_resizes = 0;
  std::uint64_t network_backpressure_drops = 0;
  std::uint64_t missing_gpu_frames = 0;
  std::uint64_t conversion_drops = 0;
  std::uint64_t encoder_rejections = 0;
  std::uint64_t publication_rejections = 0;
  std::uint64_t dependent_encoded_drops = 0;
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
  BitrateUpdateResult bitrate;
  std::uint32_t target_bitrate = 0;
  // What the network allows now and the local-pressure cap (0: none).
  std::uint32_t network_target_bitrate = 0;
  std::uint32_t local_ceiling_bitrate = 0;
  std::uint32_t admitted_fps = 0;
  std::uint64_t bitrate_updates = 0;
  bool quality_warning = false;
};

// Capture admission interval for the policy's frame rate (0: the preset's).
[[nodiscard]] constexpr std::int64_t screenAdmissionIntervalUs(
    std::uint32_t admitted_fps, std::uint32_t preset_fps) noexcept {
  return 1'000'000 / static_cast<std::int64_t>(admitted_fps ? admitted_fps : preset_fps);
}

using ScreenPublicationAdapterFactory = std::function<std::shared_ptr<ScreenPublicationAdapter>(
    std::function<void()> request_key_frame)>;

// The encoded size for a source inside a preset box: the
// source's aspect ratio, never upscaled (a tiny source is scaled to a 320 px
// long side), multiples of 8. The preset's frame rate and bitrate are kept.
[[nodiscard]] ScreenVideoProfile fitScreenOutput(ScreenVideoProfile box, std::uint32_t width,
                                                 std::uint32_t height) noexcept;

// Coordinates the GPU-native path without owning Room. The adapter factory is
// given a bounded keyframe-intent sink, never a mutable encoder handle.
class ProductionScreenPipeline final {
 public:
  ProductionScreenPipeline(std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
                           std::shared_ptr<ScreenFramePipeline> capture_pipeline,
                           ScreenVideoProfile profile,
                           ScreenPublicationAdapterFactory adapter_factory,
                           ScreenPublicationDeadlines publication_deadlines = {},
                           bool lab_frame_marker = false);
  ~ProductionScreenPipeline();
  ProductionScreenPipeline(const ProductionScreenPipeline&) = delete;
  ProductionScreenPipeline& operator=(const ProductionScreenPipeline&) = delete;

  // Before start(): the first capture's size, so the stream starts at its
  // aspect ratio instead of switching on the first frame.
  void setInitialSourceSize(std::uint32_t width, std::uint32_t height);
  // The shared window is minimized or hidden: mute the track, stop repeats.
  void setPaused(bool paused);
  [[nodiscard]] ScreenStartResult start(std::string track_name, std::chrono::milliseconds deadline);
  // Pure admission revocation. Owner-thread stop() still proves full drain.
  void requestStop() noexcept;
  [[nodiscard]] bool enableAdaptiveQuality(std::uint32_t supported_profiles,
                                           std::size_t selected_preset);
  [[nodiscard]] bool setSelectedPreset(std::uint64_t revision, std::size_t selected_preset) noexcept;
  [[nodiscard]] ScreenCommandResult stop(std::chrono::steady_clock::time_point deadline) noexcept;
  [[nodiscard]] ProductionScreenPipelineState state() const noexcept;
  [[nodiscard]] ProductionScreenPipelineStats stats() const noexcept;
  [[nodiscard]] std::optional<ScreenPublicationFailure> failure() const;

 private:
  void run() noexcept;
  void handleEvent(ScreenPublicationEvent event) noexcept;
  void runAdaptiveControl();
  void requestStartBitrate();
  void reconfigure(std::size_t target_profile, std::uint64_t desired_revision);
  [[nodiscard]] ScreenCommandResult drainGeneration(std::chrono::steady_clock::time_point deadline,
                                                    bool capture_stopped) noexcept;
  void createGeneration(ScreenVideoProfile profile);
  [[nodiscard]] ScreenStartResult startGeneration(std::chrono::milliseconds deadline);
  void followSourceSize(std::uint32_t width, std::uint32_t height);
  [[nodiscard]] bool resizeOutput(ScreenVideoProfile output);
  void keepForRepeat(const capture::D3d11FrameView& frame, const capture::FrameMetadata& metadata);
  void repeatLastFrame();

  std::shared_ptr<capture::D3d11DeviceOwner> device_owner_;
  std::shared_ptr<ScreenFramePipeline> capture_pipeline_;
  ScreenVideoProfile profile_;  // The preset box.
  ScreenVideoProfile output_;   // What the encoder currently produces.
  std::uint32_t source_width_ = 0, source_height_ = 0;
  std::optional<ScreenVideoProfile> pending_output_;
  std::chrono::steady_clock::time_point pending_output_since_{};
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
  std::size_t selected_preset_ = 4;
  std::uint64_t bitrate_command_ = 0;
  std::uint64_t bitrate_completed_ = 0;
  // Capture admission rate chosen by the policy; 0 means the preset's.
  std::uint32_t admitted_fps_ = 0;
  // A frame rate waiting for its bitrate command's confirmation.
  struct PendingFrameRate {
    std::uint64_t revision = 0;
    std::uint32_t frame_rate = 0;
  };
  std::optional<PendingFrameRate> pending_fps_;
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
  std::array<std::optional<EncodedH264SlotLease>, kEncodedH264SlotCapacity> submitted_slots_;
  std::uint64_t generation_ = 0;
  ScreenFrameCadence cadence_;
  ScreenEncodedContinuity encoded_continuity_;
  std::int64_t minimum_capture_timestamp_100ns_ = 0;
  // Copy of the newest submitted capture. A static screen produces no new
  // capture frames, so it is re-encoded to keep viewers (and keyframes) alive.
  Microsoft::WRL::ComPtr<ID3D11Texture2D> repeat_texture_;
  capture::FrameMetadata repeat_metadata_;
  std::int64_t last_submit_us_ = 0;
  std::atomic_bool paused_{false};
  bool published_ = false;
  bool stop_requested_ = false;
  std::atomic_bool cancellation_requested_{false};
  bool worker_done_ = false;
  bool owns_preview_ = false;
  std::condition_variable worker_changed_;
  std::thread worker_;
};

}  // namespace syrnike::windows_media::screen
