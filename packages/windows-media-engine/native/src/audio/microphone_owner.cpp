#include "audio/microphone_owner.hpp"
#include "audio/livekit_microphone_dsp.hpp"

#include <windows.h>
#include <charconv>
#include <cstdio>
#include <stdexcept>

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
bool publishes(const MicrophoneIntent& intent, std::optional<std::uint64_t> room) {
  return intent.state == MicrophoneIntentState::on && room.has_value();
}
// A selected device that is missing (unplugged, renamed endpoint, stale
// renderer preference) falls back to the default input with a warning.
AudioDeviceIntent deviceIntent(const MicrophoneIntent& intent, const AudioDeviceRegistry& devices,
                               bool& fallback) {
  fallback = false;
  AudioDeviceIntent device;
  if (!intent.device_id) return device;
  AudioDeviceId id = 0;
  const auto& text = *intent.device_id;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), id);
  if (parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size() && id != 0) {
    device.explicit_id = id;
    if (devices.resolve(device)) return device;
    device.explicit_id.reset();
  }
  fallback = true;
  return device;
}
std::string hresultText(std::int32_t value) {
  char text[16];
  std::snprintf(text, sizeof(text), "0x%08X", static_cast<std::uint32_t>(value));
  return text;
}
EngineFailure inputFailure(MicrophonePipelineFailure failure, const MicrophonePipelineStats& stats) {
  const auto make = [&](const char* code, const char* message) {
    std::string text = message;
    if (stats.candidate_platform_result) text += " (" + hresultText(stats.candidate_platform_result) + ")";
    return EngineFailure{code, std::move(text), "microphone", true};
  };
  if (failure == MicrophonePipelineFailure::input_unavailable)
    return {"microphone_device_unavailable", "No microphone input device is available", "microphone", true};
  if (failure != MicrophonePipelineFailure::capture_failed)
    return make("microphone_input_failed", "Microphone input transaction failed");
  switch (stats.candidate_failure) {
    case MicrophoneCaptureFailure::activation_failed:
      return stats.candidate_platform_result == E_ACCESSDENIED
          ? make("microphone_access_denied", "Windows denied microphone access")
          : make("microphone_activation_failed", "Microphone device could not be opened");
    case MicrophoneCaptureFailure::format_unavailable:
      return make("microphone_format_unavailable", "Microphone device rejected the capture format");
    case MicrophoneCaptureFailure::policy_unavailable:
      return make("microphone_policy_unavailable", "Microphone device rejected the stream configuration");
    case MicrophoneCaptureFailure::device_lost:
      return make("microphone_device_lost", "Microphone device is no longer available");
    case MicrophoneCaptureFailure::no_progress:
    case MicrophoneCaptureFailure::start_timeout:
      return make("microphone_no_signal", "Microphone device did not deliver audio");
    default:
      return make("microphone_input_failed", "Microphone input transaction failed");
  }
}
MicrophoneDspConfig dspConfig(const MicrophoneIntent& value) {
  return {
      .input_volume = static_cast<float>(value.input_volume),
      .gate_threshold_db = static_cast<float>(value.gate_threshold_db),
      .automatic_threshold = value.gate_auto_threshold,
      .noise_suppression = value.noise_suppression,
      .echo_cancellation = value.echo_cancellation,
      .automatic_gain = value.automatic_gain_control,
      .gate_enabled = value.gate_enabled,
      .muted = value.muted,
      .push_to_talk = value.push_to_talk,
      .push_to_talk_pressed = value.push_to_talk_held,
  };
}
}  // namespace

