#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <windows.h>

#include <livekit/livekit.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "common/cleanup_supervisor.hpp"
#include "common/event_sink.hpp"
#include "common/sequenced_emitter.hpp"
#include "media/audio_constants.hpp"
#include "media/audio_failure.hpp"
#include "media/generation_fence.hpp"
#include "media/livekit_voice_session.hpp"
#include "media/microphone_actor.hpp"
#include "media/microphone_pcm_queue.hpp"

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::CleanupJob;
using syrnike::desktop_native::CleanupSupervisor;
using syrnike::desktop_native::CleanupSubmitResult;
using syrnike::desktop_native::MediaCommand;
using syrnike::desktop_native::NativeCommandType;
using syrnike::desktop_native::NativeEventType;
using syrnike::desktop_native::RuntimeEvent;
using syrnike::desktop_native::SequencedEmitter;
using syrnike::desktop_native::media::AudioFailure;
using syrnike::desktop_native::media::AudioFailureKind;
using syrnike::desktop_native::media::DeterministicFakeLiveKitVoiceSession;
using syrnike::desktop_native::media::GenerationFence;
using syrnike::desktop_native::media::MicrophoneActor;
using syrnike::desktop_native::media::MicrophoneCaptureAdapter;
using syrnike::desktop_native::media::MicrophoneCaptureAttemptRequest;
using syrnike::desktop_native::media::MicrophoneCaptureCandidateRequest;
using syrnike::desktop_native::media::MicrophonePcmQueue;

constexpr auto kWatchdog = 15s;
constexpr std::string_view kSession = "microphone-resilience-soak";
constexpr std::uint64_t kSoakPhases = 60;
constexpr std::uint64_t kFramesPerSecond = 100;
constexpr auto kFramePeriod = 10ms;
constexpr std::uint64_t kProductionFramesPerPhase = 30 * kFramesPerSecond;
constexpr std::size_t kExpectedCleanupWorkers = 4;
constexpr std::size_t kExpectedCleanupBacklog = 60;
constexpr std::size_t kExpectedCleanupCapacity =
  kExpectedCleanupWorkers + kExpectedCleanupBacklog;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

DWORD stableProcessHandleCount() {
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  DWORD previous = 0;
  require(GetProcessHandleCount(GetCurrentProcess(), &previous) != FALSE,
          "failed to read process handle count");
  std::size_t stable_samples = 0;
  while (std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(2ms);
    DWORD current = 0;
    require(GetProcessHandleCount(GetCurrentProcess(), &current) != FALSE,
            "failed to read process handle count");
    if (current == previous) {
      if (++stable_samples == 3) return current;
    } else {
      previous = current;
      stable_samples = 0;
    }
  }
  throw std::runtime_error("process handle count did not stabilize");
}

struct SoakProfile {
  std::string_view name;
  std::uint64_t frames_per_phase;
  bool realtime;

  [[nodiscard]] std::uint64_t durationSeconds() const noexcept {
    return kSoakPhases * frames_per_phase / kFramesPerSecond;
  }
};

SoakProfile configuredProfile() {
  char* value = nullptr;
  std::size_t length = 0;
  const bool present =
    _dupenv_s(&value, &length, "SYRNIKE_MICROPHONE_SOAK_PROFILE") == 0 &&
    value && length > 1;
  const std::string profile = present ? value : "ci";
  std::free(value);
  if (profile == "ci") return {"ci", 1, false};
  if (profile == "production") {
    return {"production", kProductionFramesPerPhase, true};
  }
  throw std::invalid_argument(
    "SYRNIKE_MICROPHONE_SOAK_PROFILE must be ci or production"
  );
}

void awaitUtilityHostEpochExercise() {
  char* value = nullptr;
  std::size_t length = 0;
  const bool present =
    _dupenv_s(&value, &length, "SYRNIKE_MICROPHONE_SOAK_UTILITY_GATE") == 0 &&
    value && length > 1;
  const std::optional<std::filesystem::path> gate = present
    ? std::optional<std::filesystem::path>(value)
    : std::nullopt;
  std::free(value);
  if (!gate) return;

  require(gate->is_absolute(),
          "microphone utility-host gate path must be absolute");
  std::cout << "microphone_resilience_actor_ready" << std::endl;
  const auto deadline = std::chrono::steady_clock::now() + kWatchdog;
  while (!std::filesystem::exists(*gate) &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(2ms);
  }
  require(std::filesystem::exists(*gate),
          "actual utility-host epoch exercise did not release the active actor");
}

struct BlockingCleanupState final {
  std::mutex mutex;
  std::condition_variable changed;
  std::size_t active = 0;
  std::size_t completed = 0;
  bool release = false;
};

void runBlockedCleanup(void* context) noexcept {
  auto* state = static_cast<BlockingCleanupState*>(context);
  std::unique_lock lock(state->mutex);
  ++state->active;
  state->changed.notify_all();
  state->changed.wait(lock, [&] { return state->release; });
  --state->active;
  ++state->completed;
  state->changed.notify_all();
}

