#include "preview_actor.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include "../common/cleanup_supervisor.hpp"
#include "audio_constants.hpp"
#include "audio_devices.hpp"
#include "media_runtime_support.hpp"
#include "microphone_pcm_queue.hpp"
#include "realtime_snapshot.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {
namespace {

constexpr std::size_t max_queued_frames = 10;
constexpr std::size_t max_quarantined_attempts = 2;

class PreviewEmitterGate final {
 public:
  explicit PreviewEmitterGate(SequencedEmitter& emitter) : emitter_(&emitter) {}

  bool emit(RuntimeEvent event) {
    SequencedEmitter* emitter = nullptr;
    {
      std::lock_guard lock(mutex_);
      if (!enabled_) return false;
      emitter = emitter_;
      ++in_flight_;
    }
    try {
      emitter->emit(std::move(event));
    } catch (...) {
      leave();
      throw;
    }
    leave();
    return true;
  }

  void disable() noexcept {
    std::unique_lock lock(mutex_);
    enabled_ = false;
    changed_.wait(lock, [&] { return in_flight_ == 0; });
    emitter_ = nullptr;
  }

 private:
  void leave() noexcept {
    {
      std::lock_guard lock(mutex_);
      --in_flight_;
      if (in_flight_ == 0) changed_.notify_all();
    }
  }

  std::mutex mutex_;
  std::condition_variable changed_;
  SequencedEmitter* emitter_ = nullptr;
  bool enabled_ = true;
  std::size_t in_flight_ = 0;
};

}  // namespace

class PreviewActor::Implementation {
  struct AttemptState;
  struct RealtimeRoute {
    std::shared_ptr<AttemptState> attempt;
  };
  using RealtimeRoutes = RealtimeSnapshotDomain<RealtimeRoute, 8>;

 public:
  Implementation(
      SequencedEmitter& emitter,
      PreviewActor::BeforeRenderOperation before_render_operation,
      PreviewActor::BeforeFrameOperation before_frame_operation)
      : emitter_(std::make_shared<PreviewEmitterGate>(emitter)),
        before_render_operation_(std::move(before_render_operation)),
        before_frame_operation_(std::move(before_frame_operation)),
        cleanup_supervisor_(&CleanupSupervisor::instance()),
        cleanup_domain_(std::make_shared<CleanupDomain>()),
        current_route_(std::make_unique<const RealtimeRoute>()) {}

  ~Implementation() { shutdown(); }

  RuntimeEvent start(const MediaCommand& command) {
    std::lock_guard operation_lock(operation_mutex_);
    if (shutdown_.load(std::memory_order_acquire)) {
      throw std::runtime_error("microphone preview actor is shut down");
    }

    if (auto previous = takeCurrent()) {
      retireAttempt(
          previous,
          std::chrono::steady_clock::now() + kNativeShutdownBudget);
    }
    if (cleanup_domain_->quarantined.load(std::memory_order_acquire) >=
        max_quarantined_attempts) {
      throw std::runtime_error(
          "microphone preview cleanup capacity is exhausted");
    }

    auto attempt = std::make_shared<AttemptState>(
        command,
        emitter_,
        before_render_operation_,
        cleanup_domain_);
    setCurrent(attempt);
    try {
      attempt->worker = std::thread([raw = attempt.get()] {
        runAttempt(*raw);
      });
    } catch (...) {
      clearCurrentIf(attempt);
      throw;
    }

    bool ready = false;
    std::string startup_error;
    {
      std::unique_lock lock(attempt->state_mutex);
      attempt->startup_changed.wait_for(
          lock,
          std::chrono::seconds(5),
          [&] {
            return attempt->ready.load(std::memory_order_acquire) ||
                !attempt->startup_error.empty() ||
                attempt->finished.load(std::memory_order_acquire) ||
                !attempt->events_enabled.load(std::memory_order_acquire);
          });
      ready = attempt->ready.load(std::memory_order_acquire) &&
        attempt->events_enabled.load(std::memory_order_acquire);
      startup_error = attempt->startup_error;
    }
    if (!ready) {
      clearCurrentIf(attempt);
      retireAttempt(
          attempt,
          std::chrono::steady_clock::now() + kNativeShutdownBudget);
      if (startup_error.empty()) {
        startup_error = "microphone preview render startup timed out";
      }
      throw std::runtime_error(startup_error);
    }

    RuntimeEvent reply;
    reply.type = NativeEventType::Reply;
    reply.request_id = command.request_id;
    reply.session_id = command.session_id;
    reply.generation = command.generation;
    reply.kind = "preview";
    reply.ok = true;
    return reply;
  }

