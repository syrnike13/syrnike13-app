#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
#include <unordered_map>

#include "native_message_policy.hpp"

namespace syrnike::desktop_native {

struct NativeError {
  std::string code;
  std::string message;
  std::string stage;
  bool retryable = false;
  std::string session_id;
  std::optional<std::uint64_t> generation;
  std::optional<std::int64_t> hresult;
};

struct DeviceInfo {
  std::string device_id;
  std::string label;
  std::string kind;
  bool is_default = false;
};

struct DisplaySourceInfo {
  std::string id;
  std::string name;
  std::string source_type;
  std::uint64_t native_handle = 0;
  std::uint32_t process_id = 0;
  std::optional<std::string> thumbnail_data_url;
  std::optional<std::string> app_icon_data_url;
  std::optional<std::string> process_path;
  std::string classification;
  bool audio_available = false;
  std::string audio_mode = "none";
};

struct InputEvent {
  std::string event_type;
  std::string source;
  std::string code;
  std::string label;
  std::vector<std::string> pressed_codes;
};

struct Rect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  bool operator==(const Rect&) const = default;
};

struct ForegroundWindow {
  std::uint32_t process_id = 0;
  std::string process_name;
  std::optional<std::string> process_path;
  std::string title;
  std::string class_name;
  bool visible = false;
  bool fullscreen_like = false;
  Rect bounds;

  bool operator==(const ForegroundWindow&) const = default;
};

struct VoiceRtcTransportTelemetry {
  bool available = false;
  double available_outgoing_bitrate = 0.0;
  double available_incoming_bitrate = 0.0;
  double ping_ms = 0.0;
  std::string local_address;
  std::string remote_address;
  std::uint64_t bytes_sent = 0;
  std::uint64_t bytes_received = 0;
  std::uint64_t packets_sent = 0;
  std::uint64_t packets_received = 0;
  std::string selected_candidate_pair_id;
};

struct VoiceRtcStreamTelemetry {
  std::string id;
  std::string pc_role;
  std::string kind;
  std::uint32_t ssrc = 0;
  std::string mid;
  std::string track_identifier;
  std::string codec;
  double target_bitrate = 0.0;
  std::uint64_t bytes_sent = 0;
  std::uint64_t bytes_received = 0;
  std::uint64_t packets_sent = 0;
  std::uint64_t packets_received = 0;
  std::int64_t packets_lost = 0;
  double packet_loss_percent = 0.0;
  double round_trip_time_ms = 0.0;
  bool has_remote_inbound = false;
  std::uint64_t retransmitted_packets_sent = 0;
  std::uint64_t retransmitted_bytes_sent = 0;
  std::uint64_t retransmitted_packets_received = 0;
  std::uint64_t retransmitted_bytes_received = 0;
  std::uint64_t packets_discarded = 0;
  std::uint32_t nack_count = 0;
  std::uint32_t fir_count = 0;
  std::uint32_t pli_count = 0;
  std::uint32_t frames_sent = 0;
  std::uint64_t frames_received = 0;
  std::uint32_t frames_rendered = 0;
  std::uint32_t frames_encoded = 0;
  std::uint32_t frames_decoded = 0;
  std::uint32_t frames_dropped = 0;
  double frames_per_second = 0.0;
  std::uint32_t frame_width = 0;
  std::uint32_t frame_height = 0;
  std::string quality_limitation_reason;
  double audio_level = 0.0;
  double total_audio_energy = 0.0;
  double total_samples_duration = 0.0;
  std::uint64_t total_samples_received = 0;
  std::uint64_t concealed_samples = 0;
  std::uint64_t silent_concealed_samples = 0;
  std::uint64_t concealment_events = 0;
  double jitter_buffer_delay = 0.0;
  double jitter_buffer_target_delay = 0.0;
  std::uint64_t jitter_buffer_emitted_count = 0;
  double jitter = 0.0;
  std::uint32_t freeze_count = 0;
  double total_freeze_duration = 0.0;
  std::uint32_t pause_count = 0;
  double total_pause_duration = 0.0;
  std::string encoder_implementation;
  std::string decoder_implementation;
};