template <typename WhileSaturated>
void exerciseCleanupSaturation(WhileSaturated&& while_saturated) {
  auto& supervisor = CleanupSupervisor::instance();
  const auto before = supervisor.snapshot();
  require(before.worker_limit == kExpectedCleanupWorkers &&
            before.admission_capacity == kExpectedCleanupCapacity,
          "cleanup supervisor production limits changed from 4/60/64");
  require(before.owned_jobs == 0,
          "cleanup saturation started above its ownership baseline");
  auto state = std::make_shared<BlockingCleanupState>();
  std::vector<std::shared_ptr<CleanupJob>> jobs;
  jobs.reserve(kExpectedCleanupCapacity);
  struct ReleaseGuard final {
    std::shared_ptr<BlockingCleanupState> state;
    ~ReleaseGuard() {
      {
        std::lock_guard lock(state->mutex);
        state->release = true;
      }
      state->changed.notify_all();
    }
  } release{state};

  for (std::size_t index = 0; index < kExpectedCleanupCapacity; ++index) {
    auto job = std::make_shared<CleanupJob>();
    require(job->prepare(state, index + 1, &runBlockedCleanup),
            "cleanup saturation job preparation failed");
    require(supervisor.submit(job) == CleanupSubmitResult::Accepted,
            "cleanup supervisor rejected work within its admission bound");
    jobs.push_back(std::move(job));
  }
  auto rejected = std::make_shared<CleanupJob>();
  require(rejected->prepare(state, kExpectedCleanupCapacity + 1,
                            &runBlockedCleanup),
          "cleanup saturation rejection probe preparation failed");
  require(supervisor.submit(rejected) == CleanupSubmitResult::Saturated,
          "cleanup supervisor did not reject work beyond its admission bound");

  {
    std::unique_lock lock(state->mutex);
    require(state->changed.wait_for(lock, kWatchdog, [&] {
      return state->active == kExpectedCleanupWorkers;
    }), "cleanup supervisor did not reach its exact worker bound");
  }
  const auto saturated = supervisor.snapshot();
  require(
    saturated.worker_threads == kExpectedCleanupWorkers &&
      saturated.worker_handles == kExpectedCleanupWorkers &&
      saturated.active_jobs == kExpectedCleanupWorkers &&
      saturated.backlog_jobs == kExpectedCleanupBacklog &&
      saturated.owned_jobs == kExpectedCleanupCapacity &&
      saturated.saturated_submissions == before.saturated_submissions + 1,
    "cleanup saturation telemetry lost its exact active/backlog ownership"
  );

  std::forward<WhileSaturated>(while_saturated)();
  {
    std::lock_guard lock(state->mutex);
    state->release = true;
  }
  state->changed.notify_all();
  {
    std::unique_lock lock(state->mutex);
    require(state->changed.wait_for(lock, kWatchdog, [&] {
      return state->completed == kExpectedCleanupCapacity;
    }), "cleanup saturation did not complete every admitted job");
  }
  const auto deadline = std::chrono::steady_clock::now() + kWatchdog;
  auto recovered = supervisor.snapshot();
  while (recovered.owned_jobs != 0 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(2ms);
    recovered = supervisor.snapshot();
  }
  require(
    recovered.owned_jobs == 0 && recovered.active_jobs == 0 &&
      recovered.backlog_jobs == 0 &&
      recovered.accepted_jobs ==
        before.accepted_jobs + kExpectedCleanupCapacity &&
      recovered.completed_jobs ==
        before.completed_jobs + kExpectedCleanupCapacity &&
      recovered.saturated_submissions == before.saturated_submissions + 1,
    "cleanup saturation did not return exact ownership and counters"
  );
}

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(RuntimeEvent event) override {
    {
      std::lock_guard lock(mutex_);
      events_.push_back(std::move(event));
    }
    changed_.notify_all();
    return true;
  }

  void close() override {}

  RuntimeEvent waitReply(const std::string& request_id) {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kWatchdog, [&] {
          return std::any_of(events_.begin(), events_.end(), [&](const auto& event) {
            return event.type == NativeEventType::Reply &&
              event.request_id == request_id;
          });
        })) {
      throw std::runtime_error("timed out waiting for " + request_id);
    }
    const auto found = std::find_if(
      events_.begin(), events_.end(), [&](const auto& event) {
        return event.type == NativeEventType::Reply &&
          event.request_id == request_id;
      }
    );
    if (found == events_.end()) throw std::runtime_error("reply disappeared");
    return *found;
  }

  [[nodiscard]] std::size_t microphoneErrorCount() const {
    std::lock_guard lock(mutex_);
    return static_cast<std::size_t>(std::count_if(
      events_.begin(), events_.end(), [](const RuntimeEvent& event) {
        return event.type == NativeEventType::SessionLifecycle &&
          event.kind == "microphone" && event.status == "error";
      }
    ));
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<RuntimeEvent> events_;
};

class DeferredCommands final {
 public:
  bool post(MediaCommand command) {
    {
      std::lock_guard lock(mutex_);
      commands_.push_back(std::move(command));
    }
    changed_.notify_all();
    return true;
  }

  MediaCommand take(NativeCommandType type) {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kWatchdog, [&] {
          return std::any_of(commands_.begin(), commands_.end(), [&](const auto& command) {
            return command.type == type;
          });
        })) {
      throw std::runtime_error(
        "timed out waiting for " +
        std::string(syrnike::desktop_native::nativeCommandName(type))
      );
    }
    for (auto it = commands_.begin(); it != commands_.end(); ++it) {
      if (it->type != type) continue;
      auto result = std::move(*it);
      commands_.erase(it);
      return result;
    }
    throw std::runtime_error("deferred command disappeared");
  }

  std::optional<MediaCommand> tryTake(NativeCommandType type) {
    std::lock_guard lock(mutex_);
    for (auto it = commands_.begin(); it != commands_.end(); ++it) {
      if (it->type != type) continue;
      auto result = std::move(*it);
      commands_.erase(it);
      return result;
    }
    return std::nullopt;
  }

  void clear() {
    std::lock_guard lock(mutex_);
    commands_.clear();
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<MediaCommand> commands_;
};

class ScriptedCapture final {
 public:
  using RetainedSubmitToken = std::size_t;

  struct AttemptSnapshot {
    std::uint64_t count = 0;
    std::uint64_t epoch = 0;
    std::string device_id;
    RetainedSubmitToken submit_token = 0;
  };

  struct Snapshot {
    std::uint64_t attempts = 0;
    std::uint64_t submitted_frames = 0;
    std::uint64_t rejected_frames = 0;
    std::uint64_t terminal_faults = 0;
    std::size_t active_attempts = 0;
    std::size_t peak_active_attempts = 0;
    std::uint64_t candidate_probes = 0;
    std::uint64_t candidate_health_observations = 0;
    std::uint64_t old_capture_health_during_candidate_probes = 0;
  };

