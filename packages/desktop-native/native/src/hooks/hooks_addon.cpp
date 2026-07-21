#include <napi.h>
#include <windows.h>

#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>

#include "../common/node_event_sink.hpp"
#include "../common/runtime_types.hpp"
#include "hooks_runtime.hpp"

namespace syrnike::desktop_native::hooks {
namespace {

#if defined(SYRNIKE_HOOK_RUNTIME_hotkey)
constexpr auto kRuntimeName = "hotkey";
constexpr auto kCapability = "hotkeys";
constexpr auto kCreateRuntimeName = "createHotkeyRuntime";
#else
constexpr auto kRuntimeName = "overlay";
constexpr auto kCapability = "overlay";
constexpr auto kCreateRuntimeName = "createOverlayRuntime";
#endif

HooksCommand parseHooksCommand(const Napi::Object& object) {
  HooksCommand command;
  const auto type = object.Get("type");
  const auto request_id = object.Get("requestId");
  if (!type.IsString() || !request_id.IsString()) {
    throw std::invalid_argument("command.type and command.requestId are required");
  }
  command.type = type.As<Napi::String>().Utf8Value();
  command.request_id = request_id.As<Napi::String>().Utf8Value();
  if (command.type.empty() || command.request_id.empty()) {
    throw std::invalid_argument("command.type and command.requestId are required");
  }
#if defined(SYRNIKE_HOOK_RUNTIME_hotkey)
  if (command.type != "startHotkeys" && command.type != "stopHotkeys" &&
      command.type != "probeHooksRuntime" && command.type != "shutdown") {
    throw std::invalid_argument("command is not supported by the hotkey runtime");
  }
#else
  if (command.type != "startOverlay" && command.type != "stopOverlay" &&
      command.type != "probeHooksRuntime" && command.type != "shutdown") {
    throw std::invalid_argument("command is not supported by the overlay runtime");
  }
#endif
  return command;
}

std::mutex runtimes_mutex;
std::shared_ptr<HooksRuntime> active_runtime;
Napi::FunctionReference runtime_constructor;

void cleanupRuntimes() {
  std::shared_ptr<HooksRuntime> owned;
  {
    std::lock_guard lock(runtimes_mutex);
    owned = std::move(active_runtime);
  }
  if (!owned) return;
  owned->requestShutdown();
  owned->shutdownAndWait();
}

void releaseRuntime(const std::shared_ptr<HooksRuntime>& runtime) {
  std::lock_guard lock(runtimes_mutex);
  if (active_runtime == runtime) active_runtime.reset();
}

void asyncCleanup(napi_async_cleanup_hook_handle handle, void*) {
  std::thread([handle] {
    cleanupRuntimes();
    napi_remove_async_cleanup_hook(handle);
  }).detach();
}

class ShutdownWorker final : public Napi::AsyncWorker {
 public:
  ShutdownWorker(Napi::Env env, std::shared_ptr<HooksRuntime> runtime)
    : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
      runtime_(std::move(runtime)) {}
  Napi::Promise promise() const { return deferred_.Promise(); }
  void Execute() override {
    runtime_->requestShutdown();
    runtime_->shutdownAndWait();
  }
  void OnOK() override {
    releaseRuntime(runtime_);
    deferred_.Resolve(Env().Undefined());
  }
  void OnError(const Napi::Error& error) override {
    releaseRuntime(runtime_);
    deferred_.Reject(error.Value());
  }
 private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<HooksRuntime> runtime_;
};

class HooksRuntimeBinding final : public Napi::ObjectWrap<HooksRuntimeBinding> {
 public:
  static void initialize(Napi::Env env) {
    auto constructor = DefineClass(env, "NativeHooksRuntime", {
      InstanceMethod("dispatch", &HooksRuntimeBinding::dispatch),
      InstanceMethod("shutdown", &HooksRuntimeBinding::shutdown),
    });
    runtime_constructor = Napi::Persistent(constructor);
    runtime_constructor.SuppressDestruct();
  }

  explicit HooksRuntimeBinding(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<HooksRuntimeBinding>(info) {
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(info.Env(), "createHooksRuntime requires an event callback");
    }
    std::lock_guard lock(runtimes_mutex);
    if (active_runtime) {
      throw Napi::Error::New(
        info.Env(), "runtime_already_created: native runtime is singleton per utility process"
      );
    }
    auto sink = std::make_shared<NodeEventSink>(
      info.Env(), info[0].As<Napi::Function>(), "syrnike-native-events"
    );
    runtime_ = std::make_shared<HooksRuntime>(std::move(sink));
    active_runtime = runtime_;
  }

 private:
  Napi::Value dispatch(const Napi::CallbackInfo& info) {
    if (info.Length() != 1 || !info[0].IsObject()) {
      throw Napi::TypeError::New(info.Env(), "dispatch requires a command object");
    }
    try {
      auto command = parseHooksCommand(info[0].As<Napi::Object>());
      if (!runtime_ || !runtime_->dispatch(std::move(command))) {
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
    if (!runtime_) {
      auto deferred = Napi::Promise::Deferred::New(info.Env());
      deferred.Resolve(info.Env().Undefined());
      return deferred.Promise();
    }
    auto runtime = std::move(runtime_);
    auto* worker = new ShutdownWorker(info.Env(), std::move(runtime));
    const auto promise = worker->promise();
    worker->Queue();
    return promise;
  }

  std::shared_ptr<HooksRuntime> runtime_;
};

Napi::Value createHooksRuntime(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsFunction()) {
    throw Napi::TypeError::New(info.Env(), "createHooksRuntime requires an event callback");
  }
  return runtime_constructor.New({info[0]});
}

Napi::Object getRuntimeInfo(const Napi::CallbackInfo& info) {
  auto result = Napi::Object::New(info.Env());
  result.Set("platform", "win32");
  result.Set("available", true);
  result.Set("runtime", kRuntimeName);
  result.Set("contractVersion", 4);
  result.Set("pid", GetCurrentProcessId());
  result.Set("napi", std::to_string(NAPI_VERSION));
  result.Set("commit", SYRNIKE_NATIVE_COMMIT);
  auto capabilities = Napi::Array::New(info.Env(), 1);
  capabilities.Set(uint32_t{0}, kCapability);
  result.Set("capabilities", capabilities);
  return result;
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  HooksRuntimeBinding::initialize(env);
  napi_async_cleanup_hook_handle cleanup_handle = nullptr;
  napi_add_async_cleanup_hook(env, asyncCleanup, nullptr, &cleanup_handle);
  exports.Set(kCreateRuntimeName, Napi::Function::New(env, createHooksRuntime));
  exports.Set("getRuntimeInfo", Napi::Function::New(env, getRuntimeInfo));
  return exports;
}

}  // namespace
}  // namespace syrnike::desktop_native::hooks

Napi::Object initializeHooksAddon(Napi::Env env, Napi::Object exports) {
  return syrnike::desktop_native::hooks::initialize(env, exports);
}

NODE_API_MODULE(syrnike_native_hooks, initializeHooksAddon)