struct RuntimeEvent {
  NativeEventType type = NativeEventType::Count;
  std::uint64_t sequence = 0;
  std::string request_id;
  std::string session_id;
  std::uint64_t generation = 0;
  std::optional<std::uint64_t> revision;
  std::string kind;
  std::string status;
  std::string state;
  std::string detail;
  bool ok = true;
  std::optional<NativeError> error;
  std::vector<DeviceInfo> devices;
  std::vector<DisplaySourceInfo> sources;
  std::vector<std::string> participant_identities;
  VoiceRtcTransportTelemetry voice_rtc_transport;
  std::vector<VoiceRtcStreamTelemetry> voice_rtc_outbound;
  std::vector<VoiceRtcStreamTelemetry> voice_rtc_inbound;
  std::optional<InputEvent> input;
  std::optional<ForegroundWindow> foreground_window;
  double input_db = -120.0;
  double threshold_db = -28.0;
  bool gate_open = false;
  std::uint64_t frames = 0;
  std::uint64_t packets = 0;
  std::uint64_t audio_frames = 0;
  std::uint64_t audio_packets = 0;
  std::uint64_t audio_backlog_packets = 0;
  std::uint64_t audio_discontinuities = 0;
  double audio_peak_db = -120.0;
  double audio_rms_db = -120.0;
  std::string device_id;
  int width = 0;
  int height = 0;
  int fps = 0;
  int bitrate = 0;
  std::string native_participant_identity;
  std::string capture_method;
  std::string reason;
  std::string error_code;
  std::optional<std::int64_t> hresult;
  std::uint64_t voice_control_host_epoch = 0;
  std::uint64_t voice_control_queue_depth = 0;
  std::uint64_t voice_control_queue_capacity = 0;
  std::uint64_t voice_control_oldest_queue_wait_ms = 0;
  std::uint64_t voice_control_last_queue_wait_ms = 0;
  std::string voice_control_current_operation;
  std::uint64_t voice_control_current_operation_age_ms = 0;
  std::uint64_t voice_control_duplicate_commands = 0;
  std::uint64_t voice_control_rejected_commands = 0;
  std::string voice_control_worker_state;
  std::string voice_control_retirement_state;
  std::uint64_t voice_control_outstanding_renderer_leases = 0;
  std::uint64_t voice_control_outstanding_renderer_generations = 0;
  std::string voice_control_worker_owner;
  std::string voice_control_retirement_owner;
  std::string audio_mode;
  std::string loopback_mode;
  std::uint32_t audio_target_process_id = 0;
  std::string noise_suppression = "disabled";
  std::string echo_cancellation = "disabled";
  std::uint64_t method_wgc_gpu = 0;
  std::uint64_t method_dxgi_gpu = 0;
  std::uint64_t video_recoverable_lost_count = 0;
  std::uint64_t video_gpu_pool_slots_available = 0;
  std::uint64_t video_gpu_pool_slots_total = 0;
  std::uint64_t video_dxgi_duplication_hold_us_max = 0;
  std::uint64_t video_source_updates = 0;
  std::uint64_t video_gpu_submissions = 0;
  std::uint64_t video_idle_refreshes = 0;
  std::uint64_t video_coalesced_source_updates = 0;
  std::uint64_t video_encoder_backpressure_ticks = 0;
  std::uint64_t video_superseded_ready_frames = 0;
  std::uint64_t video_gpu_slot_timeouts = 0;
  std::uint64_t video_gpu_slots_recovered = 0;
  std::uint64_t video_gpu_frames_dropped_stale = 0;
  std::uint64_t video_gpu_pool_rollovers = 0;
  std::uint64_t video_gpu_rollovers_blocked = 0;
  std::uint64_t video_gpu_retired_generations = 0;
  std::uint64_t video_gpu_slots_quarantined = 0;
  std::uint64_t video_preview_bridge_submissions = 0;
  std::uint64_t video_preview_bridge_acquires = 0;
  std::uint64_t video_preview_bridge_timeouts = 0;
  std::uint64_t video_preview_bridge_slots_recovered = 0;
  std::uint64_t video_preview_gpu_submissions = 0;
  std::uint64_t video_preview_frames_completed = 0;
  std::uint64_t video_preview_slot_timeouts = 0;
  std::uint64_t video_preview_frames_dropped_stale = 0;
  std::uint64_t video_preview_device_resets = 0;
  std::uint64_t video_gpu_completion_p50_us = 0;
  std::uint64_t video_gpu_completion_p95_us = 0;
  std::uint64_t video_gpu_completion_max_us = 0;
  bool rtp_stats_available = false;
  std::uint64_t rtp_packets_sent = 0;
  std::uint64_t rtp_bytes_sent = 0;
  std::uint64_t rtp_frames_sent = 0;
  std::uint64_t rtp_frames_encoded = 0;
  std::string encoder_implementation;
  std::string track_id;
  std::string participant_identity;
  std::string video_source;
  std::uint64_t frame_sequence = 0;
  std::uint64_t timestamp_us = 0;
  std::uint64_t source_timestamp_us = 0;
  std::uint32_t source_frame_id = 0;
  std::uint64_t nt_handle = 0;
  // Media events may own resources in the utility process until Electron
  // accepts the event. A lossy event sink invokes this synchronously when it
  // drops the event before JS can release the resource.
  std::function<void()> on_drop;
};