  void probeCandidate(MicrophoneCaptureCandidateRequest request) {
    std::function<bool(std::span<const float>, bool)> submit;
    {
      std::lock_guard lock(mutex_);
      require(active_attempts_ == 1 && !retained_submitters_.empty(),
              "candidate probe did not preserve exactly one old capture owner");
      require(request.timeout > 0ms,
              "candidate probe lost its bounded health timeout");
      submit = retained_submitters_.back();
    }

    const auto candidate_pcm = candidatePcmFrame(request.device_id);
    require(candidate_pcm.size() == syrnike::voice::kSamplesPer10Ms &&
              std::all_of(candidate_pcm.begin(), candidate_pcm.end(),
                          [](float sample) { return std::isfinite(sample); }) &&
              std::any_of(candidate_pcm.begin(), candidate_pcm.end(),
                          [](float sample) { return std::abs(sample) > 0.01f; }),
            "candidate endpoint did not produce one healthy 10ms PCM frame");
    const auto old_pcm = toneFrame();
    require(submit(old_pcm, false),
            "candidate probe retired the old capture before health validation");
    {
      std::lock_guard lock(mutex_);
      ++submitted_frames_;
      ++candidate_probes_;
      ++candidate_health_observations_;
      ++old_capture_health_during_candidate_probes_;
      candidate_devices_.push_back(request.device_id);
      pending_candidate_device_ = std::move(request.device_id);
    }
    changed_.notify_all();
  }

  void run(MicrophoneCaptureAttemptRequest request) {
    {
      std::lock_guard lock(mutex_);
      if (pending_candidate_device_) {
        require(*pending_candidate_device_ == request.device_id,
                "capture promotion did not use the healthy probed candidate");
        pending_candidate_device_.reset();
      }
      ++attempts_;
      ++active_attempts_;
      peak_active_attempts_ = std::max(peak_active_attempts_, active_attempts_);
      attempt_epochs_.push_back(request.epoch);
      attempt_devices_.push_back(request.device_id);
      retained_submitters_.push_back(request.submit_pcm);
    }
    struct ActiveGuard final {
      ScriptedCapture& owner;
      ~ActiveGuard() {
        {
          std::lock_guard lock(owner.mutex_);
          --owner.active_attempts_;
        }
        owner.changed_.notify_all();
      }
    } guard{*this};

    const auto startup = toneFrame();
    require(request.submit_pcm(startup, false),
            "injected startup PCM was rejected by the current capture epoch");
    {
      std::lock_guard lock(mutex_);
      ++submitted_frames_;
    }
    request.mark_ready();
    changed_.notify_all();

    while (request.keep_running()) {
      Action action;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, 2ms, [&] {
          return !actions_.empty() || !request.keep_running();
        });
        if (!request.keep_running()) break;
        if (actions_.empty()) continue;
        action = actions_.front();
        actions_.pop_front();
      }
      if (action.kind == ActionKind::FailEndpoint) {
        {
          std::lock_guard lock(mutex_);
          ++terminal_faults_;
          completed_action_ = action.sequence;
        }
        changed_.notify_all();
        throw AudioFailure(
          AudioFailureKind::EndpointInvalidated,
          "injected microphone endpoint removal",
          AUDCLNT_E_DEVICE_INVALIDATED
        );
      }
      const auto pcm = toneFrame();
      const bool accepted = request.submit_pcm(pcm, action.discontinuity);
      {
        std::lock_guard lock(mutex_);
        if (accepted) ++submitted_frames_;
        else ++rejected_frames_;
        last_action_accepted_ = accepted;
        completed_action_ = action.sequence;
      }
      changed_.notify_all();
    }
  }

  bool submit(bool discontinuity = false) {
    return enqueueAndWait(ActionKind::Submit, discontinuity);
  }

  void failEndpoint() {
    static_cast<void>(enqueueAndWait(ActionKind::FailEndpoint, false));
  }

  [[nodiscard]] Snapshot snapshot() const {
    std::lock_guard lock(mutex_);
    return Snapshot{
      .attempts = attempts_,
      .submitted_frames = submitted_frames_,
      .rejected_frames = rejected_frames_,
      .terminal_faults = terminal_faults_,
      .active_attempts = active_attempts_,
      .peak_active_attempts = peak_active_attempts_,
      .candidate_probes = candidate_probes_,
      .candidate_health_observations = candidate_health_observations_,
      .old_capture_health_during_candidate_probes =
        old_capture_health_during_candidate_probes_,
    };
  }

  [[nodiscard]] std::uint64_t candidateProbeCount() const {
    std::lock_guard lock(mutex_);
    return candidate_probes_;
  }

  [[nodiscard]] std::string latestCandidateDevice() const {
    std::lock_guard lock(mutex_);
    require(!candidate_devices_.empty(),
            "capture adapter exposed no candidate probe history");
    return candidate_devices_.back();
  }

  void waitForNoActiveAttempt() {
    std::unique_lock lock(mutex_);
    require(changed_.wait_for(lock, kWatchdog, [&] {
      return active_attempts_ == 0;
    }), "injected capture attempt did not stop within its bound");
  }

  [[nodiscard]] RetainedSubmitToken latestSubmitToken() const {
    std::lock_guard lock(mutex_);
    require(!retained_submitters_.empty(),
            "capture attempt exposed no retained PCM callback");
    return retained_submitters_.size() - 1;
  }

  [[nodiscard]] AttemptSnapshot latestAttempt() const {
    std::lock_guard lock(mutex_);
    require(!attempt_epochs_.empty() &&
              attempt_epochs_.size() == attempt_devices_.size() &&
              attempt_epochs_.size() == retained_submitters_.size(),
            "capture attempt history is incomplete");
    return AttemptSnapshot{
      .count = attempts_,
      .epoch = attempt_epochs_.back(),
      .device_id = attempt_devices_.back(),
      .submit_token = retained_submitters_.size() - 1,
    };
  }

  bool submitRetained(RetainedSubmitToken token) const {
    std::function<bool(std::span<const float>, bool)> submit;
    {
      std::lock_guard lock(mutex_);
      require(token < retained_submitters_.size(),
              "retained PCM callback token is out of range");
      submit = retained_submitters_[token];
    }
    const auto pcm = toneFrame();
    return submit(pcm, true);
  }

 private:
  enum class ActionKind { Submit, FailEndpoint };
  struct Action {
    ActionKind kind = ActionKind::Submit;
    bool discontinuity = false;
    std::uint64_t sequence = 0;
  };

  static std::array<float, syrnike::voice::kSamplesPer10Ms> toneFrame() {
    std::array<float, syrnike::voice::kSamplesPer10Ms> pcm{};
    for (std::size_t index = 0; index < pcm.size(); ++index) {
      pcm[index] = (index % 32 < 16) ? 0.2f : -0.2f;
    }
    return pcm;
  }

  static std::array<float, syrnike::voice::kSamplesPer10Ms> candidatePcmFrame(
      std::string_view device_id) {
    auto pcm = toneFrame();
    const float gain = device_id.empty() ? 0.75f : 0.5f;
    for (auto& sample : pcm) sample *= gain;
    return pcm;
  }

  bool enqueueAndWait(ActionKind kind, bool discontinuity) {
    std::unique_lock lock(mutex_);
    require(active_attempts_ == 1,
            "PCM action did not have exactly one capture owner");
    const auto sequence = ++next_action_;
    actions_.push_back(Action{kind, discontinuity, sequence});
    changed_.notify_all();
    require(changed_.wait_for(lock, kWatchdog, [&] {
      return completed_action_ >= sequence;
    }), "injected PCM action exceeded its completion bound");
    return last_action_accepted_;
  }

  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<Action> actions_;
  std::vector<std::uint64_t> attempt_epochs_;
  std::vector<std::string> attempt_devices_;
  std::vector<std::string> candidate_devices_;
  std::vector<std::function<bool(std::span<const float>, bool)>>
    retained_submitters_;
  std::uint64_t next_action_ = 0;
  std::uint64_t completed_action_ = 0;
  std::uint64_t attempts_ = 0;
  std::uint64_t submitted_frames_ = 0;
  std::uint64_t rejected_frames_ = 0;
  std::uint64_t terminal_faults_ = 0;
  std::uint64_t candidate_probes_ = 0;
  std::uint64_t candidate_health_observations_ = 0;
  std::uint64_t old_capture_health_during_candidate_probes_ = 0;
  std::size_t active_attempts_ = 0;
  std::size_t peak_active_attempts_ = 0;
  bool last_action_accepted_ = false;
  std::optional<std::string> pending_candidate_device_;
};

