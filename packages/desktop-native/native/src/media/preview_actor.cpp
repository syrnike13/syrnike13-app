#include "preview_actor.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include "audio_devices.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {
namespace {

constexpr std::size_t max_queued_samples = 4'800;

}  // namespace

class PreviewActor::Implementation {
 public:
  explicit Implementation(SequencedEmitter& emitter) : emitter_(emitter) {}
  ~Implementation() { shutdown(); }

  RuntimeEvent start(const MediaCommand& command) {
    stopInternal(false);
    {
      std::lock_guard lock(state_mutex_);
      session_id_ = command.session_id;
      generation_ = command.generation;
      ready_ = false;
      terminal_emitted_ = false;
      startup_error_.clear();
      running_.store(true);
    }
    {
      std::lock_guard lock(audio_mutex_);
      queued_samples_.clear();
    }
    worker_ = std::thread([this, command] { run(command); });

    std::unique_lock lock(state_mutex_);
    startup_changed_.wait_for(lock, std::chrono::seconds(5), [&] {
      return ready_ || !startup_error_.empty();
    });
    if (!ready_) {
      const auto error = startup_error_.empty()
        ? std::string("microphone preview render startup timed out")
        : startup_error_;
      lock.unlock();
      stopInternal(false);
      throw std::runtime_error(error);
    }

    RuntimeEvent reply;
    reply.type = "reply";
    reply.request_id = command.request_id;
    reply.session_id = command.session_id;
    reply.generation = command.generation;
    reply.kind = "preview";
    reply.ok = true;
    return reply;
  }

  void pushFrame(std::span<const std::int16_t> pcm) {
    if (!running_.load()) return;
    {
      std::lock_guard lock(state_mutex_);
      if (!ready_) return;
    }
    {
      std::lock_guard lock(audio_mutex_);
      for (const auto sample : pcm) {
        queued_samples_.push_back(static_cast<float>(sample) / 32768.0f);
      }
      while (queued_samples_.size() > max_queued_samples) queued_samples_.pop_front();
    }
    audio_ready_.notify_one();
  }

  void stop(const MediaCommand& command, bool emit_stopped) {
    {
      std::lock_guard lock(state_mutex_);
      if (!command.session_id.empty() && session_id_ != command.session_id) return;
      if (!command.session_id.empty() && generation_ != command.generation) return;
    }
    stopInternal(emit_stopped);
  }

  bool failFromCapture(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& message
  ) {
    {
      std::lock_guard lock(state_mutex_);
      if (
        session_id_ != session_id || generation_ != generation || terminal_emitted_
      ) return false;
      terminal_emitted_ = true;
      ready_ = false;
      running_.store(false);
    }
    audio_ready_.notify_all();
    if (worker_.joinable()) worker_.join();
    {
      std::lock_guard lock(audio_mutex_);
      queued_samples_.clear();
    }

    RuntimeEvent error;
    error.type = "runtimeError";
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
    emitter_.emit(std::move(error));
    RuntimeEvent stopped;
    stopped.type = "sessionStopped";
    stopped.session_id = session_id;
    stopped.generation = generation;
    stopped.reason = "runtime_error";
    emitter_.emit(std::move(stopped));
    return true;
  }

  void shutdown() { stopInternal(false); }

 private:
  void stopInternal(bool emit_stopped) {
    std::string session_id;
    std::uint64_t generation = 0;
    bool terminal_emitted = false;
    {
      std::lock_guard lock(state_mutex_);
      session_id = session_id_;
      generation = generation_;
      terminal_emitted = terminal_emitted_;
      running_.store(false);
    }
    audio_ready_.notify_all();
    if (worker_.joinable()) worker_.join();
    {
      std::lock_guard lock(audio_mutex_);
      queued_samples_.clear();
    }
    {
      std::lock_guard lock(state_mutex_);
      session_id_.clear();
      generation_ = 0;
      ready_ = false;
      terminal_emitted_ = false;
      startup_error_.clear();
    }
    if (emit_stopped && !terminal_emitted && !session_id.empty()) {
      RuntimeEvent event;
      event.type = "sessionStopped";
      event.session_id = std::move(session_id);
      event.generation = generation;
      event.reason = "preview_stopped";
      emitter_.emit(std::move(event));
    }
  }

  void markReady() {
    {
      std::lock_guard lock(state_mutex_);
      ready_ = true;
    }
    startup_changed_.notify_all();
  }

  void markFailed(std::string message) {
    {
      std::lock_guard lock(state_mutex_);
      startup_error_ = std::move(message);
      ready_ = false;
      running_.store(false);
    }
    startup_changed_.notify_all();
    audio_ready_.notify_all();
  }