  void pushFrame(
      const std::string& session_id,
      std::uint64_t generation,
      std::span<const std::int16_t> pcm) {
    auto reader = current_route_.claimReader();
    auto route = current_route_.acquire(reader);
    const auto& attempt = route.get().attempt;
    if (!attempt || attempt->command.session_id != session_id ||
        attempt->command.generation != generation) {
      return;
    }
    if (before_frame_operation_) before_frame_operation_();

    if (!attempt->events_enabled.load(std::memory_order_acquire) ||
        !attempt->ready.load(std::memory_order_acquire) ||
        !attempt->running.load(std::memory_order_acquire)) {
      return;
    }
    const auto queued = attempt->queued_frames.push(pcm);
    if (queued == MicrophonePcmQueuePush::InvalidFrame) {
      attempt->invalid_frames.fetch_add(1, std::memory_order_relaxed);
      return;
    }
    if (queued == MicrophonePcmQueuePush::Full) {
      attempt->dropped_frames.fetch_add(1, std::memory_order_relaxed);
      return;
    }
    attempt->accepted_frames.fetch_add(1, std::memory_order_relaxed);
    attempt->audio_ready.notify_one();
  }

  [[nodiscard]] PreviewQueueMetrics queueMetrics() const noexcept {
    const auto attempt = current();
    if (!attempt) return {};
    return PreviewQueueMetrics{
      attempt->accepted_frames.load(std::memory_order_relaxed),
      attempt->dropped_frames.load(std::memory_order_relaxed),
      attempt->invalid_frames.load(std::memory_order_relaxed),
      attempt->queued_frames.size(),
    };
  }

  void stop(const MediaCommand& command, bool emit_stopped) {
    std::lock_guard operation_lock(operation_mutex_);
    auto attempt = takeCurrentMatching(command.session_id, command.generation);
    if (!attempt) return;

    const auto terminal_emitted = retireAttempt(
        attempt,
        std::chrono::steady_clock::now() + kNativeShutdownBudget);
    if (emit_stopped && !terminal_emitted &&
        !attempt->command.session_id.empty()) {
      RuntimeEvent event;
      event.type = NativeEventType::SessionStopped;
      event.session_id = attempt->command.session_id;
      event.generation = attempt->command.generation;
      event.reason = "preview_stopped";
      emitter_->emit(std::move(event));
    }
  }

  bool failFromCapture(
      const std::string& session_id,
      std::uint64_t generation,
      const std::string& message) {
    std::lock_guard operation_lock(operation_mutex_);
    auto attempt = takeCurrentMatching(session_id, generation);
    if (!attempt) return false;
    {
      std::lock_guard lock(attempt->state_mutex);
      if (attempt->terminal_emitted) {
        setCurrent(attempt);
        return false;
      }
      attempt->terminal_emitted = true;
      attempt->events_enabled.store(false, std::memory_order_release);
      attempt->ready.store(false, std::memory_order_release);
      attempt->running.store(false, std::memory_order_release);
    }
    attempt->startup_changed.notify_all();
    attempt->audio_ready.notify_all();
    retireAttempt(
        attempt,
        std::chrono::steady_clock::now() + kNativeShutdownBudget);

    RuntimeEvent error;
    error.type = NativeEventType::RuntimeError;
    error.session_id = session_id;
    error.generation = generation;
    error.error = NativeError{
        "microphone_preview_failed",
        message,
        "preview",
        true,
        session_id,
        generation,
    };
    emitter_->emit(std::move(error));

    RuntimeEvent stopped;
    stopped.type = NativeEventType::SessionStopped;
    stopped.session_id = session_id;
    stopped.generation = generation;
    stopped.reason = "runtime_error";
    emitter_->emit(std::move(stopped));
    return true;
  }

  void shutdown(
      std::optional<std::chrono::steady_clock::time_point> stop_by =
          std::nullopt) {
    std::lock_guard operation_lock(operation_mutex_);
    if (shutdown_.exchange(true, std::memory_order_acq_rel)) return;
    emitter_->disable();
    if (auto attempt = takeCurrent()) {
      retireAttempt(
          attempt,
          stop_by.value_or(
              std::chrono::steady_clock::now() + kNativeShutdownBudget));
    }
  }

 private:
  struct CleanupDomain {
    std::atomic_size_t quarantined{0};
  };