MediaCommand connectCommand(
    std::string request_id,
    std::uint64_t generation,
    std::uint64_t host_epoch,
    bool muted) {
  MediaCommand command;
  command.type = NativeCommandType::ConnectMicrophone;
  command.request_id = std::move(request_id);
  command.session_id = std::string(kSession);
  command.generation = generation;
  command.diagnostic_host_epoch = host_epoch;
  command.participant_identity = "soak:microphone";
  command.audio_bitrate = 64'000;
  command.muted = muted;
  return command;
}

class MicrophoneActorRuntimeHarness final {
 public:
  MicrophoneActorRuntimeHarness(
    std::shared_ptr<CollectingSink> sink,
    std::shared_ptr<DeterministicFakeLiveKitVoiceSession> livekit,
    std::shared_ptr<ScriptedCapture> capture
  ) : sink_(std::move(sink)),
      emitter_(sink_),
      livekit_(std::move(livekit)),
      capture_(std::move(capture)) {
    startActor();
  }

  ~MicrophoneActorRuntimeHarness() { stopActor(); }

  [[nodiscard]] std::uint64_t epoch() const noexcept { return host_epoch_; }
  [[nodiscard]] std::uint64_t generation() const noexcept { return generation_; }
  [[nodiscard]] std::uint64_t previewFrames() const noexcept {
    return preview_frames_.load(std::memory_order_acquire);
  }
  [[nodiscard]] std::uint64_t runtimeRestarts() const noexcept {
    return runtime_restarts_;
  }
  [[nodiscard]] std::uint64_t endpointRecoveries() const noexcept {
    return endpoint_recoveries_;
  }
  [[nodiscard]] std::uint64_t publicationRecoveries() const noexcept {
    return publication_recoveries_;
  }
  [[nodiscard]] std::uint64_t backpressureRecoveries() const noexcept {
    return backpressure_recoveries_;
  }
  [[nodiscard]] std::uint64_t deviceRecreations() const noexcept {
    return device_recreations_;
  }

  void connect() {
    require(desired_.advance(std::string(kSession), generation_),
            "microphone generation did not advance");
    livekit_->setVoiceSessionForTest(std::string(kSession));
    if (preview_demanded_) installPreviewConsumer();
    const auto request_id =
      "host-" + std::to_string(host_epoch_) +
      "-connect-" + std::to_string(generation_);
    actor_->connect(connectCommand(
      request_id, generation_, host_epoch_, muted_
    ));
    actor_->handleWorkerCommand(deferred_.take(
      NativeCommandType::MicrophoneAttemptReady
    ));
    const auto reply = sink_->waitReply(request_id);
    require(reply.ok && reply.kind == "microphone",
            "real MicrophoneActor publication did not commit");
  }