MicrophoneOwner::MicrophoneOwner(AudioDeviceRegistry& devices,
                                 std::shared_ptr<LiveKitRoomTransport> transport)
    : devices_(devices), transport_(std::move(transport)) {
  if (!transport_) throw std::invalid_argument("Microphone transport missing");
  worker_ = std::thread([this] { run(); });
}
MicrophoneOwner::~MicrophoneOwner() {
  stop();
}
void MicrophoneOwner::stop() {
  std::lock_guard join_lock(join_mutex_);
  beginStop();
  {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
void MicrophoneOwner::apply(std::uint64_t revision, const MicrophoneIntent& intent,
                            std::optional<std::uint64_t> room_generation,
                            std::uint64_t device_revision, std::shared_ptr<EchoReferencePort> echo) {
  std::lock_guard lock(mutex_);
  if (stopping_ || done_ || revision < desired_.revision) return;
  if (intent.state != desired_.intent.state || intent.device_id != desired_.intent.device_id ||
      intent.bypass_system_processing != desired_.intent.bypass_system_processing ||
      intent.retry_revision != desired_.intent.retry_revision || device_revision != desired_.device_revision) {
    capture_cancellation_.request_stop();
    capture_cancellation_ = std::stop_source{};
  }
  auto publication_epoch = desired_.publication_epoch;
  if (publishes(desired_.intent, desired_.room_generation) &&
      (!publishes(intent, room_generation) || desired_.room_generation != room_generation)) {
    ++publication_epoch;
    if (sender_) sender_->cancel();
  }
  desired_ = {revision, device_revision, publication_epoch, intent, room_generation, std::move(echo)};
  if (intent.state != MicrophoneIntentState::off) snapshot_.stopped = false;
  if (publishes(intent, room_generation)) snapshot_.publication_stopped = false;
  changed_.notify_one();
}
void MicrophoneOwner::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  capture_cancellation_.request_stop();
  if (sender_) sender_->cancel();
  changed_.notify_one();
}
MicrophoneOwnerSnapshot MicrophoneOwner::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshot_;
}