enum class NativeTerminalProducer : std::uint8_t {
  VoiceRoom,
  MicrophoneCapture,
  MicrophonePublication,
  ScreenCapture,
  ScreenAudio,
  CameraCapture,
  Count,
};

class NativeTerminalIncarnationFence final {
 public:
  bool registerCurrent(
    NativeTerminalProducer producer,
    std::uint64_t incarnation
  ) noexcept {
    if (producer == NativeTerminalProducer::Count || incarnation == 0) {
      return false;
    }
    auto& current = current_[static_cast<std::size_t>(producer)];
    auto observed = current.load(std::memory_order_acquire);
    while (observed < incarnation) {
      if (current.compare_exchange_weak(
            observed,
            incarnation,
            std::memory_order_release,
            std::memory_order_acquire
          )) {
        return true;
      }
    }
    return observed == incarnation;
  }

  bool isCurrent(
    NativeTerminalProducer producer,
    std::uint64_t incarnation
  ) const noexcept {
    if (producer == NativeTerminalProducer::Count || incarnation == 0) {
      return false;
    }
    return current_[static_cast<std::size_t>(producer)].load(
      std::memory_order_acquire
    ) == incarnation;
  }

 private:
  std::array<
    std::atomic<std::uint64_t>,
    static_cast<std::size_t>(NativeTerminalProducer::Count)>
    current_{};
};

class NativeTerminalIncarnationCandidate final {
 public:
  NativeTerminalIncarnationCandidate(
    NativeTerminalIncarnationFence& fence,
    NativeTerminalProducer producer,
    std::uint64_t incarnation
  ) noexcept
    : fence_(&fence), producer_(producer), incarnation_(incarnation) {}

  [[nodiscard]] std::uint64_t incarnation() const noexcept {
    return incarnation_;
  }

  bool publish() noexcept {
    return fence_ && fence_->registerCurrent(producer_, incarnation_);
  }

 private:
  NativeTerminalIncarnationFence* fence_;
  NativeTerminalProducer producer_;
  std::uint64_t incarnation_;
};

inline NativeTerminalIncarnationFence& terminalIncarnationFence() noexcept {
  static NativeTerminalIncarnationFence fence;
  return fence;
}

// Returns zero after exhaustion instead of wrapping into an incarnation that
// every existing watermark would classify as stale.
inline std::uint64_t claimNextTerminalIncarnation(
  std::atomic<std::uint64_t>& counter
) noexcept {
  auto current = counter.load(std::memory_order_relaxed);
  while (current != (std::numeric_limits<std::uint64_t>::max)()) {
    if (counter.compare_exchange_weak(
          current,
          current + 1,
          std::memory_order_relaxed,
          std::memory_order_relaxed
        )) {
      return current + 1;
    }
  }
  return 0;
}