  struct AttemptState {
    AttemptState(
        MediaCommand value,
        std::shared_ptr<PreviewEmitterGate> emitter_gate,
        PreviewActor::BeforeRenderOperation render_operation,
        std::shared_ptr<CleanupDomain> domain)
        : command(std::move(value)),
          emitter(std::move(emitter_gate)),
          before_render_operation(std::move(render_operation)),
          cleanup_domain(std::move(domain)),
          cleanup_job(std::make_shared<CleanupJob>()) {}

    const MediaCommand command;
    const std::shared_ptr<PreviewEmitterGate> emitter;
    const PreviewActor::BeforeRenderOperation before_render_operation;
    const std::shared_ptr<CleanupDomain> cleanup_domain;
    const std::shared_ptr<CleanupJob> cleanup_job;
    std::mutex state_mutex;
    std::condition_variable startup_changed;
    std::atomic_bool events_enabled{true};
    std::atomic_bool ready{false};
    bool terminal_emitted = false;
    std::string startup_error;
    std::atomic_bool running{true};
    std::condition_variable audio_ready;
    std::mutex audio_wait_mutex;
    MicrophonePcmQueue<
      syrnike::voice::kSamplesPer10Ms,
      max_queued_frames
    > queued_frames;
    std::atomic_uint64_t accepted_frames{0};
    std::atomic_uint64_t dropped_frames{0};
    std::atomic_uint64_t invalid_frames{0};
    std::mutex finished_mutex;
    std::condition_variable finished_changed;
    std::atomic_bool finished{false};
    std::thread worker;
  };

  struct FinishedGuard {
    explicit FinishedGuard(AttemptState& value) : attempt(value) {}
    ~FinishedGuard() {
      attempt.finished.store(true, std::memory_order_release);
      attempt.finished_changed.notify_all();
    }
    AttemptState& attempt;
  };

  static bool markReady(AttemptState& attempt) {
    {
      std::lock_guard lock(attempt.state_mutex);
      if (!attempt.events_enabled.load(std::memory_order_acquire) ||
          !attempt.running.load(std::memory_order_acquire)) {
        return false;
      }
      attempt.ready.store(true, std::memory_order_release);
    }
    attempt.startup_changed.notify_all();
    return true;
  }

  static bool markFailed(AttemptState& attempt, std::string message) {
    bool report = false;
    {
      std::lock_guard lock(attempt.state_mutex);
      if (attempt.events_enabled.load(std::memory_order_acquire)) {
        attempt.startup_error = std::move(message);
        attempt.ready.store(false, std::memory_order_release);
        report = true;
      }
      attempt.running.store(false, std::memory_order_release);
    }
    attempt.startup_changed.notify_all();
    attempt.audio_ready.notify_all();
    return report;
  }

  static void emitTerminalFailure(
      AttemptState& attempt,
      const std::string& message) noexcept {
    {
      std::lock_guard lock(attempt.state_mutex);
      if (!attempt.events_enabled.load(std::memory_order_acquire) ||
          attempt.terminal_emitted) return;
      attempt.terminal_emitted = true;
      attempt.ready.store(false, std::memory_order_release);
    }

    RuntimeEvent error;
    error.type = NativeEventType::RuntimeError;
    error.session_id = attempt.command.session_id;
    error.generation = attempt.command.generation;
    error.error = NativeError{
        "microphone_preview_failed",
        message,
        "preview",
        true,
        attempt.command.session_id,
        attempt.command.generation,
    };
    try {
      attempt.emitter->emit(std::move(error));
    } catch (...) {
    }

    RuntimeEvent stopped;
    stopped.type = NativeEventType::SessionStopped;
    stopped.session_id = attempt.command.session_id;
    stopped.generation = attempt.command.generation;
    stopped.reason = "runtime_error";
    try {
      attempt.emitter->emit(std::move(stopped));
    } catch (...) {
    }
  }

