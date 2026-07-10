#include "microphone_actor.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>
#include <livekit/room_delegate.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "audio_constants.hpp"
#include "audio_devices.hpp"
#include "capture_lifecycle_invariants.hpp"
#include "microphone_audio_processor.hpp"
#include "microphone_echo_reference.hpp"
#include "generation_fence.hpp"
#include "runtime_config.hpp"
#include "runtime_config_patch.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {
namespace {

constexpr auto connect_timeout = std::chrono::seconds(10);

class RoomDelegate final : public livekit::RoomDelegate {
 public:
  RoomDelegate(std::string session_id, std::uint64_t generation, MicrophoneActor::InternalPost post)
    : session_id_(std::move(session_id)), generation_(generation), post_(std::move(post)) {}

  void onConnectionStateChanged(
    livekit::Room&,
    const livekit::ConnectionStateChangedEvent& event
  ) override {
    bool notify_terminal = false;
    {
      std::lock_guard lock(mutex_);
      state_ = event.state;
      if (state_ == livekit::ConnectionState::Connected) was_connected_ = true;
      notify_terminal =
        state_ == livekit::ConnectionState::Disconnected && was_connected_ && !intentional_;
    }
    changed_.notify_all();
    if (notify_terminal) postTerminal("livekit_disconnected");
  }

  void onDisconnected(livekit::Room&, const livekit::DisconnectedEvent&) override {
    bool notify = false;
    {
      std::lock_guard lock(mutex_);
      state_ = livekit::ConnectionState::Disconnected;
      disconnected_ = true;
      notify = !intentional_;
    }
    changed_.notify_all();
    if (notify) postTerminal("livekit_disconnected");
  }

  bool waitConnected() {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, connect_timeout, [&] {
      return state_ == livekit::ConnectionState::Connected || disconnected_;
    }) && state_ == livekit::ConnectionState::Connected;
  }

  void markIntentional() {
    std::lock_guard lock(mutex_);
    intentional_ = true;
  }

 private:
  void postTerminal(const char* message) {
    if (terminal_posted_.exchange(true)) return;
    MediaCommand command;
    command.type = "__microphoneTerminal";
    command.session_id = session_id_;
    command.generation = generation_;
    command.internal_message = message;
    post_(std::move(command));
  }

  std::string session_id_;
  std::uint64_t generation_;
  MicrophoneActor::InternalPost post_;
  std::mutex mutex_;
  std::condition_variable changed_;
  livekit::ConnectionState state_ = livekit::ConnectionState::Disconnected;
  bool disconnected_ = false;
  bool intentional_ = false;
  bool was_connected_ = false;
  std::atomic_bool terminal_posted_{false};
};

struct PublishedRoom {
  std::string session_id;
  std::uint64_t generation = 0;
  std::string participant_identity;
  std::unique_ptr<livekit::Room> room;
  std::unique_ptr<RoomDelegate> delegate;
  std::shared_ptr<livekit::AudioSource> source;
  std::shared_ptr<livekit::LocalAudioTrack> track;
};

std::string processingMode(bool enabled) {
  return enabled ? "software" : "disabled";
}

}  // namespace

