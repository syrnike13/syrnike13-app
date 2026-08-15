#include <napi.h>
#include <uv.h>
#include <windows.h>

#include <memory>
#include <mutex>
#include <new>
#include <stdexcept>
#include <thread>

#include "../common/cleanup_supervisor.hpp"
#include "../common/native_contract_version.hpp"
#include "../common/native_message_bindings.hpp"
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
  const auto wire_type = type.As<Napi::String>().Utf8Value();
  const auto parsed_type = parseNativeCommandType(wire_type);
  if (!parsed_type) {
    throw std::invalid_argument("command is absent from the typed hooks policy");
  }
  command.type = *parsed_type;
  command.request_id = request_id.As<Napi::String>().Utf8Value();
  if (command.request_id.empty()) {
    throw std::invalid_argument("command.type and command.requestId are required");
  }
  const auto native_type = command.type;
  const auto& policy = nativeCommandPolicy(native_type);
  if (nativeCommandTypeForSchema(policy.schema) != native_type ||
      nativeCommandTypeForAction(policy.action) != native_type) {
    throw std::invalid_argument(
      "command has no generated schema or dispatch handler"
    );
  }
  if (policy.visibility !=
        NativeMessageVisibility::External ||
      (policy.destination !=
         NativeMessageDestination::Hooks &&
       native_type != NativeCommandType::Shutdown)) {
    throw std::invalid_argument("command is absent from the typed hooks policy");
  }
#if defined(SYRNIKE_HOOK_RUNTIME_hotkey)
  if (command.type != NativeCommandType::StartHotkeys && command.type != NativeCommandType::StopHotkeys &&
      command.type != NativeCommandType::ProbeHooksRuntime && command.type != NativeCommandType::Shutdown) {
    throw std::invalid_argument("command is not supported by the hotkey runtime");
  }
#else
  if (command.type != NativeCommandType::StartOverlay && command.type != NativeCommandType::StopOverlay &&
      command.type != NativeCommandType::ProbeHooksRuntime && command.type != NativeCommandType::Shutdown) {
    throw std::invalid_argument("command is not supported by the overlay runtime");
  }
#endif
  return command;
}

struct HooksRuntimeRegistry final {
  std::mutex runtime_mutex;
  std::shared_ptr<HooksRuntime> active_runtime;
};

struct HooksAddonState final {
  Napi::FunctionReference runtime_constructor;
  std::shared_ptr<HooksRuntimeRegistry> registry =
    std::make_shared<HooksRuntimeRegistry>();
};

void cleanupRuntimes(const std::shared_ptr<HooksRuntimeRegistry>& registry) {
  if (!registry) return;
  std::shared_ptr<HooksRuntime> owned;
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
}

void releaseRuntime(
  const std::shared_ptr<HooksRuntimeRegistry>& registry,
  const std::shared_ptr<HooksRuntime>& runtime
) {
  if (!registry) return;
  std::lock_guard lock(registry->runtime_mutex);
  if (registry->active_runtime == runtime) registry->active_runtime.reset();
}

struct AsyncCleanupRegistration final {
  uv_loop_t* loop = nullptr;
  std::shared_ptr<HooksRuntimeRegistry> registry;
  std::shared_ptr<CleanupJob> cleanup_job;
  bool fail_dispatch_after_uv_init = false;
};

struct AsyncCleanupContext final {
  napi_async_cleanup_hook_handle hook = nullptr;
  uv_async_t completion{};
  std::shared_ptr<HooksRuntimeRegistry> registry;
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
    napi_remove_async_cleanup_hook(handle);
    return;
  }
  try {
    if (registration->fail_dispatch_after_uv_init) {
      throw std::bad_alloc();
    }
    registration->cleanup_job->prepareRaw(
      context,
      reinterpret_cast<CleanupResourceKey>(context),
      [](void* owner) noexcept {
        completeAsyncCleanup(
          static_cast<AsyncCleanupContext*>(owner)
        );
      }
    );
    CleanupSupervisor::instance().submitOrEscalate(
      std::move(registration->cleanup_job), "hooks_addon"
    );
  } catch (...) {
    completeAsyncCleanup(context);
  }
}