// Terminal-producing workers receive a process-wide incarnation when they are
// created. Unlike a session generation, this never resets during a runtime and
// lets the accepted-control adapter reject arbitrarily late retired callbacks
// with bounded state.
inline std::uint64_t nextTerminalIncarnation() noexcept {
  static std::atomic<std::uint64_t> counter{0};
  return claimNextTerminalIncarnation(counter);
}

struct MediaCommand {
  MediaCommand() = default;
  MediaCommand(const MediaCommand&) = default;
  MediaCommand& operator=(const MediaCommand&) = default;
  // All dynamic members use standard allocators and transfer ownership on
  // move. Declaring that transfer noexcept lets fixed-capacity native
  // mailboxes move commands without opening an allocation/failure window.
  MediaCommand(MediaCommand&&) noexcept = default;
  MediaCommand& operator=(MediaCommand&&) noexcept = default;

  NativeCommandType type = NativeCommandType::Count;
  std::string request_id;
  std::string transport_lane;
  std::string diagnostic_action_id;
  std::string diagnostic_operation_id;
  std::uint64_t diagnostic_revision = 0;
  std::uint64_t diagnostic_host_epoch = 0;
  std::string session_id;
  std::uint64_t generation = 0;
  std::uint64_t revision = 0;
  std::string device_id;
  std::string device_kind;
  std::string source_id;
  std::string display_source_action;
  std::string display_enumeration_id;
  std::uint64_t display_page = 0;
  std::string livekit_url;
  std::string livekit_token;
  std::string participant_identity;
  int width = 1920;
  int height = 1080;
  int fps = 60;
  int bitrate = 8'000'000;
  int audio_bitrate = 64'000;
  std::uint32_t exclude_process_id = 0;
  std::uint64_t self_window_handle = 0;
  bool audio_requested = false;
  bool noise_suppression = true;
  bool echo_cancellation = false;
  bool bypass_system_audio_input_processing = true;
  bool automatic_gain_control = true;
  float input_volume = 1.0f;
  float output_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
  bool voice_gate_auto_threshold = true;
  bool muted = false;
  bool deafened = false;
  bool has_noise_suppression = false;
  bool has_echo_cancellation = false;
  bool has_bypass_system_audio_input_processing = false;
  bool has_automatic_gain_control = false;
  bool has_input_volume = false;
  bool has_output_volume = false;
  bool has_voice_gate_enabled = false;
  bool has_voice_gate_threshold_db = false;
  bool has_voice_gate_auto_threshold = false;
  bool has_muted = false;
  bool has_deafened = false;
  bool has_revision = false;
  bool force = false;
  bool demanded = true;
  bool terminal = false;
  std::string recovery_mode;
  std::string status;
  std::string internal_message;
  std::vector<std::string> participant_identities;
  VoiceRtcTransportTelemetry voice_rtc_transport;
  std::vector<VoiceRtcStreamTelemetry> voice_rtc_outbound;
  std::vector<VoiceRtcStreamTelemetry> voice_rtc_inbound;
  std::unordered_map<std::string, float> user_volumes;
  std::unordered_map<std::string, bool> user_mutes;
  std::unordered_map<std::string, float> stream_volumes;
  std::unordered_map<std::string, bool> stream_mutes;
  std::uint64_t internal_epoch = 0;
  NativeTerminalProducer terminal_producer = NativeTerminalProducer::Count;
  std::uint64_t terminal_incarnation = 0;
  std::uint64_t internal_enqueued_steady_ms = 0;
  std::uint32_t internal_queue_depth = 0;
  std::string track_id;
  std::string video_source;
  std::uint64_t frame_sequence = 0;
  std::uint64_t timestamp_us = 0;
  std::uint64_t source_timestamp_us = 0;
  std::uint32_t source_frame_id = 0;
  std::uint64_t nt_handle = 0;
  std::uint32_t electron_main_pid = 0;
  std::int64_t diagnostic_hresult = 0;
  std::uint64_t diagnostic_suppressed = 0;
  bool diagnostic_retryable = true;
  // Coalesced native media owns its GPU handle until the actor consumes it.
  // The first native mailbox seam invokes this exactly once when it displaces
  // or discards an accepted frame. A rejected producer post retains ownership.
  std::function<void()> on_drop;
};