  bool submitFrame(bool discontinuity = false) {
    const auto preview_before = previewFrames();
    const auto capture_frames_before = capture_->snapshot().submitted_frames;
    const bool accepted = capture_->submit(discontinuity);
    pumpProcessingStatus();
    if (preview_demanded_) {
      require(previewFrames() > preview_before,
              "active preview did not receive injected capture PCM");
    } else {
      require(previewFrames() == preview_before,
              "stopped preview received injected capture PCM");
    }
    verifyMuteTransition(preview_before, capture_frames_before);
    return accepted;
  }

  void setMuted(bool muted) {
    MediaCommand command;
    command.type = NativeCommandType::SetMicrophoneMuted;
    command.session_id = std::string(kSession);
    command.generation = generation_;
    command.diagnostic_host_epoch = host_epoch_;
    command.muted = muted;
    actor_->setMuted(command);
    muted_ = muted;
    waitForPublicationQuiescence();
    pending_mute_assertion_ = muted
      ? MuteAssertion::Muted
      : MuteAssertion::Unmuted;
    publication_frames_at_transition_ = livekit_->microphoneFrameCount();
    publication_discontinuities_at_transition_ =
      livekit_->microphoneDiscontinuityCount();
  }

  void setPreview(bool demanded) {
    if (demanded == preview_demanded_) return;
    preview_demanded_ = demanded;
    if (demanded) installPreviewConsumer();
    else actor_->clearPreviewConsumer(std::string(kSession), generation_);
  }

  void defaultEndpointChanged() {
    const auto before = capture_->latestAttempt();
    MediaCommand changed;
    changed.type = NativeCommandType::MicrophoneEndpointChanged;
    changed.internal_message = "default_changed";
    changed.internal_epoch = static_cast<std::uint64_t>(eConsole);
    actor_->handleWorkerCommand(changed);
    verifyCaptureRecreated(before, before.device_id, 1);
    ++device_recreations_;
  }

  void selectEndpoint(std::string device_id) {
    const auto expected_device = device_id;
    const auto before = capture_->latestAttempt();
    const auto probes_before = capture_->candidateProbeCount();
    require(capture_->snapshot().active_attempts == 1,
            "endpoint configure did not start from one live capture owner");
    MediaCommand configure;
    configure.type = NativeCommandType::ConfigureMicrophone;
    configure.request_id = "configure-" + std::to_string(++pipeline_revision_);
    configure.revision = pipeline_revision_;
    configure.has_revision = true;
    configure.device_id = std::move(device_id);
    const auto reply = actor_->configure(configure);
    require(reply.ok && reply.revision == pipeline_revision_,
            "microphone endpoint configure failed");
    pumpProcessingStatus();
    require(capture_->candidateProbeCount() == probes_before + 1 &&
              capture_->latestCandidateDevice() == expected_device,
            "selected endpoint was promoted without a healthy candidate probe");
    verifyCaptureRecreated(before, expected_device, 1);
  }

  void removeSelectedEndpointAndRecover() {
    selectEndpoint("soak-selected-device");
    const auto before_removal = capture_->latestAttempt();
    MediaCommand removed;
    removed.type = NativeCommandType::MicrophoneEndpointChanged;
    removed.internal_message = "removed";
    removed.device_id = "soak-selected-device";
    actor_->handleWorkerCommand(removed);
    verifyCaptureRecreated(before_removal, "", 1);
    ++device_recreations_;

    selectEndpoint("soak-selected-device");
    const auto before_failure = capture_->latestAttempt();
    capture_->failEndpoint();
    auto terminal = deferred_.take(NativeCommandType::MicrophoneTerminal);
    require(
      terminal.device_kind == "microphone_capture" &&
      terminal.video_source == "audio_endpoint_invalidated" &&
      terminal.diagnostic_retryable && terminal.diagnostic_hresult != 0 &&
      terminal.internal_epoch != 0,
      "capture terminal lost endpoint ownership or correlated HRESULT"
    );
    const auto stale_terminal = terminal;
    require(!actor_->handleTerminal(terminal),
            "recoverable capture failure terminalized the microphone track");
    verifyCaptureRecreated(before_failure, "", 1);
    ++endpoint_recoveries_;
    require(submitFrame(true),
            "default endpoint fallback did not resume capture PCM");
    require(!actor_->isCurrentCaptureFailure(stale_terminal),
            "retired capture epoch remained current after recovery");
    require(!actor_->handleTerminal(stale_terminal),
            "stale capture terminal reached the recovered actor");
    selectEndpoint("soak-returned-device");
  }

  void failPublicationAndRecover() {
    MediaCommand unpublished;
    unpublished.track_id = "fake-publication";
    auto event = actor_->handlePublicationUnpublished(unpublished);
    require(event && event->type == NativeEventType::LocalMicrophoneUnpublished,
            "publication failure did not correlate to the active microphone track");
    sink_->emit(*event);
    ++generation_;
    ++publication_recoveries_;
    connect();
  }

  void saturatePublicationBackpressure() {
    waitForPublicationQuiescence();
    const auto published_before = livekit_->microphoneFrameCount();
    const auto discontinuities_before =
      livekit_->microphoneDiscontinuityCount();
    const auto preview_before = previewFrames();
    const auto capture_before = capture_->snapshot().submitted_frames;

    livekit_->setMicrophoneFrameSubmissionBlocked(true);
    struct SubmissionBlockGuard final {
      std::shared_ptr<DeterministicFakeLiveKitVoiceSession> session;
      ~SubmissionBlockGuard() {
        session->setMicrophoneFrameSubmissionBlocked(false);
      }
    } unblock{livekit_};
    require(submitFrame(false),
            "publication backpressure rejected capture ingress");
    livekit_->waitUntilMicrophoneFrameSubmissionPending(1, kWatchdog);
    for (std::size_t frame = 0;
         frame < MicrophonePcmQueue<>::capacity() + 2;
         ++frame) {
      require(submitFrame(false),
              "bounded publication queue blocked capture or preview");
    }
    require(
      previewFrames() >=
        preview_before + MicrophonePcmQueue<>::capacity() + 3,
      "publication backpressure stalled microphone preview"
    );
    require(
      capture_->snapshot().submitted_frames >=
        capture_before + MicrophonePcmQueue<>::capacity() + 3,
      "publication backpressure stalled microphone capture"
    );

    livekit_->setMicrophoneFrameSubmissionBlocked(false);
    livekit_->waitUntilMicrophoneFrameCount(published_before + 2, kWatchdog);
    waitForPublicationQuiescence();
    require(
      livekit_->microphoneDiscontinuityCount() ==
        discontinuities_before + 1,
      "publication queue saturation did not mark exactly one discontinuity"
    );
    ++backpressure_recoveries_;
  }