class ShutdownWorker final : public Napi::AsyncWorker {
 public:
  ShutdownWorker(
    Napi::Env env,
    std::shared_ptr<HooksRuntimeRegistry> registry,
    std::shared_ptr<HooksRuntime> runtime
  )
    : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
      registry_(std::move(registry)), runtime_(std::move(runtime)) {}
  Napi::Promise promise() const { return deferred_.Promise(); }
  void Execute() override {
    try {
      runtime_->requestShutdown();
      runtime_->shutdownAndWait();
    } catch (const std::exception& error) {
      SetError(error.what());
    } catch (...) {
      SetError("unknown native hooks shutdown failure");
    }
    releaseRuntime(registry_, runtime_);
  }
  void OnOK() override {
    deferred_.Resolve(Env().Undefined());
  }
  void OnError(const Napi::Error& error) override {
    deferred_.Reject(error.Value());
  }
 private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<HooksRuntimeRegistry> registry_;
  std::shared_ptr<HooksRuntime> runtime_;
};

class HooksRuntimeBinding final : public Napi::ObjectWrap<HooksRuntimeBinding> {
 public:
  static void initialize(Napi::Env env) {
    auto constructor = DefineClass(env, "NativeHooksRuntime", {
      InstanceMethod("dispatch", &HooksRuntimeBinding::dispatch),
      InstanceMethod("shutdown", &HooksRuntimeBinding::shutdown),
    });
    auto* state = env.GetInstanceData<HooksAddonState>();
    if (!state) throw Napi::Error::New(env, "hooks addon state is unavailable");
    state->runtime_constructor = Napi::Persistent(constructor);
  }

  explicit HooksRuntimeBinding(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<HooksRuntimeBinding>(info) {
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(info.Env(), "createHooksRuntime requires an event callback");
    }
    auto* state = info.Env().GetInstanceData<HooksAddonState>();
    if (!state || !state->registry) {
      throw Napi::Error::New(info.Env(), "hooks addon state is unavailable");
    }
    registry_ = state->registry;
    std::lock_guard lock(registry_->runtime_mutex);
    if (registry_->active_runtime) {
      throw Napi::Error::New(
        info.Env(), "runtime_already_created: native runtime is singleton per environment"
      );
    }
    auto sink = std::make_shared<NodeEventSink>(
      info.Env(), info[0].As<Napi::Function>(), "syrnike-native-events"
    );
    runtime_ = std::make_shared<HooksRuntime>(std::move(sink));
    registry_->active_runtime = runtime_;
  }

  ~HooksRuntimeBinding() {
    auto runtime = std::move(runtime_);
    if (!runtime) return;
    runtime->requestShutdown();
    try {
      runtime->shutdownAndWait();
    } catch (...) {
      // Always release the per-env singleton after a collected wrapper.
    }
    releaseRuntime(registry_, runtime);
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
    auto* worker = new ShutdownWorker(
      info.Env(),
      registry_,
      std::move(runtime)
    );
    const auto promise = worker->promise();
    worker->Queue();
    return promise;
  }

  std::shared_ptr<HooksRuntimeRegistry> registry_;
  std::shared_ptr<HooksRuntime> runtime_;
};

Napi::Value createHooksRuntime(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsFunction()) {
    throw Napi::TypeError::New(info.Env(), "createHooksRuntime requires an event callback");
  }
  auto* state = info.Env().GetInstanceData<HooksAddonState>();
  if (!state || state->runtime_constructor.IsEmpty()) {
    throw Napi::Error::New(info.Env(), "hooks addon constructor is unavailable");
  }
  return state->runtime_constructor.New({info[0]});
}

Napi::Object getRuntimeInfo(const Napi::CallbackInfo& info) {
  auto result = Napi::Object::New(info.Env());
  result.Set("platform", "win32");
  result.Set("available", true);
  result.Set("runtime", kRuntimeName);
  result.Set("contractVersion", kNativeRuntimeContractVersion);
  result.Set("pid", GetCurrentProcessId());
  result.Set("napi", std::to_string(NAPI_VERSION));
  result.Set("commit", SYRNIKE_NATIVE_COMMIT);
  auto capabilities = Napi::Array::New(info.Env(), 1);
  capabilities.Set(uint32_t{0}, kCapability);
  result.Set("capabilities", capabilities);
  return result;
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  auto* state = new HooksAddonState;
  env.SetInstanceData(state);
  HooksRuntimeBinding::initialize(env);
  static_cast<void>(CleanupSupervisor::instance());
  uv_loop_t* loop = nullptr;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok || !loop) {
    throw Napi::Error::New(env, "hooks addon uv loop is unavailable");
  }
  auto* cleanup_registration = new AsyncCleanupRegistration{
    loop,
    state->registry,
    std::make_shared<CleanupJob>(
      failFirstCleanupStartProbe(injectionEnabled(
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
    throw Napi::Error::New(env, "hooks addon cleanup hook registration failed");
  }
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
