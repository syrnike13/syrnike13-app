#include <napi.h>
#include <windows.h>

#include <memory>
#include <filesystem>
#include <mutex>
#include <stdexcept>
#include <thread>

#include "../common/addon_parsing.hpp"
#include "../common/diagnostic_log.hpp"
#include "../common/node_event_sink.hpp"
#include "media_runtime.hpp"

namespace syrnike::desktop_native::media {
namespace {

std::mutex runtimes_mutex;
std::shared_ptr<MediaRuntime> active_runtime;
Napi::FunctionReference runtime_constructor;

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

void cleanupRuntimes() {
  auto& diagnostics = diagnostics::DiagnosticLog::instance();
  if (diagnostics.enabled()) diagnostics.write("media_addon_cleanup_start");
  std::shared_ptr<MediaRuntime> owned;
  {
    std::lock_guard lock(runtimes_mutex);
    owned = std::move(active_runtime);
  }
  if (!owned) return;
  owned->requestShutdown();
  owned->shutdownAndWait();
  if (diagnostics.enabled()) diagnostics.write("media_addon_cleanup_done");
}

void releaseRuntime(const std::shared_ptr<MediaRuntime>& runtime) {
  std::lock_guard lock(runtimes_mutex);
  if (active_runtime == runtime) active_runtime.reset();
}

void asyncCleanup(napi_async_cleanup_hook_handle handle, void*) {
  std::thread([handle] {
    cleanupRuntimes();
    diagnostics::DiagnosticLog::instance().shutdown();
    napi_remove_async_cleanup_hook(handle);
  }).detach();
}

class ShutdownWorker final : public Napi::AsyncWorker {
 public:
  ShutdownWorker(Napi::Env env, std::shared_ptr<MediaRuntime> runtime)
    : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
      runtime_(std::move(runtime)) {}

  Napi::Promise promise() const { return deferred_.Promise(); }

  void Execute() override {
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (diagnostics.enabled()) diagnostics.write("media_addon_shutdown_worker_execute");
    runtime_->requestShutdown();
    runtime_->shutdownAndWait();
    if (diagnostics.enabled()) diagnostics.write("media_addon_shutdown_worker_flushing");
    diagnostics.shutdown();
  }

  void OnOK() override {
    releaseRuntime(runtime_);
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (diagnostics.enabled()) diagnostics.write("media_addon_shutdown_worker_ok");
    deferred_.Resolve(Env().Undefined());
  }
  void OnError(const Napi::Error& error) override {
    releaseRuntime(runtime_);
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
    runtime_constructor = Napi::Persistent(constructor);
    runtime_constructor.SuppressDestruct();
  }

  explicit MediaRuntimeBinding(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<MediaRuntimeBinding>(info) {
    auto& diagnostics = diagnostics::DiagnosticLog::instance();
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(info.Env(), "createMediaRuntime requires an event callback");
    }
    std::lock_guard lock(runtimes_mutex);
    if (active_runtime) {
      throw Napi::Error::New(
        info.Env(), "runtime_already_created: media runtime is singleton per utility process"
      );
    }
    auto sink = std::make_shared<NodeEventSink>(
      info.Env(), info[0].As<Napi::Function>(), "syrnike-media-events"
    );
    try {
      if (diagnostics.enabled()) diagnostics.write("media_addon_runtime_create_start");
      runtime_ = std::make_shared<MediaRuntime>(std::move(sink));
    } catch (const std::exception& error) {
      if (diagnostics.enabled()) {
        diagnostics.write("media_addon_runtime_create_error", {{"message", error.what()}});
      }
      throw Napi::Error::New(
        info.Env(), std::string("native_runtime_initialize_failed: ") + error.what()
      );
    }
    active_runtime = runtime_;
    if (diagnostics.enabled()) diagnostics.write("media_addon_runtime_create_ok");
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
    auto* worker = new ShutdownWorker(info.Env(), std::move(runtime));
    const auto promise = worker->promise();
    worker->Queue();
    return promise;
  }

  std::shared_ptr<MediaRuntime> runtime_;
};

Napi::Value createMediaRuntime(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsFunction()) {
    throw Napi::TypeError::New(info.Env(), "createMediaRuntime requires an event callback");
  }
  return runtime_constructor.New({info[0]});
}

Napi::Object getRuntimeInfo(const Napi::CallbackInfo& info) {
  auto result = Napi::Object::New(info.Env());
  result.Set("platform", "win32");
  result.Set("available", true);
  result.Set("runtime", "media");
  result.Set("contractVersion", 3);
  result.Set("pid", GetCurrentProcessId());
  result.Set("napi", std::to_string(NAPI_VERSION));
  result.Set("livekit", "1.3.0");
  result.Set("commit", SYRNIKE_NATIVE_COMMIT);
  auto capabilities = Napi::Array::New(info.Env(), 6);
  capabilities.Set(uint32_t{0}, "microphone");
  capabilities.Set(uint32_t{1}, "screen");
  capabilities.Set(uint32_t{2}, "screenAudio");
  capabilities.Set(uint32_t{3}, "preview");
  capabilities.Set(uint32_t{4}, "queries");
  capabilities.Set(uint32_t{5}, "remoteVideo");
  result.Set("capabilities", capabilities);
  return result;
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
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
  napi_async_cleanup_hook_handle cleanup_handle = nullptr;
  napi_add_async_cleanup_hook(env, asyncCleanup, nullptr, &cleanup_handle);
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