// Terminal-producing workers may start before their actor-owned candidate is
// committed. This bounded one-shot gate buffers an early terminal until the
// authoritative owner swap publishes its incarnation, or drops it on rollback.
class NativeTerminalCommitGate final {
 public:
  NativeTerminalCommitGate(
    NativeTerminalIncarnationFence& fence,
    NativeTerminalProducer producer,
    std::uint64_t incarnation
  ) noexcept
    : fence_(&fence), producer_(producer), incarnation_(incarnation) {}

  [[nodiscard]] std::optional<MediaCommand> submit(MediaCommand command) {
    std::lock_guard lock(mutex_);
    if (seen_ || cancelled_) return std::nullopt;
    seen_ = true;
    if (committed_) return std::move(command);
    pending_.emplace(std::move(command));
    return std::nullopt;
  }

  [[nodiscard]] std::optional<MediaCommand> publish() noexcept {
    std::lock_guard lock(mutex_);
    if (cancelled_ || committed_) return std::nullopt;
    fence_->registerCurrent(producer_, incarnation_);
    committed_ = true;
    return std::move(pending_);
  }

  void cancel() noexcept {
    std::lock_guard lock(mutex_);
    cancelled_ = true;
    pending_.reset();
  }

 private:
  NativeTerminalIncarnationFence* fence_;
  NativeTerminalProducer producer_;
  std::uint64_t incarnation_;
  std::mutex mutex_;
  bool committed_ = false;
  bool cancelled_ = false;
  bool seen_ = false;
  std::optional<MediaCommand> pending_;
};

struct HooksCommand {
  NativeCommandType type = NativeCommandType::Count;
  std::string request_id;
};

namespace detail {

struct ExactOnceNativeReleaseState final {
  std::atomic_bool released{false};
  std::function<void()> release;
};

}  // namespace detail

inline std::function<void()> exactOnceNativeRelease(
  std::function<void()> release
) {
  if (!release) {
    throw std::invalid_argument("native resource release callback is required");
  }
  auto state = std::make_shared<detail::ExactOnceNativeReleaseState>();
  state->release = std::move(release);
  return [state = std::move(state)]() noexcept {
    bool expected = false;
    if (!state->released.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel)) {
      return;
    }
    auto release = std::move(state->release);
    try {
      release();
    } catch (...) {
      // Ownership is already retired. A cleanup exception must not enable a
      // second release attempt through another copied queue callback.
    }
  };
}

inline MediaCommand makeNativeResourceCommand(
  NativeCommandType type,
  std::function<void()> release
) {
  if (!isValidNativeCommandType(type)) {
    throw std::invalid_argument("native resource command type is invalid");
  }
  const auto& policy = nativeCommandPolicy(type);
  if (policy.resource_drop != NativeResourceDropPolicy::RequiredExactOnce ||
      policy.owner != NativeMessageOwner::RendererLease) {
    throw std::invalid_argument(
      "native command does not own an exact-once renderer resource"
    );
  }
  MediaCommand command;
  command.type = type;
  command.on_drop = exactOnceNativeRelease(std::move(release));
  return command;
}

inline RuntimeEvent makeNativeResourceEvent(
  NativeEventType type,
  std::function<void()> release
) {
  if (!isValidNativeEventType(type)) {
    throw std::invalid_argument("native resource event type is invalid");
  }
  const auto& policy = nativeEventPolicy(type);
  if (policy.resource_drop != NativeResourceDropPolicy::RequiredExactOnce ||
      policy.owner != NativeMessageOwner::RendererLease) {
    throw std::invalid_argument(
      "native event does not own an exact-once renderer resource"
    );
  }
  RuntimeEvent event;
  event.type = type;
  event.on_drop = exactOnceNativeRelease(std::move(release));
  return event;
}

}  // namespace syrnike::desktop_native