  void restartRuntime() {
    const auto retired_submit = capture_->latestSubmitToken();
    stopActor();
    capture_->waitForNoActiveAttempt();
    require(!capture_->submitRetained(retired_submit),
            "retired runtime epoch accepted retained capture PCM");
    ++host_epoch_;
    ++runtime_restarts_;
    startActor();
    desired_.set(std::string(kSession), generation_);
    connect();

    require(submitFrame(true),
            "runtime restart did not restore publication and preview PCM");
  }

  void shutdown() {
    if (!actor_) return;
    ++generation_;
    desired_.set(std::string(kSession), generation_);
    MediaCommand disconnect;
    disconnect.type = NativeCommandType::DisconnectMicrophone;
    disconnect.session_id = std::string(kSession);
    disconnect.generation = generation_;
    disconnect.diagnostic_host_epoch = host_epoch_;
    actor_->disconnect(disconnect, false);
    if (auto retired = deferred_.tryTake(NativeCommandType::MicrophoneRetireDone)) {
      actor_->handleWorkerCommand(*retired);
    } else {
      actor_->handleWorkerCommand(deferred_.take(
        NativeCommandType::MicrophoneRetireDone
      ));
    }
    if (preview_demanded_) {
      actor_->clearPreviewConsumer(std::string(kSession), generation_ - 1);
      preview_demanded_ = false;
    }
    stopActor();
    capture_->waitForNoActiveAttempt();
  }

 private:
  enum class MuteAssertion { None, Muted, Unmuted };

  void verifyCaptureRecreated(
      const ScriptedCapture::AttemptSnapshot& before,
      std::string_view expected_device,
      std::uint64_t expected_attempt_delta) const {
    const auto after = capture_->latestAttempt();
    if (after.count != before.count + expected_attempt_delta) {
      throw std::runtime_error(
        "microphone capture recreate attempt mismatch: before=" +
        std::to_string(before.count) + " expectedDelta=" +
        std::to_string(expected_attempt_delta) + " after=" +
        std::to_string(after.count) + " expectedDevice=" +
        std::string(expected_device) + " actualDevice=" + after.device_id
      );
    }
    require(after.epoch > before.epoch,
            "microphone capture recreate did not advance its exact epoch");
    require(after.device_id == expected_device,
            "microphone capture recreate opened the wrong endpoint");
    for (auto token = before.submit_token;
         token < after.submit_token;
         ++token) {
      require(!capture_->submitRetained(token),
              "retired same-actor capture epoch accepted PCM");
    }
  }

  void waitForPublicationQuiescence() const {
    auto previous = livekit_->microphoneFrameCount();
    const auto deadline = std::chrono::steady_clock::now() + 1s;
    while (std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(2ms);
      const auto current = livekit_->microphoneFrameCount();
      if (current == previous) return;
      previous = current;
    }
    throw std::runtime_error("microphone publication sink did not quiesce");
  }

  void verifyMuteTransition(
      std::uint64_t preview_before,
      std::uint64_t capture_frames_before) {
    if (pending_mute_assertion_ == MuteAssertion::None) return;
    const auto capture_after = capture_->snapshot();
    require(capture_after.submitted_frames > capture_frames_before,
            "mute transition stopped the real capture ingress");
    require(previewFrames() > preview_before,
            "mute transition stopped the active preview");
    if (pending_mute_assertion_ == MuteAssertion::Muted) {
      waitForPublicationQuiescence();
      require(
        livekit_->microphoneFrameCount() == publication_frames_at_transition_,
        "muted PCM reached the LiveKit publication sink"
      );
      require(
        livekit_->microphoneDiscontinuityCount() ==
          publication_discontinuities_at_transition_,
        "mute emitted a publication discontinuity before resumed PCM"
      );
    } else {
      livekit_->waitUntilMicrophoneFrameCount(
        publication_frames_at_transition_ + 1, kWatchdog
      );
      require(
        livekit_->microphoneFrameCount() > publication_frames_at_transition_,
        "unmute did not resume the LiveKit publication sink"
      );
      require(
        livekit_->microphoneDiscontinuityCount() ==
          publication_discontinuities_at_transition_ + 1,
        "first publication frame after unmute lost its discontinuity"
      );
    }
    pending_mute_assertion_ = MuteAssertion::None;
  }

  void startActor() {
    actor_ = std::make_unique<MicrophoneActor>(
      emitter_,
      [&](MediaCommand command) { return deferred_.post(std::move(command)); },
      [&](const std::string& session_id, std::uint64_t generation) {
        return desired_.isCurrent(session_id, generation);
      },
      livekit_,
      syrnike::desktop_native::media::MicrophoneIdleCaptureTiming{
        .grace = 50ms,
        .post_retry = 5ms,
      },
      std::shared_ptr<syrnike::desktop_native::media::WindowsAudioSessionAttemptPolicy>{},
      MicrophoneCaptureAdapter{
        .probe_candidate = [capture = capture_](
          MicrophoneCaptureCandidateRequest request
        ) {
          capture->probeCandidate(std::move(request));
        },
        .run = [capture = capture_](
          MicrophoneCaptureAttemptRequest request
        ) {
          capture->run(std::move(request));
        },
      }
    );
  }