void MicrophoneOwner::run() noexcept {
  std::unique_ptr<MicrophonePipeline> pipeline;
  std::shared_ptr<MicrophoneSender> sender;
  std::optional<std::uint64_t> sender_room;
  std::uint64_t sender_epoch = 0;
  Desired applied;
  bool selection_pending = false;
  std::optional<EngineFailure> problem;
  bool device_fallback = false;
  const auto stopSender = [&] {
    if (sender && !sender->stop(Clock::now() + kShutdownDeadline)) std::terminate();
    {
      std::lock_guard lock(mutex_);
      sender_.reset();
    }
    sender.reset();
    sender_room.reset();
  };
  const auto stopPipeline = [&] {
    stopSender();
    if (pipeline && !pipeline->stop(Clock::now() + kShutdownDeadline)) std::terminate();
    pipeline.reset();
  };
  try {
    for (;;) {
      Desired desired;
      std::stop_token cancellation;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds(20), [&] {
          return stopping_ || desired_.revision != applied.revision ||
              desired_.room_generation != applied.room_generation ||
              desired_.device_revision != applied.device_revision || desired_.echo != applied.echo;
        });
        if (stopping_) break;
        desired = desired_;
        cancellation = capture_cancellation_.get_token();
      }
      const auto previous_problem = problem;
      const bool changed = selection_pending || desired.intent != applied.intent ||
          desired.publication_epoch != applied.publication_epoch ||
          desired.room_generation != applied.room_generation ||
          desired.device_revision != applied.device_revision || desired.echo != applied.echo;
      const bool retry = selection_pending || desired.intent.state != applied.intent.state ||
          desired.intent.device_id != applied.intent.device_id ||
          desired.intent.bypass_system_processing != applied.intent.bypass_system_processing ||
          desired.intent.retry_revision != applied.intent.retry_revision ||
          desired.device_revision != applied.device_revision;
      const bool publish = publishes(desired.intent, desired.room_generation);
      if (sender && (!publish || sender_room != desired.room_generation ||
          sender_epoch != desired.publication_epoch)) stopSender();
      if ((desired.room_generation != applied.room_generation || desired.publication_epoch != applied.publication_epoch) &&
          problem && (problem->code == "microphone_publish_failed" || problem->code == "microphone_sender_failed"))
        problem.reset();
      if (pipeline && changed && problem && !retry && desired.intent.state != MicrophoneIntentState::off) {
        // A failed input candidate must not disable mute/PTT on the retained
        // healthy capture. DSP control has no retry/publication side effect.
        if (pipeline->configure(dspConfig(desired.intent)) != MicrophonePipelineFailure::none)
          stopPipeline();
      }
      if (desired.intent.state == MicrophoneIntentState::off) {
        stopPipeline();
        problem.reset();
        device_fallback = false;
      } else if (changed && (!problem || retry)) {
        if (retry) problem.reset();
        {
          std::lock_guard lock(mutex_);
          snapshot_.path = {desired.revision, MediaPathState::Starting};
        }
        try {
          if (!pipeline) pipeline = std::make_unique<MicrophonePipeline>(makeLiveKitMicrophoneEnhancement);
          const auto check = [](MicrophonePipelineFailure failure) {
            if (failure != MicrophonePipelineFailure::none) throw failure;
          };
          check(pipeline->configure(dspConfig(desired.intent)));
          check(pipeline->setEchoReference(desired.echo));
          check(pipeline->setSystemProcessingBypass(desired.intent.bypass_system_processing, cancellation));
          check(pipeline->selectInput(devices_, deviceIntent(desired.intent, devices_, device_fallback), cancellation));
          check(pipeline->setDemand({true, publish, desired.intent.meter_demand}, cancellation));
          if (publish && !sender) {
            // Capture may have taken seconds to open. Recheck the latest Room
            // before installing a cancellable publication transaction.
            std::lock_guard lock(mutex_);
            if (!stopping_ && !cancellation.stop_requested() && publishes(desired_.intent, desired_.room_generation) &&
                desired_.room_generation == desired.room_generation &&
                desired_.publication_epoch == desired.publication_epoch) {
              sender = std::make_shared<MicrophoneSender>(transport_, pipeline->output(), pipeline->outputEvent());
              sender_ = sender;
              sender_room = desired.room_generation;
              sender_epoch = desired.publication_epoch;
            }
          }
          if (sender && !sender->stats().published && sender->start() != MicrophonePublicationFailure::none) {
            stopSender();
            problem = EngineFailure{"microphone_publish_failed", "Microphone publication failed", "microphone", true};
          }
        } catch (MicrophonePipelineFailure failure) {
          problem = inputFailure(failure, pipeline ? pipeline->stats() : MicrophonePipelineStats{});
        } catch (...) {
          problem = EngineFailure{"microphone_unavailable", "Microphone owner could not apply settings", "microphone", true};
        }
      }
      if (cancellation.stop_requested()) {
        problem = previous_problem;
        selection_pending = true;
        continue;
      }
      MicrophoneOwnerSnapshot current;
      current.pipeline = pipeline ? pipeline->stats() : MicrophonePipelineStats{};
      current.sender = sender ? sender->stats() : MicrophoneSenderStats{};
      if (current.sender.failure != MicrophonePublicationFailure::none) {
        problem = EngineFailure{"microphone_sender_failed", "Microphone publication stopped progressing", "microphone", true};
        stopSender();
      }
      if (current.pipeline.capture.state == MicrophoneCaptureState::failed)
        problem = EngineFailure{"microphone_capture_failed", "Microphone capture stopped progressing", "microphone", true};
      current.publication_stopped = !sender;
      current.stopped = !pipeline && !sender;
      current.path.revision = desired.revision;
      current.path.failure = problem;
      const bool healthy = pipeline && current.pipeline.capture.state == MicrophoneCaptureState::healthy &&
          (!publish || (sender && current.sender.published));
      if (!problem && device_fallback && healthy)
        current.path.failure = EngineFailure{"microphone_device_fallback",
            "Selected microphone is unavailable; using the default input", "microphone", true};
      current.path.warning = current.path.failure.has_value() && healthy;
      current.path.state = desired.intent.state == MicrophoneIntentState::off ? MediaPathState::Off :
          problem && !healthy ? MediaPathState::Failed :
          !healthy ? MediaPathState::Starting :
          desired.intent.muted || (desired.intent.push_to_talk && !desired.intent.push_to_talk_held)
              ? MediaPathState::Muted : MediaPathState::Running;
      {
        std::lock_guard lock(mutex_);
        if (cancellation.stop_requested()) {
          problem = previous_problem;
          selection_pending = true;
          continue;
        }
        if (desired_.intent != desired.intent || desired_.room_generation != desired.room_generation) {
          if (publishes(desired_.intent, desired_.room_generation)) current.publication_stopped = false;
          if (desired_.intent.state != MicrophoneIntentState::off) current.stopped = false;
        }
        snapshot_ = std::move(current);
      }
      selection_pending = false;
      applied = std::move(desired);
    }
  } catch (...) {
    problem = EngineFailure{"microphone_owner_failed", "Microphone control owner failed", "microphone", false};
  }
  stopPipeline();
  {
    std::lock_guard lock(mutex_);
    snapshot_ = {};
    if (problem) snapshot_.path = {applied.revision, MediaPathState::Failed, problem};
    done_ = true;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::audio
