#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <napi.h>
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "../src/common/addon_parsing.hpp"
#include "../src/common/cleanup_supervisor.hpp"
#include "../src/common/native_contract_version.hpp"
#include "../src/common/node_event_sink.hpp"
#include "../src/media/audio_constants.hpp"
#include "../src/media/livekit_voice_session.hpp"
#include "../src/media/media_runtime.hpp"
#include "../src/media/microphone_actor.hpp"

namespace syrnike::desktop_native::media {
namespace {

using namespace std::chrono_literals;

constexpr std::string_view kSession = "microphone-resilience-soak";
constexpr auto kWait = 15s;

class ResilienceCaptureDriver final {
 public:
  struct Snapshot {
    std::uint64_t attempts = 0;
    std::uint64_t submitted_frames = 0;
    std::uint64_t candidate_frames = 0;
    std::uint64_t rejected_frames = 0;
    std::size_t active_attempts = 0;
    std::size_t peak_active_attempts = 0;
  };

  MicrophoneCaptureAdapter adapter() {
    return MicrophoneCaptureAdapter{
      .probe_candidate = [this](MicrophoneCaptureCandidateRequest request) {
        probeCandidate(std::move(request));
      },
      .run = [this](MicrophoneCaptureAttemptRequest request) {
        run(std::move(request));
      },
    };
  }

  bool submit(bool discontinuity) {
    std::unique_lock lock(mutex_);
    if (active_attempts_ != 1) {
      throw std::runtime_error(
        "resilience PCM submission requires exactly one capture owner"
      );
    }
    const auto sequence = ++next_action_;
    actions_.push_back(Action{discontinuity, sequence});
    changed_.notify_all();
    if (!changed_.wait_for(lock, kWait, [&] {
          return completed_action_ >= sequence;
        })) {
      throw std::runtime_error("resilience PCM submission timed out");
    }
    return last_action_accepted_;
  }

  Snapshot snapshot() const {
    std::lock_guard lock(mutex_);
    return Snapshot{
      .attempts = attempts_,
      .submitted_frames = submitted_frames_,
      .candidate_frames = candidate_frames_,
      .rejected_frames = rejected_frames_,
      .active_attempts = active_attempts_,
      .peak_active_attempts = peak_active_attempts_,
    };
  }

  void waitForNoActiveAttempt() {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kWait, [&] { return active_attempts_ == 0; })) {
      throw std::runtime_error("resilience capture did not stop");
    }
  }

 private:
  struct Action {
    bool discontinuity = false;
    std::uint64_t sequence = 0;
  };

  static std::array<float, voice::kSamplesPer10Ms> frame(float gain = 1.0f) {
    std::array<float, voice::kSamplesPer10Ms> pcm{};
    for (std::size_t index = 0; index < pcm.size(); ++index) {
      pcm[index] = (index % 32 < 16 ? 0.2f : -0.2f) * gain;
    }
    return pcm;
  }

  void probeCandidate(MicrophoneCaptureCandidateRequest request) {
    std::function<bool(std::span<const float>, bool)> old_submit;
    {
      std::lock_guard lock(mutex_);
      if (active_attempts_ != 1 || !current_submit_) {
        throw std::runtime_error(
          "candidate probe did not preserve the active capture owner"
        );
      }
      old_submit = current_submit_;
    }
    const auto candidate = frame(request.device_id.empty() ? 0.75f : 0.5f);
    if (!std::any_of(candidate.begin(), candidate.end(), [](float sample) {
          return sample > 0.01f || sample < -0.01f;
        })) {
      throw std::runtime_error("candidate endpoint produced no healthy PCM");
    }
    const auto old_pcm = frame();
    if (!old_submit(old_pcm, false)) {
      throw std::runtime_error(
        "candidate validation retired the old capture before promotion"
      );
    }
    std::lock_guard lock(mutex_);
    ++submitted_frames_;
    ++candidate_frames_;
  }

