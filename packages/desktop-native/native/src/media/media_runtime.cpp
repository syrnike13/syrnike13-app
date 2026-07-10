#include "media_runtime.hpp"

#include <livekit/livekit.h>

#include <windows.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <mutex>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include "audio_devices.hpp"
#include "microphone_actor.hpp"
#include "display_sources.hpp"
#include "generation_fence.hpp"
#include "screen_actor.hpp"
#include "screen_video_capture.hpp"
#include "preview_actor.hpp"

namespace syrnike::desktop_native::media {
namespace {

class LiveKitLease {
 public:
  LiveKitLease() {
    if (!livekit::initialize(livekit::LogLevel::Off)) {
      throw std::runtime_error("LiveKit initialization failed");
    }
  }
  ~LiveKitLease() { livekit::shutdown(); }

  LiveKitLease(const LiveKitLease&) = delete;
  LiveKitLease& operator=(const LiveKitLease&) = delete;
};

RuntimeEvent reply(const MediaCommand& command) {
  RuntimeEvent event;
  event.type = "reply";
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.ok = true;
  return event;
}

RuntimeEvent failedReply(const MediaCommand& command, NativeError error) {
  auto event = reply(command);
  event.ok = false;
  event.error = std::move(error);
  return event;
}

RuntimeEvent lifecycle(
  const MediaCommand& command,
  const char* kind,
  const char* status,
  std::string detail = {}
) {
  RuntimeEvent event;
  event.type = "sessionLifecycle";
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.kind = kind;
  event.status = status;
  event.detail = std::move(detail);
  return event;
}

}  // namespace

class MediaRuntime::Implementation {
 public:
  explicit Implementation(EventSinkPtr sink)
    : emitter_(std::move(sink)),
      microphone_(emitter_, [this](MediaCommand command) {
        if (microphone_commands_.tryPush(std::move(command))) return true;
        if (shutting_down_.load()) return false;
        std::terminate();
      },
      [this](const std::string& session_id, std::uint64_t generation) {
        return desired_microphone_.isCurrent(session_id, generation);
      }),
      screen_(emitter_, [this](MediaCommand command) {
        if (screen_commands_.tryPush(std::move(command))) return true;
        if (shutting_down_.load()) return false;
        std::terminate();
      }, [this](const std::string& session_id, std::uint64_t generation) {
        return desired_screen_.isCurrent(session_id, generation);
      }),
      preview_(emitter_),
      worker_([this] { run(); }) {}

  void waitUntilReady() {
    std::unique_lock lock(startup_mutex_);
    startup_changed_.wait(lock, [&] { return startup_complete_; });
    if (startup_error_.empty()) return;
    throw std::runtime_error(startup_error_);
  }

  ~Implementation() { shutdownAndWait(); }

  bool dispatch(MediaCommand command) {
    if (shutting_down_.load()) return false;
    if (command.type == "invalidateMicrophone") {
      if (desired_microphone_.advance(command.session_id, command.generation)) {
        emitter_.emit(reply(command));
      } else {
        emitter_.emit(failedReply(command, NativeError{
          "stale_generation",
          "Microphone generation is older than the current intent",
          command.type,
          false,
          command.session_id,
          command.generation,
        }));
      }
      return true;
    }
    auto pending = pending_commands_.load(std::memory_order_relaxed);
    while (true) {
      if (pending >= 256) return false;
      if (pending_commands_.compare_exchange_weak(pending, pending + 1)) break;
    }
    const auto type = command.type;
    const auto command_session_id = command.session_id;
    const auto command_generation = command.generation;
    std::pair<std::string, std::uint64_t> previous_desired_microphone;
    std::pair<std::string, std::uint64_t> previous_desired_screen;
    if (
      type == "warmMicrophone" || type == "connectMicrophone" ||
      type == "disconnectMicrophone"
    ) {
      previous_desired_microphone = desired_microphone_.current();
      desired_microphone_.advance(command.session_id, command.generation);
    }
    if (
      type == "connectScreen" || type == "startScreenCapture" ||
      type == "stopScreenCapture" || type == "disconnectScreen"
    ) {
      previous_desired_screen = desired_screen_.current();
      desired_screen_.advance(command.session_id, command.generation);
    }
    bool accepted = false;
    if (type == "shutdown") accepted = control_commands_.tryPush(std::move(command));
    else if (
      type == "warmMicrophone" || type == "connectMicrophone" ||
      type == "configureMicrophone" || type == "setMicrophoneMuted" ||
      type == "disconnectMicrophone" || type == "startPreview" ||
      type == "stopPreview"
    ) accepted = microphone_commands_.tryPush(std::move(command));
    else if (
      type == "connectScreen" || type == "startScreenCapture" ||
      type == "stopScreenCapture" || type == "disconnectScreen"
    ) accepted = screen_commands_.tryPush(std::move(command));
    else accepted = query_commands_.tryPush(std::move(command));
    if (!accepted) {
      pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      if (
        type == "warmMicrophone" || type == "connectMicrophone" ||
        type == "disconnectMicrophone"
      ) {
        desired_microphone_.restoreIfCurrent(
          command_session_id,
          command_generation,
          previous_desired_microphone.first,
          previous_desired_microphone.second
        );
      }
      if (
        type == "connectScreen" || type == "startScreenCapture" ||
        type == "stopScreenCapture" || type == "disconnectScreen"
      ) {
        desired_screen_.restoreIfCurrent(
          command_session_id,
          command_generation,
          previous_desired_screen.first,
          previous_desired_screen.second
        );
      }
    }
    return accepted;
  }