class MicrophoneActor::Implementation {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current
  ) : emitter_(emitter), post_(std::move(post)), is_current_(std::move(is_current)) {}

  ~Implementation() { shutdown(); }

  void warm(const MediaCommand& command) {
    if ((command.type == "warmMicrophone" || command.type == "connectMicrophone") &&
        !is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale microphone warm generation");
    }
    if (command.type == "startPreview") {
      std::lock_guard lock(room_mutex_);
      if (!active_room_.session_id.empty()) {
        if (!captureHealthy()) {
          throw std::runtime_error("active microphone capture pipeline is not healthy");
        }
        return;
      }
    }
    configure(command);
    if (captureDeviceMatches(command.device_id) && captureHealthy()) {
      setMetricIdentity(command.session_id, command.generation);
      return;
    }
    stopCapture();
    {
      std::lock_guard lock(capture_startup_mutex_);
      capture_ready_ = false;
      capture_startup_error_.clear();
    }
    const auto epoch = capture_epoch_.fetch_add(1) + 1;
    setMetricIdentity(command.session_id, command.generation);
    {
      std::lock_guard lock(capture_lifecycle_mutex_);
      capture_device_id_ = command.device_id;
      capture_running_.store(true);
      capture_thread_ = std::thread([this, device_id = capture_device_id_, epoch] {
        captureLoop(device_id, epoch);
      });
    }
    std::unique_lock startup_lock(capture_startup_mutex_);
    capture_startup_changed_.wait_for(
      startup_lock,
      std::chrono::seconds(5),
      [&] { return capture_ready_ || !capture_startup_error_.empty(); }
    );
    if (capture_ready_) return;
    const auto error = capture_startup_error_.empty()
      ? std::string("microphone capture startup timed out")
      : capture_startup_error_;
    startup_lock.unlock();
    stopCapture();
    throw std::runtime_error(error);
  }

  RuntimeEvent connect(const MediaCommand& command) {
    if (!is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale microphone connect generation");
    }
    validateConnect(command);
    const auto previous_config = config();
    const auto previous_metric_identity = metric_identity_.current();
    bool capture_was_healthy = false;
    bool capture_replaced_for_candidate = false;
    std::string previous_device_id;
    std::string previous_session_id;
    std::uint64_t previous_generation = 0;
    {
      std::lock_guard lock(room_mutex_);
      previous_session_id = active_room_.session_id;
      previous_generation = active_room_.generation;
    }
    {
      std::lock_guard lock(capture_lifecycle_mutex_);
      capture_was_healthy = capture_running_.load() && captureReady();
      previous_device_id = capture_device_id_;
    }
    if (!capture_was_healthy) warm(command);

    auto candidate = PublishedRoom{};
    candidate.session_id = command.session_id;
    candidate.generation = command.generation;
    candidate.participant_identity = command.participant_identity;
    candidate.source = std::make_shared<livekit::AudioSource>(
      syrnike::voice::kSampleRate,
      syrnike::voice::kChannels
    );
    addSink(candidate.source);

    try {
      candidate.room = std::make_unique<livekit::Room>();
      candidate.delegate = std::make_unique<RoomDelegate>(
        command.session_id, command.generation, post_
      );
      candidate.room->setDelegate(candidate.delegate.get());
      livekit::RoomOptions options;
      options.auto_subscribe = false;
      options.single_peer_connection = false;
      if (!candidate.room->connect(command.livekit_url, command.livekit_token, options)) {
        throw std::runtime_error("LiveKit microphone connect returned false");
      }
      if (!candidate.delegate->waitConnected()) {
        throw std::runtime_error("LiveKit microphone connection timed out");
      }
      if (!is_current_(command.session_id, command.generation)) {
        throw std::runtime_error("stale microphone connect generation");
      }
      auto participant = candidate.room->localParticipant().lock();
      if (!participant) throw std::runtime_error("LiveKit local participant is unavailable");

      candidate.track = livekit::LocalAudioTrack::createLocalAudioTrack(
        "microphone", candidate.source
      );
      livekit::AudioEncodingOptions audio_encoding;
      audio_encoding.max_bitrate = command.audio_bitrate;
      livekit::TrackPublishOptions publish_options;
      publish_options.audio_encoding = audio_encoding;
      publish_options.dtx = true;
      publish_options.source = livekit::TrackSource::SOURCE_MICROPHONE;
      participant->publishTrack(candidate.track, publish_options);
      if (!candidate.track->publication()) {
        throw std::runtime_error("LiveKit microphone publication was not acknowledged");
      }
      if (command.muted) candidate.track->mute();
      if (!is_current_(command.session_id, command.generation)) {
        throw std::runtime_error("stale microphone publish generation");
      }
      if (!captureDeviceMatches(command.device_id) || !captureHealthy()) {
        capture_replaced_for_candidate = true;
        warm(command);
      }
      if (!captureHealthy()) {
        throw std::runtime_error("microphone capture pipeline is not healthy at commit");
      }
      if (!is_current_(command.session_id, command.generation)) {
        throw std::runtime_error("stale microphone capture generation");
      }
    } catch (...) {
      removeSink(candidate.source);
      if (candidate.delegate) candidate.delegate->markIntentional();
      if (candidate.room) {
        try { candidate.room->disconnect(); } catch (...) {}
      }
      {
        std::lock_guard lock(config_mutex_);
        config_ = previous_config;
      }
      metric_identity_.restoreIfCurrent(
        command.session_id,
        command.generation,
        previous_metric_identity.first,
        previous_metric_identity.second
      );
      if (capture_replaced_for_candidate && !previous_session_id.empty()) {
        MediaCommand rollback;
        rollback.type = "__rollbackMicrophoneCapture";
        rollback.session_id = previous_session_id;
        rollback.generation = previous_generation;
        rollback.device_id = previous_device_id;
        rollback.input_volume = previous_config.input_volume;
        rollback.voice_gate_enabled = previous_config.voice_gate_enabled;
        rollback.voice_gate_threshold_db = previous_config.voice_gate_threshold_db;
        rollback.voice_gate_auto_threshold = previous_config.voice_gate_auto_threshold;
        rollback.noise_suppression = previous_config.noise_suppression_enabled;
        rollback.echo_cancellation = previous_config.echo_cancellation_enabled;
        rollback.has_input_volume = true;
        rollback.has_voice_gate_enabled = true;
        rollback.has_voice_gate_threshold_db = true;
        rollback.has_voice_gate_auto_threshold = true;
        rollback.has_noise_suppression = true;
        rollback.has_echo_cancellation = true;
        try {
          warm(rollback);
        } catch (const std::exception& rollback_error) {
          MediaCommand terminal;
          terminal.type = "__microphoneTerminal";
          terminal.session_id = previous_session_id;
          terminal.generation = previous_generation;
          terminal.internal_message =
            "microphone_capture_failed:" + std::string(rollback_error.what());
          terminal.internal_epoch = capture_epoch_.load();
          post_(std::move(terminal));
        }
      }
      throw;
    }

    PublishedRoom previous;
    {
      std::lock_guard lock(room_mutex_);
      previous = std::move(active_room_);
      active_room_ = std::move(candidate);
      muted_ = command.muted;
    }
    configure(command);
    setMetricIdentity(command.session_id, command.generation);
    removeSink(previous.source);
    disconnectRoom(previous);

    RuntimeEvent result;
    result.type = "reply";
    result.request_id = command.request_id;
    result.session_id = command.session_id;
    result.generation = command.generation;
    result.ok = true;
    result.kind = "microphone";
    result.audio_mode = "microphone";
    result.noise_suppression = processingMode(command.noise_suppression);
    result.echo_cancellation = command.echo_cancellation ? "software" : "disabled";
    result.native_participant_identity = command.participant_identity;
    return result;
  }

  void configure(const MediaCommand& command) {
    if (command.type == "configureMicrophone") {
      std::lock_guard room_lock(room_mutex_);
      if (
        !active_room_.session_id.empty() &&
        (active_room_.session_id != command.session_id || active_room_.generation != command.generation)
      ) {
        throw std::runtime_error("stale microphone configuration generation");
      }
    }
    std::lock_guard lock(config_mutex_);
    config_ = mergeRuntimeConfig(config_, command);
  }

  void setMuted(const MediaCommand& command) {
    std::lock_guard lock(room_mutex_);
    if (
      !active_room_.session_id.empty() &&
      (active_room_.session_id != command.session_id || active_room_.generation != command.generation)
    ) {
      throw std::runtime_error("stale microphone mute generation");
    }
    muted_ = command.muted;
    if (!active_room_.track) return;
    if (muted_) active_room_.track->mute(); else active_room_.track->unmute();
  }

  void setPreviewConsumer(
    const std::string& session_id,
    std::uint64_t generation,
    PreviewConsumer consumer
  ) {
    std::lock_guard lock(preview_mutex_);
    preview_session_id_ = session_id;
    preview_generation_ = generation;
    preview_consumer_ = std::move(consumer);
  }

  void clearPreviewConsumer(const std::string& session_id, std::uint64_t generation) {
    std::lock_guard lock(preview_mutex_);
    if (preview_session_id_ != session_id || preview_generation_ != generation) return;
    preview_consumer_ = {};
    preview_session_id_.clear();
    preview_generation_ = 0;
  }

  std::pair<std::string, std::uint64_t> currentMetricIdentity() {
    return metric_identity_.current();
  }

  void restoreMetricIdentityIfCurrent(
    const std::string& candidate_session,
    std::uint64_t candidate_generation,
    const std::string& previous_session,
    std::uint64_t previous_generation
  ) {
    metric_identity_.restoreIfCurrent(
      candidate_session,
      candidate_generation,
      previous_session,
      previous_generation
    );
  }

  bool isCurrentCaptureFailureCommand(const MediaCommand& command) {
    return command.internal_message.starts_with("microphone_capture_failed:") &&
      syrnike::desktop_native::media::isCurrentCaptureFailure(
        command.internal_epoch,
        capture_epoch_.load(),
        capture_running_.load(),
        captureReady()
      );
  }

  void disconnect(const MediaCommand& command, bool emit_stopped) {
    if (command.type == "disconnectMicrophone" && !command.session_id.empty() &&
        !is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale microphone disconnect generation");
    }
    PublishedRoom previous;
    {
      std::lock_guard lock(room_mutex_);
      if (!active_room_.session_id.empty() && active_room_.session_id != command.session_id) {
        return;
      }
      previous = std::move(active_room_);
    }
    const bool had_active_room = !previous.session_id.empty();
    removeSink(previous.source);
    disconnectRoom(previous);
    if (emit_stopped && had_active_room) {
      RuntimeEvent event;
      event.type = "sessionStopped";
      event.request_id = command.request_id;
      event.session_id = previous.session_id;
      event.generation = previous.generation;
      event.reason = "disconnected";
      emitter_.emit(std::move(event));
    }
  }

  void handleTerminal(const MediaCommand& command) {
    MediaCommand effective = command;
    const bool capture_failure = command.internal_message.starts_with(
      "microphone_capture_failed:"
    );
    if (capture_failure) {
      if (!isCurrentCaptureFailureCommand(command)) return;
      std::lock_guard lock(room_mutex_);
      if (active_room_.session_id.empty()) return;
      effective.session_id = active_room_.session_id;
      effective.generation = active_room_.generation;
    }
    {
      std::lock_guard lock(room_mutex_);
      if (
        active_room_.session_id != effective.session_id ||
        active_room_.generation != effective.generation
      ) return;
    }
    disconnect(effective, false);
    RuntimeEvent event;
    event.type = "sessionLifecycle";
    event.session_id = effective.session_id;
    event.generation = effective.generation;
    event.kind = "microphone";
    event.status = "error";
    event.detail = effective.internal_message;
    event.error = NativeError{
      "microphone_runtime_lost", effective.internal_message, "microphone", true,
    };
    event.error->session_id = effective.session_id;
    event.error->generation = effective.generation;
    emitter_.emit(std::move(event));
    RuntimeEvent stopped;
    stopped.type = "sessionStopped";
    stopped.session_id = effective.session_id;
    stopped.generation = effective.generation;
    stopped.reason = "runtime_error";
    emitter_.emit(std::move(stopped));
  }

  void shutdown() {
    MediaCommand command;
    {
      std::lock_guard lock(room_mutex_);
      command.session_id = active_room_.session_id;
      command.generation = active_room_.generation;
    }
    disconnect(command, false);
    stopCapture();
  }

 private:
  void validateConnect(const MediaCommand& command) {
    if (command.session_id.empty()) throw std::invalid_argument("sessionId is required");
    if (command.livekit_url.empty()) throw std::invalid_argument("LiveKit URL is required");
    if (command.livekit_token.empty()) throw std::invalid_argument("LiveKit token is required");
    if (command.participant_identity.empty()) {
      throw std::invalid_argument("participantIdentity is required");
    }
  }

  void disconnectRoom(PublishedRoom& room) {
    if (room.delegate) room.delegate->markIntentional();
    room.track.reset();
    if (room.room) {
      try { room.room->disconnect(); } catch (...) {}
    }
    room.room.reset();
    room.delegate.reset();
    room.source.reset();
  }

  void addSink(const std::shared_ptr<livekit::AudioSource>& source) {
    std::lock_guard lock(sinks_mutex_);
    sinks_.push_back(source);
  }

  void removeSink(const std::shared_ptr<livekit::AudioSource>& source) {
    if (!source) return;
    std::lock_guard lock(sinks_mutex_);
    std::erase_if(sinks_, [&](const auto& candidate) { return candidate == source; });
  }

  std::vector<std::shared_ptr<livekit::AudioSource>> sinks() {
    std::lock_guard lock(sinks_mutex_);
    return sinks_;
  }

  syrnike::voice::RuntimeConfig config() {
    std::lock_guard lock(config_mutex_);
    return config_;
  }

  void setMetricIdentity(std::string session_id, std::uint64_t generation) {
    metric_identity_.set(session_id, generation);
  }

  std::pair<std::string, std::uint64_t> metricIdentity() {
    return metric_identity_.current();
  }

  struct PreviewTarget {
    std::string session_id;
    std::uint64_t generation = 0;
    PreviewConsumer consumer;
  };

  PreviewTarget previewTarget() {
    std::lock_guard lock(preview_mutex_);
    return PreviewTarget{preview_session_id_, preview_generation_, preview_consumer_};
  }

  bool captureReady() {
    std::lock_guard lock(capture_startup_mutex_);
    return capture_ready_;
  }

  bool captureHealthy() {
    return capture_running_.load() && captureReady();
  }

  bool captureDeviceMatches(const std::string& device_id) {
    std::lock_guard lock(capture_lifecycle_mutex_);
    return capture_thread_.joinable() && capture_device_id_ == device_id;
  }

  void stopCapture() {
    capture_running_.store(false);
    if (capture_thread_.joinable()) capture_thread_.join();
    std::lock_guard lock(capture_lifecycle_mutex_);
    capture_device_id_.clear();
  }

  void captureLoop(std::string device_id, std::uint64_t epoch) {
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    DWORD task_index = 0;
    HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    std::string terminal_error;

    try {
      auto device = captureDevice(device_id);
      ComPtr<IAudioClient> audio_client;
      auto result = device->Activate(
        __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
        reinterpret_cast<void**>(audio_client.GetAddressOf())
      );
      if (FAILED(result)) throw std::runtime_error("failed to activate microphone IAudioClient");
      auto format = desiredCaptureFormat();
      result = audio_client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        10'000'000,
        0,
        &format,
        nullptr
      );
      if (FAILED(result)) throw std::runtime_error("failed to initialize microphone stream");
      ComPtr<IAudioCaptureClient> capture_client;
      result = audio_client->GetService(IID_PPV_ARGS(&capture_client));
      if (FAILED(result)) throw std::runtime_error("failed to open microphone capture client");
      result = audio_client->Start();
      if (FAILED(result)) throw std::runtime_error("failed to start microphone stream");
      {
        std::lock_guard lock(capture_startup_mutex_);
        capture_ready_ = true;
      }
      capture_startup_changed_.notify_all();

      syrnike::voice::MicrophoneAudioProcessor processor;
      syrnike::voice::MicrophoneEchoReference echo_reference;
      bool echo_enabled = config().echo_cancellation_enabled;
      if (echo_enabled) echo_reference.start();
      std::vector<float> raw_frame;
      raw_frame.reserve(syrnike::voice::kSamplesPer10Ms);
      std::vector<std::int16_t> silent_reference(syrnike::voice::kSamplesPer10Ms, 0);
      auto next_metrics = std::chrono::steady_clock::now() + std::chrono::seconds(1);

      while (capture_running_.load()) {
        UINT32 packet_frames = 0;
        result = capture_client->GetNextPacketSize(&packet_frames);
        if (FAILED(result)) throw std::runtime_error("microphone packet query failed");
        if (packet_frames == 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
          continue;
        }
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        result = capture_client->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(result)) throw std::runtime_error("microphone buffer read failed");
        const auto* samples = reinterpret_cast<const float*>(data);
        for (UINT32 index = 0; index < frames; ++index) {
          raw_frame.push_back(
            (flags & AUDCLNT_BUFFERFLAGS_SILENT) || !samples ? 0.0f : samples[index]
          );
          if (raw_frame.size() != syrnike::voice::kSamplesPer10Ms) continue;
          auto active_config = config();
          if (active_config.echo_cancellation_enabled != echo_enabled) {
            echo_enabled = active_config.echo_cancellation_enabled;
            if (echo_enabled) echo_reference.start(); else echo_reference.stop();
          }
          const auto reference = echo_enabled ? echo_reference.popFrame() : std::nullopt;
          const auto reference_status = echo_reference.status();
          const std::vector<std::int16_t>* reference_ptr = nullptr;
          if (echo_enabled && reference_status.available) {
            reference_ptr = reference ? &*reference : &silent_reference;
          }
          auto processed = processor.processFrame(raw_frame, active_config, reference_ptr);
          const auto preview = previewTarget();
          if (preview.consumer) {
            preview.consumer(
              processed.pcm,
              processed.gate_metrics.input_db,
              processed.gate_metrics.threshold_db,
              processed.gate_metrics.open
            );
          }
          const auto active_sinks = sinks();
          for (std::size_t sink_index = 0; sink_index < active_sinks.size(); ++sink_index) {
            auto pcm = sink_index + 1 == active_sinks.size()
              ? std::move(processed.pcm)
              : processed.pcm;
            livekit::AudioFrame frame(
              std::move(pcm),
              syrnike::voice::kSampleRate,
              syrnike::voice::kChannels,
              syrnike::voice::kSamplesPer10Ms
            );
            active_sinks[sink_index]->captureFrame(frame);
          }
          if (std::chrono::steady_clock::now() >= next_metrics) {
            const auto [session_id, generation] = metricIdentity();
            if (
              !session_id.empty() &&
              (session_id != preview.session_id || generation != preview.generation)
            ) {
              RuntimeEvent event;
              event.type = "microphoneMetrics";
              event.session_id = session_id;
              event.generation = generation;
              event.input_db = processed.gate_metrics.input_db;
              event.threshold_db = processed.gate_metrics.threshold_db;
              event.gate_open = processed.gate_metrics.open;
              emitter_.emit(std::move(event));
            }
            next_metrics = std::chrono::steady_clock::now() + std::chrono::seconds(1);
          }
          raw_frame.clear();
        }
        capture_client->ReleaseBuffer(frames);
      }
      echo_reference.stop();
      audio_client->Stop();
    } catch (const std::exception& error) {
      terminal_error = error.what();
    }

    bool was_ready = false;
    {
      std::lock_guard lock(capture_startup_mutex_);
      was_ready = capture_ready_;
      capture_ready_ = false;
      if (!was_ready && !terminal_error.empty()) capture_startup_error_ = terminal_error;
    }
    capture_startup_changed_.notify_all();

    if (avrt) AvRevertMmThreadCharacteristics(avrt);
    if (com_initialized) CoUninitialize();
    if (!terminal_error.empty() && capture_running_.exchange(false) && was_ready) {
      const auto [session_id, generation] = metricIdentity();
      MediaCommand command;
      command.type = "__microphoneTerminal";
      command.session_id = session_id;
      command.generation = generation;
      command.internal_message = "microphone_capture_failed:" + terminal_error;
      command.internal_epoch = epoch;
      post_(std::move(command));
    }
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  std::mutex config_mutex_;
  syrnike::voice::RuntimeConfig config_;
  std::mutex sinks_mutex_;
  std::vector<std::shared_ptr<livekit::AudioSource>> sinks_;
  std::mutex room_mutex_;
  PublishedRoom active_room_;
  bool muted_ = false;
  std::mutex capture_lifecycle_mutex_;
  std::thread capture_thread_;
  std::atomic_bool capture_running_{false};
  std::atomic_uint64_t capture_epoch_{0};
  std::string capture_device_id_;
  std::mutex capture_startup_mutex_;
  std::condition_variable capture_startup_changed_;
  bool capture_ready_ = false;
  std::string capture_startup_error_;
  GenerationFence metric_identity_;
  std::mutex preview_mutex_;
  std::string preview_session_id_;
  std::uint64_t preview_generation_ = 0;
  PreviewConsumer preview_consumer_;
};