  void stopActor() {
    if (!actor_) return;
    actor_->shutdown();
    actor_.reset();
    // A utility restart destroys its in-process mailbox. Commands posted by
    // the retired actor must never be replayed into the next host epoch.
    deferred_.clear();
  }

  void installPreviewConsumer() {
    actor_->setPreviewConsumer(
      std::string(kSession), generation_,
      [&](std::span<const std::int16_t> pcm) {
        require(pcm.size() == syrnike::voice::kSamplesPer10Ms,
                "preview received a non-10ms microphone frame");
        preview_frames_.fetch_add(1, std::memory_order_release);
      }
    );
  }

  void pumpProcessingStatus() {
    while (auto status = deferred_.tryTake(
        NativeCommandType::MicrophoneProcessingStatus)) {
      actor_->handleWorkerCommand(*status);
    }
  }

  std::shared_ptr<CollectingSink> sink_;
  SequencedEmitter emitter_;
  std::shared_ptr<DeterministicFakeLiveKitVoiceSession> livekit_;
  std::shared_ptr<ScriptedCapture> capture_;
  DeferredCommands deferred_;
  GenerationFence desired_;
  std::unique_ptr<MicrophoneActor> actor_;
  std::atomic_uint64_t preview_frames_{0};
  std::uint64_t host_epoch_ = 1;
  std::uint64_t generation_ = 1;
  std::uint64_t pipeline_revision_ = 1;
  std::uint64_t runtime_restarts_ = 0;
  std::uint64_t endpoint_recoveries_ = 0;
  std::uint64_t publication_recoveries_ = 0;
  std::uint64_t backpressure_recoveries_ = 0;
  std::uint64_t device_recreations_ = 0;
  bool muted_ = false;
  bool preview_demanded_ = true;
  MuteAssertion pending_mute_assertion_ = MuteAssertion::None;
  std::uint64_t publication_frames_at_transition_ = 0;
  std::uint64_t publication_discontinuities_at_transition_ = 0;
};

}  // namespace