  void requestShutdown() {
    shutting_down_.store(true);
    desired_microphone_.advance("__shutdown__", UINT64_MAX);
    desired_screen_.advance("__shutdown__", UINT64_MAX);
    control_commands_.close();
  }

  void shutdownAndWait() {
    std::lock_guard lock(shutdown_mutex_);
    requestShutdown();
    if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
  }

 private:
  void runtimeError(const MediaCommand& command, NativeError error) {
    error.session_id = command.session_id;
    if (!command.session_id.empty()) error.generation = command.generation;
    RuntimeEvent event;
    event.type = "runtimeError";
    event.request_id = command.request_id;
    event.session_id = command.session_id;
    event.generation = command.generation;
    event.error = std::move(error);
    emitter_.emit(std::move(event));
  }

  void handleMicrophone(const MediaCommand& command) {
    if (command.type == "__microphoneTerminal") {
      if (
        !preview_session_id_.empty() &&
        microphone_.isCurrentCaptureFailure(command)
      ) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
        preview_.failFromCapture(
          preview_session_id_,
          preview_generation_,
          command.internal_message
        );
        microphone_.restoreMetricIdentityIfCurrent(
          preview_session_id_,
          preview_generation_,
          preview_previous_metric_session_id_,
          preview_previous_metric_generation_
        );
        preview_session_id_.clear();
        preview_generation_ = 0;
        preview_previous_metric_session_id_.clear();
        preview_previous_metric_generation_ = 0;
      }
      microphone_.handleTerminal(command);
      return;
    }
    if (command.type == "warmMicrophone") {
      microphone_.warm(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "connectMicrophone") {
      emitter_.emit(lifecycle(command, "microphone", "starting", "livekit_connecting"));
      auto result = microphone_.connect(command);
      emitter_.emit(result);
      RuntimeEvent started = result;
      started.type = "sessionStarted";
      started.ok = true;
      emitter_.emit(std::move(started));
      emitter_.emit(lifecycle(command, "microphone", "running"));
      return;
    }
    if (command.type == "configureMicrophone") {
      microphone_.configure(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "setMicrophoneMuted") {
      microphone_.setMuted(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "disconnectMicrophone") {
      microphone_.disconnect(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "startPreview") {
      if (!preview_session_id_.empty()) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
        MediaCommand previous_preview;
        previous_preview.session_id = preview_session_id_;
        previous_preview.generation = preview_generation_;
        preview_.stop(previous_preview, false);
        microphone_.restoreMetricIdentityIfCurrent(
          preview_session_id_,
          preview_generation_,
          preview_previous_metric_session_id_,
          preview_previous_metric_generation_
        );
        preview_session_id_.clear();
      }
      const auto previous_identity = microphone_.currentMetricIdentity();
      microphone_.warm(command);
      RuntimeEvent result;
      try {
        result = preview_.start(command);
      } catch (...) {
        microphone_.restoreMetricIdentityIfCurrent(
          command.session_id,
          command.generation,
          previous_identity.first,
          previous_identity.second
        );
        throw;
      }
      preview_session_id_ = command.session_id;
      preview_generation_ = command.generation;
      preview_previous_metric_session_id_ = previous_identity.first;
      preview_previous_metric_generation_ = previous_identity.second;
      microphone_.setPreviewConsumer(
        command.session_id,
        command.generation,
        [this](
          std::span<const std::int16_t> pcm,
          double input_db,
          double threshold_db,
          bool gate_open
        ) {
          preview_.pushFrame(pcm, input_db, threshold_db, gate_open);
        }
      );
      emitter_.emit(result);
      RuntimeEvent started = result;
      started.type = "microphonePreviewStarted";
      emitter_.emit(std::move(started));
      return;
    }
    if (command.type == "stopPreview") {
      if (
        !preview_session_id_.empty() &&
        (command.session_id.empty() ||
          (command.session_id == preview_session_id_ &&
           command.generation == preview_generation_))
      ) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
        MediaCommand active = command;
        active.session_id = preview_session_id_;
        active.generation = preview_generation_;
        preview_.stop(active);
        microphone_.restoreMetricIdentityIfCurrent(
          preview_session_id_,
          preview_generation_,
          preview_previous_metric_session_id_,
          preview_previous_metric_generation_
        );
        preview_session_id_.clear();
        preview_generation_ = 0;
        preview_previous_metric_session_id_.clear();
        preview_previous_metric_generation_ = 0;
      }
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleScreen(const MediaCommand& command) {
    if (command.type == "__screenTerminal") {
      screen_.handleTerminal(command);
      return;
    }
    if (command.type == "connectScreen") {
      emitter_.emit(lifecycle(command, "screen", "starting", "livekit_connecting"));
      emitter_.emit(screen_.connect(command));
      return;
    }
    if (command.type == "startScreenCapture") {
      emitter_.emit(lifecycle(command, "screen", "starting", "capture_starting"));
      auto result = screen_.startCapture(command);
      emitter_.emit(result);
      RuntimeEvent started = result;
      started.type = "sessionStarted";
      emitter_.emit(std::move(started));
      auto running = lifecycle(command, "screen", "running");
      running.width = result.width;
      running.height = result.height;
      running.fps = result.fps;
      running.bitrate = result.bitrate;
      running.audio_mode = result.audio_mode;
      emitter_.emit(std::move(running));
      return;
    }
    if (command.type == "stopScreenCapture") {
      screen_.stopCapture(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "disconnectScreen") {
      screen_.disconnect(command);
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleQuery(const MediaCommand& command) {
    if (command.type == "listDevices") {
      auto result = reply(command);
      result.kind = "devices";
      result.devices = listAudioDevices();
      std::erase_if(result.devices, [](const DeviceInfo& device) {
        return device.kind != "audioinput";
      });
      emitter_.emit(std::move(result));
      return;
    }
    if (command.type == "listDisplaySources") {
      auto result = reply(command);
      result.kind = "sources";
      result.sources = listDisplaySources(command.self_window_handle);
      emitter_.emit(std::move(result));
      return;
    }
    unknown(command);
  }

  void unknown(const MediaCommand& command) {
    const auto kind = command.type.find("Screen") != std::string::npos ? "screen" : "microphone";
    if (!command.session_id.empty()) {
      emitter_.emit(lifecycle(command, kind, "error", "unknown_command"));
    }
    NativeError error{
      "unknown_command",
      "Unknown media runtime command: " + command.type,
      command.type,
      false,
    };
    emitter_.emit(failedReply(command, error));
    runtimeError(command, std::move(error));
  }

  template <typename Handler>
  void commandLoop(BoundedQueue<MediaCommand, 256>& queue, Handler handler) {
    while (const auto command = queue.waitPop()) {
      try {
        handler(*command);
      } catch (const std::exception& error) {
        const std::string message = error.what();
        const bool stale_generation = message.starts_with("stale ");
        NativeError native_error{
          stale_generation ? "stale_generation" : "native_command_failed",
          message,
          command->type,
          !stale_generation,
        };
        native_error.session_id = command->session_id;
        if (!command->session_id.empty()) native_error.generation = command->generation;
        emitter_.emit(failedReply(*command, native_error));
        runtimeError(*command, std::move(native_error));
      }
      if (!command->request_id.empty()) {
        pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      }
    }
  }

  void markStartupReady() {
    {
      std::lock_guard lock(startup_mutex_);
      startup_complete_ = true;
      startup_error_.clear();
    }
    startup_changed_.notify_all();
  }

  void markStartupFailed(const std::string& message) {
    {
      std::lock_guard lock(startup_mutex_);
      if (startup_complete_) return;
      startup_complete_ = true;
      startup_error_ = message;
    }
    startup_changed_.notify_all();
  }

  void closeWorkerQueues() {
    desired_microphone_.advance("__shutdown__", UINT64_MAX);
    desired_screen_.advance("__shutdown__", UINT64_MAX);
    microphone_commands_.closeAndDiscard();
    screen_commands_.closeAndDiscard();
    query_commands_.closeAndDiscard();
  }

  static void joinIfRunning(std::thread& worker) {
    if (worker.joinable()) worker.join();
  }

  void run() {
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    std::optional<LiveKitLease> livekit;
    std::thread microphone_worker;
    std::thread screen_worker;
    std::thread query_worker;
    bool startup_ready = false;
    try {
      livekit.emplace();
      microphone_worker = std::thread([this] {
        commandLoop(microphone_commands_, [this](const auto& command) { handleMicrophone(command); });
      });
      screen_worker = std::thread([this] {
        commandLoop(screen_commands_, [this](const auto& command) { handleScreen(command); });
      });
      query_worker = std::thread([this] {
        const auto result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        commandLoop(query_commands_, [this](const auto& command) { handleQuery(command); });
        if (SUCCEEDED(result)) CoUninitialize();
      });
      markStartupReady();
      startup_ready = true;

      auto shutdown_command = control_commands_.waitPop();
      if (shutdown_command && !shutdown_command->request_id.empty()) {
        pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      }
      shutting_down_.store(true);
      closeWorkerQueues();
      joinIfRunning(microphone_worker);
      joinIfRunning(screen_worker);
      joinIfRunning(query_worker);
      if (!preview_session_id_.empty()) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
      }
      preview_.shutdown();
      microphone_.shutdown();
      screen_.shutdown();
      if (shutdown_command && shutdown_command->type == "shutdown") {
        emitter_.emit(reply(*shutdown_command));
      }
    } catch (const std::exception& error) {
      shutting_down_.store(true);
      closeWorkerQueues();
      joinIfRunning(microphone_worker);
      joinIfRunning(screen_worker);
      joinIfRunning(query_worker);
      if (!preview_session_id_.empty()) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
      }
      try { preview_.shutdown(); } catch (...) {}
      try { microphone_.shutdown(); } catch (...) {}
      try { screen_.shutdown(); } catch (...) {}
      livekit.reset();
      if (!startup_ready) {
        markStartupFailed(error.what());
        if (com_initialized) CoUninitialize();
        return;
      }
      RuntimeEvent event;
      event.type = "runtimeError";
      event.error = NativeError{"livekit_initialize_failed", error.what(), "initialize", false};
      emitter_.emit(std::move(event));
      std::terminate();
    }
    livekit.reset();
    if (com_initialized) CoUninitialize();
  }

  SequencedEmitter emitter_;
  GenerationFence desired_microphone_;
  MicrophoneActor microphone_;
  GenerationFence desired_screen_;
  ScreenActor screen_;
  PreviewActor preview_;
  BoundedQueue<MediaCommand, 256> microphone_commands_;
  BoundedQueue<MediaCommand, 256> screen_commands_;
  BoundedQueue<MediaCommand, 256> query_commands_;
  BoundedQueue<MediaCommand, 4> control_commands_;
  std::atomic_bool shutting_down_{false};
  std::atomic_uint32_t pending_commands_{0};
  std::string preview_session_id_;
  std::uint64_t preview_generation_ = 0;
  std::string preview_previous_metric_session_id_;
  std::uint64_t preview_previous_metric_generation_ = 0;
  std::mutex shutdown_mutex_;
  std::mutex startup_mutex_;
  std::condition_variable startup_changed_;
  bool startup_complete_ = false;
  std::string startup_error_;
  std::thread worker_;
};

MediaRuntime::MediaRuntime(EventSinkPtr sink)
  : implementation_(std::make_unique<Implementation>(std::move(sink))) {}

MediaRuntime::~MediaRuntime() = default;

void MediaRuntime::waitUntilReady() {
  implementation_->waitUntilReady();
}

bool MediaRuntime::dispatch(MediaCommand command) {
  return implementation_->dispatch(std::move(command));
}

void MediaRuntime::requestShutdown() {
  implementation_->requestShutdown();
}

void MediaRuntime::shutdownAndWait() {
  implementation_->shutdownAndWait();
}

}  // namespace syrnike::desktop_native::media