MicrophoneActor::MicrophoneActor(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current
) : implementation_(std::make_unique<Implementation>(
      emitter,
      std::move(post),
      std::move(is_current)
    )) {}

MicrophoneActor::~MicrophoneActor() = default;
void MicrophoneActor::warm(const MediaCommand& command) { implementation_->warm(command); }
RuntimeEvent MicrophoneActor::connect(const MediaCommand& command) {
  return implementation_->connect(command);
}
void MicrophoneActor::configure(const MediaCommand& command) { implementation_->configure(command); }
void MicrophoneActor::setMuted(const MediaCommand& command) { implementation_->setMuted(command); }
void MicrophoneActor::setPreviewConsumer(
  const std::string& session_id,
  std::uint64_t generation,
  PreviewConsumer consumer
) {
  implementation_->setPreviewConsumer(session_id, generation, std::move(consumer));
}
void MicrophoneActor::clearPreviewConsumer(
  const std::string& session_id,
  std::uint64_t generation
) {
  implementation_->clearPreviewConsumer(session_id, generation);
}
std::pair<std::string, std::uint64_t> MicrophoneActor::currentMetricIdentity() {
  return implementation_->currentMetricIdentity();
}
void MicrophoneActor::restoreMetricIdentityIfCurrent(
  const std::string& candidate_session,
  std::uint64_t candidate_generation,
  const std::string& previous_session,
  std::uint64_t previous_generation
) {
  implementation_->restoreMetricIdentityIfCurrent(
    candidate_session,
    candidate_generation,
    previous_session,
    previous_generation
  );
}
bool MicrophoneActor::isCurrentCaptureFailure(const MediaCommand& command) {
  return implementation_->isCurrentCaptureFailureCommand(command);
}
void MicrophoneActor::disconnect(const MediaCommand& command, bool emit_stopped) {
  implementation_->disconnect(command, emit_stopped);
}
void MicrophoneActor::handleTerminal(const MediaCommand& command) {
  implementation_->handleTerminal(command);
}
void MicrophoneActor::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