  static void runAttempt(AttemptState& attempt) noexcept {
    FinishedGuard finished(attempt);
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    DWORD task_index = 0;
    HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    bool had_started = false;

    try {
      if (attempt.before_render_operation) {
        if (markReady(attempt)) {
          had_started = true;
          attempt.before_render_operation();
        }
      } else {
        auto render_device = renderDevice();
        ComPtr<IAudioClient> render_client;
        auto result = render_device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            reinterpret_cast<void**>(render_client.GetAddressOf()));
        if (FAILED(result)) {
          throw std::runtime_error(
              "failed to activate preview render client");
        }
        auto render_format = desiredRenderFormat();
        result = render_client->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            10'000'000,
            0,
            &render_format,
            nullptr);
        if (FAILED(result)) {
          throw std::runtime_error(
              "failed to initialize preview render stream");
        }
        ComPtr<IAudioRenderClient> render;
        result = render_client->GetService(IID_PPV_ARGS(&render));
        if (FAILED(result)) {
          throw std::runtime_error("failed to open preview render client");
        }
        UINT32 render_capacity = 0;
        result = render_client->GetBufferSize(&render_capacity);
        if (FAILED(result) || render_capacity == 0) {
          throw std::runtime_error(
              "failed to query preview render capacity");
        }
        result = render_client->Start();
        if (FAILED(result)) {
          throw std::runtime_error("failed to start preview render stream");
        }
        had_started = true;
        if (markReady(attempt)) {
          std::array<
            std::int16_t,
            syrnike::voice::kSamplesPer10Ms
          > pending_frame{};
          std::size_t pending_offset = pending_frame.size();
          while (attempt.running.load(std::memory_order_acquire)) {
            UINT32 padding = 0;
            if (FAILED(render_client->GetCurrentPadding(&padding))) {
              throw std::runtime_error(
                  "preview render padding query failed");
            }
            const auto available = render_capacity > padding
                ? render_capacity - padding
                : 0;
            const auto queued_size =
              (pending_offset < pending_frame.size()
                ? pending_frame.size() - pending_offset
                : 0) +
              attempt.queued_frames.size() * pending_frame.size();
            const auto to_write = static_cast<UINT32>(
                (std::min)(
                    static_cast<std::size_t>(available), queued_size));
            if (to_write > 0) {
              BYTE* output = nullptr;
              if (FAILED(render->GetBuffer(to_write, &output))) {
                throw std::runtime_error(
                    "preview render buffer write failed");
              }
              auto* samples = reinterpret_cast<float*>(output);
              for (UINT32 index = 0; index < to_write; ++index) {
                if (pending_offset == pending_frame.size()) {
                  if (!attempt.queued_frames.pop(pending_frame)) {
                    throw std::runtime_error(
                      "preview SPSC queue lost an advertised frame"
                    );
                  }
                  pending_offset = 0;
                }
                samples[index] =
                  static_cast<float>(pending_frame[pending_offset++]) /
                  32768.0f;
              }
              if (FAILED(render->ReleaseBuffer(to_write, 0))) {
                throw std::runtime_error(
                    "preview render buffer release failed");
              }
            }
            std::unique_lock lock(attempt.audio_wait_mutex);
            attempt.audio_ready.wait_for(
                lock,
                std::chrono::milliseconds(2),
                [&] {
                  return !attempt.running.load(std::memory_order_acquire) ||
                      pending_offset < pending_frame.size() ||
                      !attempt.queued_frames.empty();
                });
          }
        }
        static_cast<void>(render_client->Stop());
      }
    } catch (const std::exception& error) {
      const auto message = std::string(error.what());
      if (markFailed(attempt, message) && had_started) {
        emitTerminalFailure(attempt, message);
      }
    } catch (...) {
      const auto message = std::string(
          "unknown microphone preview render failure");
      if (markFailed(attempt, message) && had_started) {
        emitTerminalFailure(attempt, message);
      }
    }

    if (avrt) AvRevertMmThreadCharacteristics(avrt);
    if (com_initialized) CoUninitialize();
  }

  static bool deactivate(const std::shared_ptr<AttemptState>& attempt) {
    bool terminal_emitted = false;
    {
      std::lock_guard lock(attempt->state_mutex);
      terminal_emitted = attempt->terminal_emitted;
      attempt->events_enabled.store(false, std::memory_order_release);
      attempt->ready.store(false, std::memory_order_release);
      attempt->running.store(false, std::memory_order_release);
    }
    attempt->startup_changed.notify_all();
    attempt->audio_ready.notify_all();
    return terminal_emitted;
  }

  static void clearQueue(AttemptState& attempt) noexcept {
    attempt.queued_frames.clear();
  }

  static void joinAttempt(void* context) noexcept {
    auto* attempt = static_cast<AttemptState*>(context);
    if (attempt->worker.joinable() &&
        attempt->worker.get_id() != std::this_thread::get_id()) {
      attempt->worker.join();
    }
    clearQueue(*attempt);
  }

  static void completeQuarantine(void* context) noexcept {
    auto* attempt = static_cast<AttemptState*>(context);
    attempt->cleanup_domain->quarantined.fetch_sub(
        1, std::memory_order_acq_rel);
  }

  bool waitForFinished(
      const std::shared_ptr<AttemptState>& attempt,
      std::chrono::steady_clock::time_point deadline) noexcept {
    if (!attempt->worker.joinable()) return true;
    std::unique_lock lock(attempt->finished_mutex);
    attempt->finished_changed.wait_until(lock, deadline, [&] {
      return attempt->finished.load(std::memory_order_acquire);
    });
    return attempt->finished.load(std::memory_order_acquire);
  }

  bool retireAttempt(
      const std::shared_ptr<AttemptState>& attempt,
      std::chrono::steady_clock::time_point deadline) {
    const auto terminal_emitted = deactivate(attempt);
    if (waitForFinished(attempt, deadline)) {
      joinAttempt(attempt.get());
      return terminal_emitted;
    }

    attempt->cleanup_domain->quarantined.fetch_add(
        1, std::memory_order_acq_rel);
    attempt->cleanup_job->prepare(
        attempt,
        attempt.get(),
        reinterpret_cast<CleanupResourceKey>(attempt->cleanup_domain.get()),
        joinAttempt,
        completeQuarantine);
    cleanup_supervisor_->submitOrEscalate(
        attempt->cleanup_job,
        "microphone_preview");
    return terminal_emitted;
  }

  [[nodiscard]] std::shared_ptr<AttemptState> current() const {
    return current_.load(std::memory_order_acquire);
  }

  void setCurrent(const std::shared_ptr<AttemptState>& attempt) {
    current_.store(attempt, std::memory_order_release);
    current_route_.publish(
        std::make_unique<const RealtimeRoute>(RealtimeRoute{attempt}));
  }

  [[nodiscard]] std::shared_ptr<AttemptState> takeCurrent() {
    auto attempt = current_.exchange({}, std::memory_order_acq_rel);
    if (attempt) {
      current_route_.publish(std::make_unique<const RealtimeRoute>());
    }
    return attempt;
  }

  [[nodiscard]] std::shared_ptr<AttemptState> takeCurrentMatching(
      const std::string& session_id,
      std::uint64_t generation) {
    auto current = current_.load(std::memory_order_acquire);
    if (!current) return {};
    if (!session_id.empty() &&
        (current->command.session_id != session_id ||
         current->command.generation != generation)) {
      return {};
    }
    if (!current_.compare_exchange_strong(
          current, {}, std::memory_order_acq_rel, std::memory_order_acquire
        )) {
      return {};
    }
    current_route_.publish(std::make_unique<const RealtimeRoute>());
    return current;
  }

  void clearCurrentIf(const std::shared_ptr<AttemptState>& attempt) {
    auto expected = attempt;
    if (current_.compare_exchange_strong(
          expected, {}, std::memory_order_acq_rel, std::memory_order_acquire
        )) {
      current_route_.publish(std::make_unique<const RealtimeRoute>());
    }
  }

  std::shared_ptr<PreviewEmitterGate> emitter_;
  PreviewActor::BeforeRenderOperation before_render_operation_;
  PreviewActor::BeforeFrameOperation before_frame_operation_;
  CleanupSupervisor* cleanup_supervisor_;
  std::shared_ptr<CleanupDomain> cleanup_domain_;
  std::atomic_bool shutdown_{false};
  std::mutex operation_mutex_;
  std::atomic<std::shared_ptr<AttemptState>> current_{};
  RealtimeRoutes current_route_;
};