  void emitTerminalFailure(const MediaCommand& command, const std::string& message) {
    {
      std::lock_guard lock(state_mutex_);
      if (terminal_emitted_) return;
      terminal_emitted_ = true;
    }
    RuntimeEvent error;
    error.type = "runtimeError";
    error.session_id = command.session_id;
    error.generation = command.generation;
    error.error = NativeError{
      "microphone_preview_failed",
      message,
      "preview",
      true,
      command.session_id,
      command.generation,
    };
    emitter_.emit(std::move(error));

    RuntimeEvent stopped;
    stopped.type = "sessionStopped";
    stopped.session_id = command.session_id;
    stopped.generation = command.generation;
    stopped.reason = "runtime_error";
    emitter_.emit(std::move(stopped));
  }

  void run(const MediaCommand& command) {
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    DWORD task_index = 0;
    HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    bool had_started = false;
    try {
      auto render_device = renderDevice();
      ComPtr<IAudioClient> render_client;
      auto result = render_device->Activate(
        __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
        reinterpret_cast<void**>(render_client.GetAddressOf())
      );
      if (FAILED(result)) throw std::runtime_error("failed to activate preview render client");
      auto render_format = desiredRenderFormat();
      result = render_client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        10'000'000, 0, &render_format, nullptr
      );
      if (FAILED(result)) throw std::runtime_error("failed to initialize preview render stream");
      ComPtr<IAudioRenderClient> render;
      result = render_client->GetService(IID_PPV_ARGS(&render));
      if (FAILED(result)) throw std::runtime_error("failed to open preview render client");
      UINT32 render_capacity = 0;
      result = render_client->GetBufferSize(&render_capacity);
      if (FAILED(result) || render_capacity == 0) {
        throw std::runtime_error("failed to query preview render capacity");
      }
      result = render_client->Start();
      if (FAILED(result)) throw std::runtime_error("failed to start preview render stream");
      had_started = true;
      markReady();

      while (running_.load()) {
        UINT32 padding = 0;
        if (FAILED(render_client->GetCurrentPadding(&padding))) {
          throw std::runtime_error("preview render padding query failed");
        }
        const auto available = render_capacity > padding ? render_capacity - padding : 0;
        std::size_t queued_size = 0;
        {
          std::lock_guard lock(audio_mutex_);
          queued_size = queued_samples_.size();
        }
        const auto to_write = static_cast<UINT32>(
          std::min<std::size_t>(available, queued_size)
        );
        if (to_write > 0) {
          BYTE* output = nullptr;
          if (FAILED(render->GetBuffer(to_write, &output))) {
            throw std::runtime_error("preview render buffer write failed");
          }
          auto* samples = reinterpret_cast<float*>(output);
          {
            std::lock_guard lock(audio_mutex_);
            for (UINT32 index = 0; index < to_write; ++index) {
              samples[index] = queued_samples_.front();
              queued_samples_.pop_front();
            }
          }
          if (FAILED(render->ReleaseBuffer(to_write, 0))) {
            throw std::runtime_error("preview render buffer release failed");
          }
        }
        std::unique_lock lock(audio_mutex_);
        audio_ready_.wait_for(lock, std::chrono::milliseconds(2));
      }
      render_client->Stop();
    } catch (const std::exception& error) {
      markFailed(error.what());
      if (had_started) emitTerminalFailure(command, error.what());
    }
    if (avrt) AvRevertMmThreadCharacteristics(avrt);
    if (com_initialized) CoUninitialize();
  }

  SequencedEmitter& emitter_;
  std::mutex state_mutex_;
  std::condition_variable startup_changed_;
  std::thread worker_;
  std::atomic_bool running_{false};
  std::string session_id_;
  std::uint64_t generation_ = 0;
  bool ready_ = false;
  bool terminal_emitted_ = false;
  std::string startup_error_;
  std::mutex audio_mutex_;
  std::condition_variable audio_ready_;
  std::deque<float> queued_samples_;
};

PreviewActor::PreviewActor(SequencedEmitter& emitter)
  : implementation_(std::make_unique<Implementation>(emitter)) {}
PreviewActor::~PreviewActor() = default;
RuntimeEvent PreviewActor::start(const MediaCommand& command) {
  return implementation_->start(command);
}
void PreviewActor::pushFrame(std::span<const std::int16_t> pcm) {
  implementation_->pushFrame(pcm);
}
bool PreviewActor::failFromCapture(
  const std::string& session_id,
  std::uint64_t generation,
  const std::string& message
) {
  return implementation_->failFromCapture(session_id, generation, message);
}
void PreviewActor::stop(const MediaCommand& command, bool emit_stopped) {
  implementation_->stop(command, emit_stopped);
}
void PreviewActor::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