  void run(MicrophoneCaptureAttemptRequest request) {
    {
      std::lock_guard lock(mutex_);
      ++attempts_;
      ++active_attempts_;
      peak_active_attempts_ = std::max(peak_active_attempts_, active_attempts_);
      current_submit_ = request.submit_pcm;
    }
    struct ActiveGuard final {
      ResilienceCaptureDriver& owner;
      ~ActiveGuard() {
        {
          std::lock_guard lock(owner.mutex_);
          --owner.active_attempts_;
          owner.current_submit_ = {};
        }
        owner.changed_.notify_all();
      }
    } guard{*this};

    const auto startup = frame();
    if (!request.submit_pcm(startup, false)) {
      throw std::runtime_error("current capture epoch rejected startup PCM");
    }
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
      const auto pcm = frame();
      const auto accepted = request.submit_pcm(pcm, action.discontinuity);
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

  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<Action> actions_;
  std::function<bool(std::span<const float>, bool)> current_submit_;
  std::uint64_t next_action_ = 0;
  std::uint64_t completed_action_ = 0;
  std::uint64_t attempts_ = 0;
  std::uint64_t submitted_frames_ = 0;
  std::uint64_t candidate_frames_ = 0;
  std::uint64_t rejected_frames_ = 0;
  std::size_t active_attempts_ = 0;
  std::size_t peak_active_attempts_ = 0;
  bool last_action_accepted_ = false;
};

struct AddonState final {
  Napi::FunctionReference constructor;
};

class ResilienceRuntimeBinding final
    : public Napi::ObjectWrap<ResilienceRuntimeBinding> {
 public:
  static void initialize(Napi::Env env) {
    auto constructor = DefineClass(env, "NativeMediaRuntime", {
      InstanceMethod("ready", &ResilienceRuntimeBinding::ready),
      InstanceMethod("dispatch", &ResilienceRuntimeBinding::dispatch),
      InstanceMethod("shutdown", &ResilienceRuntimeBinding::shutdown),
      InstanceMethod(
        "submitMicrophoneFrame",
        &ResilienceRuntimeBinding::submitMicrophoneFrame
      ),
      InstanceMethod("resilienceSnapshot", &ResilienceRuntimeBinding::snapshot),
    });
    auto* state = env.GetInstanceData<AddonState>();
    if (!state) throw Napi::Error::New(env, "resilience addon state unavailable");
    state->constructor = Napi::Persistent(constructor);
  }

  explicit ResilienceRuntimeBinding(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<ResilienceRuntimeBinding>(info),
        capture_(std::make_shared<ResilienceCaptureDriver>()),
        voice_(std::make_shared<DeterministicFakeLiveKitVoiceSession>()) {
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(
        info.Env(), "createMediaRuntime requires an event callback"
      );
    }
    voice_->setVoiceSessionForTest(std::string(kSession));
    auto sink = std::make_shared<NodeEventSink>(
      info.Env(), info[0].As<Napi::Function>(), "syrnike-resilience-events"
    );
    runtime_ = std::make_shared<MediaRuntime>(
      std::move(sink),
      voice_,
      MediaRuntime::SteadyNow{},
      MediaRuntime::BeforeMicrophoneOperation{},
      MediaRuntime::BeforeVoiceShutdown{},
      nullptr,
      CleanupStartProbe{},
      MediaRuntime::AfterSubsystemCleanup{},
      capture_->adapter(),
      MicrophoneIdleCaptureTiming{.grace = 50ms, .post_retry = 5ms}
    );
  }

  ~ResilienceRuntimeBinding() {
    auto runtime = std::move(runtime_);
    if (!runtime) return;
    runtime->requestShutdown();
    try {
      runtime->shutdownAndWait();
      capture_->waitForNoActiveAttempt();
    } catch (...) {
    }
  }

 private:
  Napi::Value ready(const Napi::CallbackInfo& info) {
    if (!runtime_) throw Napi::Error::New(info.Env(), "runtime_unavailable");
    runtime_->waitUntilReady();
    return info.Env().Undefined();
  }

  Napi::Value dispatch(const Napi::CallbackInfo& info) {
    if (info.Length() != 1 || !info[0].IsObject()) {
      throw Napi::TypeError::New(info.Env(), "dispatch requires a command object");
    }
    auto command = parseMediaCommand(info[0].As<Napi::Object>());
    last_dispatched_host_epoch_.store(
      command.diagnostic_host_epoch, std::memory_order_release
    );
    if (!runtime_ || !runtime_->dispatch(std::move(command))) {
      throw Napi::Error::New(info.Env(), "queue_full");
    }
    return info.Env().Undefined();
  }

  Napi::Value shutdown(const Napi::CallbackInfo& info) {
    auto runtime = std::move(runtime_);
    if (runtime) {
      runtime->requestShutdown();
      runtime->shutdownAndWait();
      capture_->waitForNoActiveAttempt();
    }
    return info.Env().Undefined();
  }

  Napi::Value submitMicrophoneFrame(const Napi::CallbackInfo& info) {
    const auto discontinuity = info.Length() > 0 && info[0].IsBoolean()
      ? info[0].As<Napi::Boolean>().Value()
      : false;
    return Napi::Boolean::New(info.Env(), capture_->submit(discontinuity));
  }

  Napi::Value snapshot(const Napi::CallbackInfo& info) {
    const auto capture = capture_->snapshot();
    const auto cleanup = CleanupSupervisor::instance().snapshot();
    const auto preview = runtime_->microphonePreviewQueueMetrics();
    DWORD handles = 0;
    if (!GetProcessHandleCount(GetCurrentProcess(), &handles)) {
      throw Napi::Error::New(info.Env(), "failed to read utility handle count");
    }
    auto result = Napi::Object::New(info.Env());
    result.Set("pid", Napi::Number::New(info.Env(), GetCurrentProcessId()));
    result.Set(
      "attempts",
      Napi::Number::New(info.Env(), static_cast<double>(capture.attempts))
    );
    result.Set(
      "submittedFrames",
      Napi::Number::New(info.Env(), static_cast<double>(capture.submitted_frames))
    );
    result.Set(
      "candidateFrames",
      Napi::Number::New(info.Env(), static_cast<double>(capture.candidate_frames))
    );
    result.Set(
      "rejectedFrames",
      Napi::Number::New(info.Env(), static_cast<double>(capture.rejected_frames))
    );
    result.Set(
      "activeAttempts",
      Napi::Number::New(info.Env(), static_cast<double>(capture.active_attempts))
    );
    result.Set(
      "peakActiveAttempts",
      Napi::Number::New(
        info.Env(), static_cast<double>(capture.peak_active_attempts)
      )
    );
    result.Set(
      "publishedFrames",
      Napi::Number::New(
        info.Env(), static_cast<double>(voice_->microphoneFrameCount())
      )
    );
    result.Set(
      "publicationDiscontinuities",
      Napi::Number::New(
        info.Env(),
        static_cast<double>(voice_->microphoneDiscontinuityCount())
      )
    );
    result.Set(
      "previewFrames",
      Napi::Number::New(
        info.Env(),
        static_cast<double>(preview.accepted_frames + preview.dropped_frames)
      )
    );
    result.Set("handles", Napi::Number::New(info.Env(), handles));
    result.Set(
      "lastDispatchedHostEpoch",
      Napi::Number::New(
        info.Env(),
        static_cast<double>(
          last_dispatched_host_epoch_.load(std::memory_order_acquire)
        )
      )
    );
    result.Set(
      "cleanupOwnedJobs",
      Napi::Number::New(info.Env(), static_cast<double>(cleanup.owned_jobs))
    );
    return result;
  }

  std::shared_ptr<ResilienceCaptureDriver> capture_;
  std::shared_ptr<DeterministicFakeLiveKitVoiceSession> voice_;
  std::shared_ptr<MediaRuntime> runtime_;
  std::atomic_uint64_t last_dispatched_host_epoch_{0};
};

Napi::Value createMediaRuntime(const Napi::CallbackInfo& info) {
  auto* state = info.Env().GetInstanceData<AddonState>();
  if (!state || state->constructor.IsEmpty()) {
    throw Napi::Error::New(info.Env(), "resilience addon constructor unavailable");
  }
  return state->constructor.New({info[0]});
}

Napi::Object getRuntimeInfo(const Napi::CallbackInfo& info) {
  auto result = Napi::Object::New(info.Env());
  result.Set("runtime", "media");
  result.Set("contractVersion", kNativeRuntimeContractVersion);
  result.Set("commit", SYRNIKE_NATIVE_COMMIT);
  result.Set("napi", std::to_string(NAPI_VERSION));
  result.Set("livekit", "1.3.0");
  result.Set("diagnosticsEnabled", false);
  auto capabilities = Napi::Array::New(info.Env(), 10);
  capabilities.Set(uint32_t{0}, "microphone");
  capabilities.Set(uint32_t{1}, "screen");
  capabilities.Set(uint32_t{2}, "screenAudio");
  capabilities.Set(uint32_t{3}, "preview");
  capabilities.Set(uint32_t{4}, "queries");
  capabilities.Set(uint32_t{5}, "remoteVideo");
  capabilities.Set(uint32_t{6}, "localScreenPreview");
  capabilities.Set(uint32_t{7}, "localCameraPreview");
  capabilities.Set(uint32_t{8}, "directRemoteAudio");
  capabilities.Set(uint32_t{9}, "voiceControl");
  result.Set("capabilities", capabilities);
  return result;
}

void ensureLiveKitLoaded() {
  HMODULE self = nullptr;
  if (!GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
          GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&ensureLiveKitLoaded),
        &self
      )) {
    throw std::runtime_error("resilience addon module location unavailable");
  }
  std::wstring module_path(32'768, L'\0');
  const auto length = GetModuleFileNameW(
    self, module_path.data(), static_cast<DWORD>(module_path.size())
  );
  if (length == 0 || length >= module_path.size()) {
    throw std::runtime_error("resilience addon path unavailable");
  }
  module_path.resize(length);
  const auto livekit_path =
    std::filesystem::path(module_path).parent_path() / L"livekit.dll";
  if (!LoadLibraryExW(
        livekit_path.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS
      )) {
    throw std::runtime_error("resilience addon could not load livekit.dll");
  }
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  ensureLiveKitLoaded();
  env.SetInstanceData(new AddonState);
  ResilienceRuntimeBinding::initialize(env);
  static_cast<void>(CleanupSupervisor::instance());
  exports.Set("createMediaRuntime", Napi::Function::New(env, createMediaRuntime));
  exports.Set("getRuntimeInfo", Napi::Function::New(env, getRuntimeInfo));
  return exports;
}

}  // namespace
}  // namespace syrnike::desktop_native::media

Napi::Object initializeMicrophoneResilienceAddon(
    Napi::Env env,
    Napi::Object exports) {
  return syrnike::desktop_native::media::initialize(env, exports);
}

NODE_API_MODULE(syrnike_media, initializeMicrophoneResilienceAddon)
