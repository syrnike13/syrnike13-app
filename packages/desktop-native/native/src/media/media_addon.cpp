#include <napi.h>
#include <uv.h>
#include <windows.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <filesystem>
#include <mutex>
#include <new>
#include <stdexcept>
#include <thread>

#include "../common/addon_parsing.hpp"
#include "../common/async_cleanup_dispatcher.hpp"
#include "../common/diagnostic_log.hpp"
#include "../common/node_event_sink.hpp"
#include "media_runtime.hpp"

namespace syrnike::desktop_native::media {
namespace {

struct MediaRuntimeRegistry final {
  std::mutex runtime_mutex;
  std::shared_ptr<MediaRuntime> active_runtime;
};

struct MediaAddonState final {
  Napi::FunctionReference runtime_constructor;
  std::shared_ptr<MediaRuntimeRegistry> registry =
    std::make_shared<MediaRuntimeRegistry>();
  std::shared_ptr<std::atomic_uint64_t> quarantine_cleanup_completions =
    std::make_shared<std::atomic_uint64_t>(0);
};

void ensureLiveKitLoaded() {
  auto& diagnostics = diagnostics::DiagnosticLog::instance();
  if (diagnostics.enabled()) {
    diagnostics.write("media_addon_livekit_load_start");
  }
  HMODULE self = nullptr;
  if (!GetModuleHandleExW(
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
      GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    reinterpret_cast<LPCWSTR>(&ensureLiveKitLoaded),
    &self
  )) {
    throw std::runtime_error("native module location is unavailable");
  }
  std::wstring module_path(32'768, L'\0');
  const auto length = GetModuleFileNameW(
    self, module_path.data(), static_cast<DWORD>(module_path.size())
  );
  if (length == 0 || length >= module_path.size()) {
    throw std::runtime_error("native module path is unavailable");
  }
  module_path.resize(length);
  const auto livekit_path = std::filesystem::path(module_path).parent_path() / L"livekit.dll";
  if (!LoadLibraryExW(
    livekit_path.c_str(),
    nullptr,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS
  )) {
    throw std::runtime_error("LiveKit runtime DLL could not be loaded from the native directory");
  }
  if (diagnostics.enabled()) {
    diagnostics.write("media_addon_livekit_load_ok");
  }
}

void cleanupRuntimes(const std::shared_ptr<MediaRuntimeRegistry>& registry) {
  if (!registry) return;
  auto& diagnostics = diagnostics::DiagnosticLog::instance();
  if (diagnostics.enabled()) diagnostics.write("media_addon_cleanup_start");
  std::shared_ptr<MediaRuntime> owned;
  {
    std::lock_guard lock(registry->runtime_mutex);
    owned = std::move(registry->active_runtime);
  }
  if (owned) {
    try {
      owned->requestShutdown();
      owned->shutdownAndWait();
    } catch (...) {
      // Environment cleanup must always reach hook removal.
    }
  }
  if (diagnostics.enabled()) diagnostics.write("media_addon_cleanup_done");
}

void releaseRuntime(
  const std::shared_ptr<MediaRuntimeRegistry>& registry,
  const std::shared_ptr<MediaRuntime>& runtime
) {
  if (!registry) return;
  std::lock_guard lock(registry->runtime_mutex);
  if (registry->active_runtime == runtime) registry->active_runtime.reset();
}

struct AsyncCleanupRegistration final {
  uv_loop_t* loop = nullptr;
  std::shared_ptr<MediaRuntimeRegistry> registry;
  std::shared_ptr<AsyncCleanupNode> cleanup_node;
  bool fail_dispatch_after_uv_init = false;
};

struct AsyncCleanupContext final {
  napi_async_cleanup_hook_handle hook = nullptr;
  uv_async_t completion{};
  std::shared_ptr<MediaRuntimeRegistry> registry;
};

void finishAsyncCleanup(uv_async_t* async) {
  auto* context = static_cast<AsyncCleanupContext*>(async->data);
  if (!context) return;
  napi_remove_async_cleanup_hook(context->hook);
  uv_close(
    reinterpret_cast<uv_handle_t*>(&context->completion),
    [](uv_handle_t* handle) {
      delete static_cast<AsyncCleanupContext*>(handle->data);
    }
  );
}

bool injectionEnabled(const char* name) {
  char value[2]{};
  return GetEnvironmentVariableA(name, value, 2) == 1 && value[0] == '1';
}

void completeAsyncCleanup(AsyncCleanupContext* context) noexcept {
  try {
    cleanupRuntimes(context->registry);
  } catch (...) {
  }
  try {
    diagnostics::DiagnosticLog::instance().shutdown();
  } catch (...) {
  }
  static_cast<void>(uv_async_send(&context->completion));
}

void asyncCleanup(napi_async_cleanup_hook_handle handle, void* data) {
  std::unique_ptr<AsyncCleanupRegistration> registration(
    static_cast<AsyncCleanupRegistration*>(data)
  );
  auto* context = new (std::nothrow) AsyncCleanupContext;
  if (!registration || !registration->loop || !context) {
    delete context;
    cleanupRuntimes(registration ? registration->registry : nullptr);
    diagnostics::DiagnosticLog::instance().shutdown();
    napi_remove_async_cleanup_hook(handle);
    return;
  }
  context->hook = handle;
  context->registry = registration->registry;
  context->completion.data = context;
  if (uv_async_init(
        registration->loop,
        &context->completion,
        finishAsyncCleanup
      ) != 0) {
    delete context;
    cleanupRuntimes(registration->registry);
    diagnostics::DiagnosticLog::instance().shutdown();
    napi_remove_async_cleanup_hook(handle);
    return;
  }
  try {
    if (registration->fail_dispatch_after_uv_init) {
      throw std::bad_alloc();
    }
    registration->cleanup_node->prepareRaw(
      context,
      [](void* owner) noexcept {
        completeAsyncCleanup(
          static_cast<AsyncCleanupContext*>(owner)
        );
      }
    );
    AsyncCleanupDispatcher::instance().submit(
      std::move(registration->cleanup_node)
    );
  } catch (...) {
    completeAsyncCleanup(context);
  }
}

class ShutdownWorker final : public Napi::AsyncWorker {
 public:
  ShutdownWorker(
    Napi::Env env,
    std::shared_ptr<MediaRuntimeRegistry> registry,
    std::shared_ptr<MediaRuntime> runtime
  )
    : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
      registry_(std::move(registry)), runtime_(std::move(runtime)) {}

  Napi::Promise promise() const { return deferred_.Promise(); }

  void Execute() override {
    try {
      auto& diagnostics = diagnostics::DiagnosticLog::instance();
      if (diagnostics.enabled()) diagnostics.write("media_addon_shutdown_worker_execute");
      runtime_->requestShutdown();
      runtime_->shutdownAndWait();
      if (diagnostics.enabled()) diagnostics.write("media_addon_shutdown_worker_flushing");
      diagnostics.shutdown();
    } catch (const std::exception& error) {
      SetError(error.what());
    } catch (...) {
      SetError("unknown native media shutdown failure");
    }
    releaseRuntime(registry_, runtime_);
  }

  void OnOK() override {
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (diagnostics.enabled()) diagnostics.write("media_addon_shutdown_worker_ok");
    deferred_.Resolve(Env().Undefined());
  }
  void OnError(const Napi::Error& error) override {
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (diagnostics.enabled()) {
      diagnostics.write(
        "media_addon_shutdown_worker_error",
        {{"message", error.Message()}}
      );
    }
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<MediaRuntimeRegistry> registry_;
  std::shared_ptr<MediaRuntime> runtime_;
};

class ReadyWorker final : public Napi::AsyncWorker {
 public:
  ReadyWorker(Napi::Env env, std::shared_ptr<MediaRuntime> runtime)
    : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
      runtime_(std::move(runtime)) {}

  Napi::Promise promise() const { return deferred_.Promise(); }

  void Execute() override {
    try {
      auto& diagnostics = diagnostics::DiagnosticLog::instance();
      if (diagnostics.enabled()) diagnostics.write("media_addon_ready_wait_start");
      runtime_->waitUntilReady();
    } catch (const std::exception& error) {
      SetError(error.what());
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }

  void OnError(const Napi::Error& error) override {
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (diagnostics.enabled()) {
      diagnostics.write("media_addon_ready_wait_error", {{"message", error.Message()}});
    }
    deferred_.Reject(error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<MediaRuntime> runtime_;
};

class MediaRuntimeBinding final : public Napi::ObjectWrap<MediaRuntimeBinding> {
 public:
  static void initialize(Napi::Env env) {
    auto constructor = DefineClass(env, "NativeMediaRuntime", {
      InstanceMethod("ready", &MediaRuntimeBinding::ready),
      InstanceMethod("dispatch", &MediaRuntimeBinding::dispatch),
      InstanceMethod("shutdown", &MediaRuntimeBinding::shutdown),
    });
    auto* state = env.GetInstanceData<MediaAddonState>();
    if (!state) throw Napi::Error::New(env, "media addon state is unavailable");
    state->runtime_constructor = Napi::Persistent(constructor);
  }

  explicit MediaRuntimeBinding(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<MediaRuntimeBinding>(info) {
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(info.Env(), "createMediaRuntime requires an event callback");
    }
    auto* state = info.Env().GetInstanceData<MediaAddonState>();
    if (!state || !state->registry) {
      throw Napi::Error::New(info.Env(), "media addon state is unavailable");
    }
    registry_ = state->registry;
    std::lock_guard lock(registry_->runtime_mutex);
    if (registry_->active_runtime) {
      throw Napi::Error::New(
        info.Env(), "runtime_already_created: media runtime is singleton per environment"
      );
    }
    auto sink = std::make_shared<NodeEventSink>(
      info.Env(), info[0].As<Napi::Function>(), "syrnike-media-events"
    );
    try {
      if (diagnostics.enabled()) diagnostics.write("media_addon_runtime_create_start");
      MediaRuntime::BeforeMicrophoneOperation before_microphone_operation;
      MediaRuntime::AfterSubsystemCleanup after_subsystem_cleanup;
      if (injectionEnabled(
            "SYRNIKE_NATIVE_BLOCK_MICROPHONE_OPERATION_ONCE"
          )) {
        auto blocked_once = std::make_shared<std::atomic_bool>(false);
        auto injection_sink = sink;
        before_microphone_operation = [
          blocked_once,
          injection_sink = std::move(injection_sink)
        ](const MediaCommand& command) {
          if (
            command.type == "configureMicrophone" &&
            !blocked_once->exchange(true)
          ) {
            RuntimeEvent event;
            event.type = "nativeSmokeQuarantineBlockEntered";
            static_cast<void>(injection_sink->emit(std::move(event)));
            std::this_thread::sleep_for(std::chrono::seconds(3));
          }
        };
      }
      if (injectionEnabled(
            "SYRNIKE_NATIVE_OBSERVE_MEDIA_QUARANTINE_CLEANUP"
          )) {
        auto completions = state->quarantine_cleanup_completions;
        after_subsystem_cleanup = [completions = std::move(completions)] {
          completions->fetch_add(1, std::memory_order_release);
        };
      }
      runtime_ = std::make_shared<MediaRuntime>(
        std::move(sink),
        nullptr,
        MediaRuntime::SteadyNow{},
        std::move(before_microphone_operation),
        MediaRuntime::BeforeVoiceShutdown{},
        nullptr,
        failFirstAsyncCleanupLauncher(injectionEnabled(
          "SYRNIKE_NATIVE_FAIL_MEDIA_QUARANTINE_LAUNCH_ONCE"
        )),
        std::move(after_subsystem_cleanup)
      );
    } catch (const std::exception& error) {
      if (diagnostics.enabled()) {
        diagnostics.write("media_addon_runtime_create_error", {{"message", error.what()}});
      }
      throw Napi::Error::New(
        info.Env(), std::string("native_runtime_initialize_failed: ") + error.what()
      );
    }
    registry_->active_runtime = runtime_;
    if (diagnostics.enabled()) diagnostics.write("media_addon_runtime_create_ok");
  }

  ~MediaRuntimeBinding() {
    auto runtime = std::move(runtime_);
    if (!runtime) return;
    runtime->requestShutdown();
    try {
      runtime->shutdownAndWait();
    } catch (...) {
      // The registry must be cleared even if a contained actor reports a
      // teardown failure, otherwise a collected wrapper poisons this env.
    }
    releaseRuntime(registry_, runtime);
  }

 private:
  Napi::Value ready(const Napi::CallbackInfo& info) {
    if (!runtime_) {
      auto deferred = Napi::Promise::Deferred::New(info.Env());
      deferred.Reject(Napi::Error::New(info.Env(), "runtime_unavailable").Value());
      return deferred.Promise();
    }
    auto* worker = new ReadyWorker(info.Env(), runtime_);
    const auto promise = worker->promise();
    worker->Queue();
    return promise;
  }

  Napi::Value dispatch(const Napi::CallbackInfo& info) {
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (info.Length() != 1 || !info[0].IsObject()) {
      throw Napi::TypeError::New(info.Env(), "dispatch requires a command object");
    }
    try {
      auto command = parseMediaCommand(info[0].As<Napi::Object>());
      if (diagnostics.enabled()) {
        diagnostics.write(
          "media_addon_dispatch_received",
          {
            {"command", command.type},
            {"requestId", command.request_id},
            {"sessionId", command.session_id},
            {"generation", command.generation}
          }
        );
      }
      if (!runtime_ || !runtime_->dispatch(std::move(command))) {
        if (diagnostics.enabled()) diagnostics.write("media_addon_dispatch_queue_full");
        throw Napi::Error::New(info.Env(), "queue_full");
      }
    } catch (const Napi::Error&) {
      throw;
    } catch (const std::exception& error) {
      throw Napi::TypeError::New(info.Env(), error.what());
    }
    return info.Env().Undefined();
  }

  Napi::Value shutdown(const Napi::CallbackInfo& info) {
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (!runtime_) {
      auto deferred = Napi::Promise::Deferred::New(info.Env());
      deferred.Resolve(info.Env().Undefined());
      return deferred.Promise();
    }
    if (diagnostics.enabled()) diagnostics.write("media_addon_shutdown_requested");
    auto runtime = std::move(runtime_);
    auto* worker = new ShutdownWorker(
      info.Env(),
      registry_,
      std::move(runtime)
    );
    const auto promise = worker->promise();
    worker->Queue();
    return promise;
  }

  std::shared_ptr<MediaRuntimeRegistry> registry_;
  std::shared_ptr<MediaRuntime> runtime_;
};

Napi::Value createMediaRuntime(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsFunction()) {
    throw Napi::TypeError::New(info.Env(), "createMediaRuntime requires an event callback");
  }
  auto* state = info.Env().GetInstanceData<MediaAddonState>();
  if (!state || state->runtime_constructor.IsEmpty()) {
    throw Napi::Error::New(info.Env(), "media addon constructor is unavailable");
  }
  return state->runtime_constructor.New({info[0]});
}

Napi::Object getRuntimeInfo(const Napi::CallbackInfo& info) {
  auto result = Napi::Object::New(info.Env());
  result.Set("platform", "win32");
  result.Set("available", true);
  result.Set("runtime", "media");
  result.Set("contractVersion", 4);
  result.Set("pid", GetCurrentProcessId());
  result.Set("napi", std::to_string(NAPI_VERSION));
  result.Set("livekit", "1.3.0");
  result.Set("commit", SYRNIKE_NATIVE_COMMIT);
  result.Set(
    "diagnosticsEnabled",
    diagnostics::DiagnosticLog::instance().enabled()
  );
  if (injectionEnabled(
        "SYRNIKE_NATIVE_OBSERVE_MEDIA_QUARANTINE_CLEANUP"
      )) {
    auto* state = info.Env().GetInstanceData<MediaAddonState>();
    const auto completions = state && state->quarantine_cleanup_completions
      ? state->quarantine_cleanup_completions->load(std::memory_order_acquire)
      : 0;
    result.Set(
      "nativeTestQuarantineCleanupCompletions",
      Napi::Number::New(info.Env(), static_cast<double>(completions))
    );
  }
  auto capabilities = Napi::Array::New(info.Env(), 8);
  capabilities.Set(uint32_t{0}, "microphone");
  capabilities.Set(uint32_t{1}, "screen");
  capabilities.Set(uint32_t{2}, "screenAudio");
  capabilities.Set(uint32_t{3}, "preview");
  capabilities.Set(uint32_t{4}, "queries");
  capabilities.Set(uint32_t{5}, "remoteVideo");
  capabilities.Set(uint32_t{6}, "localScreenPreview");
  capabilities.Set(uint32_t{7}, "localCameraPreview");
  result.Set("capabilities", capabilities);
  return result;
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  auto* state = new MediaAddonState;
  env.SetInstanceData(state);
  auto& diagnostics = diagnostics::DiagnosticLog::instance();
  diagnostics.initializeForMediaProcess();
  if (diagnostics.enabled()) {
    diagnostics.write(
      "media_addon_initialize",
      {
        {"pid", static_cast<std::uint64_t>(GetCurrentProcessId())},
        {"napi", static_cast<std::uint64_t>(NAPI_VERSION)}
      }
    );
  }
  try {
    ensureLiveKitLoaded();
  } catch (const std::exception& error) {
    if (diagnostics.enabled()) {
      diagnostics.write("media_addon_livekit_load_error", {{"message", error.what()}});
    }
    throw;
  }
  MediaRuntimeBinding::initialize(env);
  static_cast<void>(AsyncCleanupDispatcher::instance());
  uv_loop_t* loop = nullptr;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok || !loop) {
    throw Napi::Error::New(env, "media addon uv loop is unavailable");
  }
  auto* cleanup_registration = new AsyncCleanupRegistration{
    loop,
    state->registry,
    std::make_shared<AsyncCleanupNode>(
      failFirstAsyncCleanupLauncher(injectionEnabled(
        "SYRNIKE_NATIVE_FAIL_ASYNC_CLEANUP_LAUNCH_ONCE"
      ))
    ),
    injectionEnabled(
      "SYRNIKE_NATIVE_FAIL_ASYNC_CLEANUP_DISPATCH_ONCE"
    ),
  };
  napi_async_cleanup_hook_handle cleanup_handle = nullptr;
  if (napi_add_async_cleanup_hook(
        env,
        asyncCleanup,
        cleanup_registration,
        &cleanup_handle
      ) != napi_ok) {
    delete cleanup_registration;
    throw Napi::Error::New(env, "media addon cleanup hook registration failed");
  }
  exports.Set("createMediaRuntime", Napi::Function::New(env, createMediaRuntime));
  exports.Set("getRuntimeInfo", Napi::Function::New(env, getRuntimeInfo));
  return exports;
}

}  // namespace
}  // namespace syrnike::desktop_native::media

Napi::Object initializeMediaAddon(Napi::Env env, Napi::Object exports) {
  return syrnike::desktop_native::media::initialize(env, exports);
}

NODE_API_MODULE(syrnike_media, initializeMediaAddon)