PreviewActor::PreviewActor(
    SequencedEmitter& emitter,
    BeforeRenderOperation before_render_operation,
    BeforeFrameOperation before_frame_operation)
    : implementation_(std::make_shared<Implementation>(
          emitter,
          std::move(before_render_operation),
          std::move(before_frame_operation))) {}

PreviewActor::~PreviewActor() {
  if (implementation_) implementation_->shutdown();
}

RuntimeEvent PreviewActor::start(const MediaCommand& command) {
  return implementation_->start(command);
}

void PreviewActor::pushFrame(
    const std::string& session_id,
    std::uint64_t generation,
    std::span<const std::int16_t> pcm) {
  implementation_->pushFrame(session_id, generation, pcm);
}

bool PreviewActor::failFromCapture(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& message) {
  return implementation_->failFromCapture(session_id, generation, message);
}

void PreviewActor::stop(const MediaCommand& command, bool emit_stopped) {
  implementation_->stop(command, emit_stopped);
}

void PreviewActor::shutdown() { implementation_->shutdown(); }

void PreviewActor::shutdown(std::chrono::steady_clock::time_point deadline) {
  implementation_->shutdown(deadline);
}

PreviewQueueMetrics PreviewActor::queueMetrics() const noexcept {
  return implementation_->queueMetrics();
}

}  // namespace syrnike::desktop_native::media