int main() try {
  const auto profile = configuredProfile();
  require(
    profile.name != "production" || profile.durationSeconds() >= 30 * 60,
    "production microphone soak profile is shorter than 30 minutes"
  );
  require(livekit::initialize(livekit::LogLevel::Off),
          "failed to initialize LiveKit test runtime");

  exerciseCleanupSaturation([] {});
  {
    auto warm_sink = std::make_shared<CollectingSink>();
    auto warm_livekit =
      std::make_shared<DeterministicFakeLiveKitVoiceSession>();
    auto warm_capture = std::make_shared<ScriptedCapture>();
    MicrophoneActorRuntimeHarness warm_host(
      warm_sink, warm_livekit, warm_capture
    );
    warm_host.connect();
    require(warm_host.submitFrame(true),
            "microphone preflight failed to warm its runtime resources");
    warm_host.shutdown();
  }
  const auto cleanup_before = CleanupSupervisor::instance().snapshot();
  require(cleanup_before.owned_jobs == 0,
          "microphone preflight retained cleanup ownership");
  const DWORD handles_process_baseline = stableProcessHandleCount();

  auto sink = std::make_shared<CollectingSink>();
  auto livekit = std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  auto capture = std::make_shared<ScriptedCapture>();
  MicrophoneActorRuntimeHarness host(sink, livekit, capture);
  host.connect();
  const DWORD handles_active_baseline = stableProcessHandleCount();
  awaitUtilityHostEpochExercise();
  DWORD handles_after_first_restart = 0;
  DWORD handles_after_second_restart = 0;
  std::uint64_t cleanup_saturation_recoveries = 0;

  const auto schedule_started_at = std::chrono::steady_clock::now();
  auto next_frame_at = schedule_started_at;
  auto maximum_schedule_lag = std::chrono::steady_clock::duration::zero();
  std::uint64_t scheduled_frames = 0;
  for (std::uint64_t phase = 1; phase <= kSoakPhases; ++phase) {
    if (phase == 5 || phase == 35) host.setMuted(true);
    if (phase == 6 || phase == 36) host.setPreview(false);
    if (phase == 7 || phase == 37) host.setPreview(true);
    if (phase == 10 || phase == 40) host.setMuted(false);
    if (phase == 12 || phase == 42) host.defaultEndpointChanged();
    if (phase == 15 || phase == 45) host.saturatePublicationBackpressure();
    if (phase == 18 || phase == 48) host.removeSelectedEndpointAndRecover();
    if (phase == 21 || phase == 51) {
      exerciseCleanupSaturation([&] {
        require(host.submitFrame(true),
                "cleanup saturation stalled active microphone capture");
      });
      ++cleanup_saturation_recoveries;
    }
    if (phase == 24 || phase == 54) host.failPublicationAndRecover();
    if (phase == 30 || phase == 60) host.restartRuntime();

    if (profile.realtime) {
      next_frame_at = std::max(
        next_frame_at, std::chrono::steady_clock::now()
      );
    }
    for (std::uint64_t frame = 0; frame < profile.frames_per_phase; ++frame) {
      require(host.submitFrame(frame == 0),
              "current capture epoch rejected scheduled PCM");
      ++scheduled_frames;
      if (profile.realtime) {
        next_frame_at += kFramePeriod;
        std::this_thread::sleep_until(next_frame_at);
        const auto woke_at = std::chrono::steady_clock::now();
        if (woke_at > next_frame_at) {
          maximum_schedule_lag = std::max(
            maximum_schedule_lag, woke_at - next_frame_at
          );
        }
      }
    }
    if (phase == 30) {
      handles_after_first_restart = stableProcessHandleCount();
    }
    if (phase == 60) {
      handles_after_second_restart = stableProcessHandleCount();
    }
  }

  const auto final_submit = capture->latestSubmitToken();
  const auto schedule_elapsed =
    std::chrono::steady_clock::now() - schedule_started_at;
  require(
    !profile.realtime || schedule_elapsed >= 30min,
    "production microphone soak did not sustain the 100 Hz schedule for 30 minutes"
  );
  require(
    !profile.realtime ||
      (schedule_elapsed <= 31min && maximum_schedule_lag <= 250ms),
    "production microphone soak exceeded its bounded 100 Hz deadline lag"
  );
  host.shutdown();
  require(!capture->submitRetained(final_submit),
          "shutdown MicrophoneActor accepted retained capture PCM");
  const auto capture_after = capture->snapshot();
  require(capture_after.active_attempts == 0,
          "microphone soak retained a capture attempt after shutdown");
  require(capture_after.peak_active_attempts == 1,
          "microphone soak exceeded one capture attempt owner");
  require(capture_after.rejected_frames == 0,
          "current capture epoch rejected PCM during the soak");
  require(capture_after.terminal_faults == host.endpointRecoveries(),
          "capture terminal count did not match endpoint recoveries");
  require(capture_after.candidate_probes > 0 &&
            capture_after.candidate_health_observations ==
              capture_after.candidate_probes &&
            capture_after.old_capture_health_during_candidate_probes ==
              capture_after.candidate_probes,
          "capture candidate promotion lacked deterministic PCM health evidence");
  require(host.endpointRecoveries() == 2 &&
          host.publicationRecoveries() == 2 &&
          host.runtimeRestarts() == 2 &&
          host.backpressureRecoveries() == 2 &&
          host.deviceRecreations() == 4 &&
          cleanup_saturation_recoveries == 2,
          "CI and production profiles diverged from the fixed fault schedule");
  require(
    scheduled_frames == kSoakPhases * profile.frames_per_phase,
    "microphone soak did not drive its exact scheduled frame count"
  );
  require(
    livekit->microphoneDiscontinuityCount() == 4,
    "publication sink observed a missing or unexpected discontinuity"
  );
  const auto minimum_published_frames =
    (kSoakPhases - 10) * profile.frames_per_phase;
  require(
    livekit->microphoneFrameCount() >= minimum_published_frames &&
      livekit->microphoneFrameCount() <= capture_after.submitted_frames,
    "publication sink stalled or exceeded accepted capture frames"
  );
  require(host.previewFrames() > 0,
          "microphone preview received no production-shaped PCM");
  require(livekit->disconnectCallCount() == 0,
          "microphone-local recovery disconnected the shared voice Room");
  require(sink->microphoneErrorCount() == 0,
          "recoverable microphone fault emitted a terminal track error");

  const auto cleanup_deadline = std::chrono::steady_clock::now() + 5s;
  auto cleanup_after = CleanupSupervisor::instance().snapshot();
  while (cleanup_after.owned_jobs != cleanup_before.owned_jobs &&
         std::chrono::steady_clock::now() < cleanup_deadline) {
    std::this_thread::sleep_for(2ms);
    cleanup_after = CleanupSupervisor::instance().snapshot();
  }
  require(cleanup_after.worker_limit == kExpectedCleanupWorkers &&
          cleanup_after.admission_capacity == kExpectedCleanupCapacity &&
          cleanup_after.worker_threads == kExpectedCleanupWorkers &&
          cleanup_after.worker_handles == kExpectedCleanupWorkers &&
          cleanup_after.peak_owned_jobs == kExpectedCleanupCapacity,
          "microphone soak exceeded cleanup thread, handle, or queue bounds");
  require(cleanup_after.owned_jobs == cleanup_before.owned_jobs,
          "microphone soak did not return cleanup ownership to baseline");
  require(
    cleanup_after.active_jobs == 0 && cleanup_after.backlog_jobs == 0 &&
      cleanup_after.saturated_submissions ==
        cleanup_before.saturated_submissions + cleanup_saturation_recoveries,
    "microphone soak lost exact cleanup saturation recovery telemetry"
  );

  const DWORD handles_after = stableProcessHandleCount();
  if (handles_after_first_restart != handles_active_baseline ||
      handles_after_second_restart != handles_active_baseline) {
    throw std::runtime_error(
      "microphone runtime restart changed exact active handle baseline: active=" +
      std::to_string(handles_active_baseline) +
      " firstRestart=" + std::to_string(handles_after_first_restart) +
      " secondRestart=" + std::to_string(handles_after_second_restart)
    );
  }
  if (handles_after != handles_process_baseline) {
    throw std::runtime_error(
      "microphone shutdown missed exact warmed process handle baseline: baseline=" +
      std::to_string(handles_process_baseline) +
      " final=" + std::to_string(handles_after)
    );
  }

  std::cout << "microphone resilience soak passed: profile=" << profile.name
            << " durationSeconds=" << profile.durationSeconds()
            << " wallMilliseconds="
            << std::chrono::duration_cast<std::chrono::milliseconds>(
                 schedule_elapsed
               ).count()
            << " maximumScheduleLagMilliseconds="
            << std::chrono::duration_cast<std::chrono::milliseconds>(
                 maximum_schedule_lag
               ).count()
            << " scheduledFrames=" << scheduled_frames
            << " attempts=" << capture_after.attempts
            << " candidateProbes=" << capture_after.candidate_probes
            << " submittedFrames=" << capture_after.submitted_frames
            << " publishedFrames=" << livekit->microphoneFrameCount()
            << " endpointRecoveries=" << host.endpointRecoveries()
            << " publicationRecoveries=" << host.publicationRecoveries()
            << " backpressureRecoveries=" << host.backpressureRecoveries()
            << " deviceRecreations=" << host.deviceRecreations()
            << " cleanupSaturations=" << cleanup_saturation_recoveries
            << " runtimeRestarts=" << host.runtimeRestarts()
            << " hostEpoch=" << host.epoch()
            << " cleanupCapacity=" << cleanup_after.admission_capacity
            << '\n';
  livekit::shutdown();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  livekit::shutdown();
  return 1;
}
