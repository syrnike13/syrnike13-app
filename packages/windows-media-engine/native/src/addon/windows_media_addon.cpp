#include <napi.h>

#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include "core/engine.hpp"

#ifndef WINDOWS_MEDIA_COMMIT
#define WINDOWS_MEDIA_COMMIT "unknown"
#endif

namespace {

using syrnike::windows_media::Engine;
using syrnike::windows_media::EngineFailure;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::LifecycleEvent;
using syrnike::windows_media::engineStateName;

inline constexpr int kLifecycleProtocolVersion = 1;

void throwFailure(Napi::Env env, const EngineFailure& failure) {
  auto error = Napi::Error::New(env, failure.message);
  error.Value().Set("code", failure.code);
  error.Value().Set("stage", failure.stage);
  error.Value().Set("retryable", Napi::Boolean::New(env, failure.retryable));
  error.ThrowAsJavaScriptException();
}

Napi::Value requireSuccess(Napi::Env env, const EngineResult& result) {
  if (result.ok) return env.Undefined();
  throwFailure(
    env,
    result.failure.value_or(EngineFailure{
      "native_failure",
      "Windows media engine returned an untyped failure",
      "binding",
      false,
    })
  );
  return env.Undefined();
}

Napi::Object failureObject(Napi::Env env, const EngineFailure& failure) {
  auto object = Napi::Object::New(env);
  object.Set("code", failure.code);
  object.Set("message", failure.message);
  object.Set("stage", failure.stage);
  object.Set("retryable", failure.retryable);
  return object;
}

class AddonOwner final {
 public:
  explicit AddonOwner(Napi::Env env) : env_(env) {}

  ~AddonOwner() {
    static_cast<void>(engine_.shutdown());
    if (threadsafe_callback_) {
      napi_release_threadsafe_function(
        threadsafe_callback_,
        napi_tsfn_release
      );
      threadsafe_callback_ = nullptr;
    }
  }

  AddonOwner(const AddonOwner&) = delete;
  AddonOwner& operator=(const AddonOwner&) = delete;

  Napi::Value registerEventCallback(const Napi::CallbackInfo& info) {
    if (threadsafe_callback_) {
      throwFailure(env_, EngineFailure{
        "callback_already_registered",
        "Only one lifecycle callback may be registered",
        "register_event_callback",
        false,
      });
      return env_.Undefined();
    }
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(env_, "registerEventCallback requires one function");
    }
    const auto resource_name = Napi::String::New(env_, "windows-media-lifecycle");
    const napi_status created = napi_create_threadsafe_function(
      env_,
      info[0],
      nullptr,
      resource_name,
      syrnike::windows_media::kEventQueueCapacity,
      1,
      nullptr,
      nullptr,
      nullptr,
      &AddonOwner::callJavaScript,
      &threadsafe_callback_
    );
    if (created != napi_ok) {
      threadsafe_callback_ = nullptr;
      throw Napi::Error::New(env_, "Failed to create bounded lifecycle callback");
    }
    const auto registered = engine_.registerEventCallback(
      [this](const LifecycleEvent& event) { enqueueEvent(event); }
    );
    if (!registered.ok) {
      napi_release_threadsafe_function(
        threadsafe_callback_,
        napi_tsfn_abort
      );
      threadsafe_callback_ = nullptr;
      return requireSuccess(env_, registered);
    }
    return Napi::Boolean::New(env_, true);
  }

  Napi::Value handshake() {
    const auto started = engine_.start();
    if (!started.ok) return requireSuccess(env_, started);
    auto build = Napi::Object::New(env_);
    build.Set("commit", WINDOWS_MEDIA_COMMIT);
    build.Set("napi", std::to_string(NAPI_VERSION));
    auto result = Napi::Object::New(env_);
    result.Set("protocolVersion", kLifecycleProtocolVersion);
    result.Set("engineState", engineStateName(engine_.state()));
    result.Set("build", build);
    return result;
  }

  Napi::Value ping() {
    const auto result = engine_.ping();
    if (!result.ok) return requireSuccess(env_, result);
    auto pong = Napi::Object::New(env_);
    pong.Set("ok", true);
    pong.Set("engineState", engineStateName(engine_.state()));
    return pong;
  }

  Napi::Value shutdown() {
    const auto result = engine_.shutdown();
    if (!result.ok) return requireSuccess(env_, result);
    auto stopped = Napi::Object::New(env_);
    stopped.Set("ok", true);
    stopped.Set("engineState", engineStateName(engine_.state()));
    return stopped;
  }

 private:
  struct QueuedEvent {
    LifecycleEvent value;
  };

  static void callJavaScript(
    napi_env raw_env,
    napi_value raw_callback,
    void*,
    void* raw_data
  ) {
    std::unique_ptr<QueuedEvent> queued(static_cast<QueuedEvent*>(raw_data));
    if (!raw_env || !raw_callback || !queued) return;
    Napi::Env env(raw_env);
    Napi::Function callback(env, raw_callback);
    auto event = Napi::Object::New(env);
    event.Set("type", "engineStateChanged");
    event.Set(
      "sequence",
      Napi::Number::New(env, static_cast<double>(queued->value.sequence))
    );
    event.Set("previous", engineStateName(queued->value.previous));
    event.Set("state", engineStateName(queued->value.state));
    if (queued->value.failure) {
      event.Set("failure", failureObject(env, *queued->value.failure));
    }
    callback.Call({event});
  }

  void enqueueEvent(const LifecycleEvent& event) {
    if (!threadsafe_callback_) return;
    auto queued = std::make_unique<QueuedEvent>(QueuedEvent{event});
    const napi_status status = napi_call_threadsafe_function(
      threadsafe_callback_,
      queued.get(),
      napi_tsfn_nonblocking
    );
    if (status == napi_ok) static_cast<void>(queued.release());
  }

  Napi::Env env_;
  Engine engine_;
  napi_threadsafe_function threadsafe_callback_ = nullptr;
};

AddonOwner* owner(const Napi::CallbackInfo& info) {
  auto* value = info.Env().GetInstanceData<AddonOwner>();
  if (!value) throw std::runtime_error("Windows media addon owner is unavailable");
  return value;
}

template <typename Operation>
Napi::Value guarded(const Napi::CallbackInfo& info, Operation operation) {
  try {
    return operation(*owner(info));
  } catch (const Napi::Error& error) {
    error.ThrowAsJavaScriptException();
  } catch (const std::exception& error) {
    throwFailure(info.Env(), EngineFailure{
      "native_exception",
      error.what(),
      "binding",
      false,
    });
  } catch (...) {
    throwFailure(info.Env(), EngineFailure{
      "native_exception",
      "Unknown exception crossed the Windows media binding",
      "binding",
      false,
    });
  }
  return info.Env().Undefined();
}

Napi::Value registerEventCallback(const Napi::CallbackInfo& info) {
  return guarded(info, [&info](AddonOwner& value) {
    return value.registerEventCallback(info);
  });
}

Napi::Value handshake(const Napi::CallbackInfo& info) {
  return guarded(info, [](AddonOwner& value) { return value.handshake(); });
}

Napi::Value ping(const Napi::CallbackInfo& info) {
  return guarded(info, [](AddonOwner& value) { return value.ping(); });
}

Napi::Value shutdown(const Napi::CallbackInfo& info) {
  return guarded(info, [](AddonOwner& value) { return value.shutdown(); });
}

void finalizeAddon(Napi::Env, AddonOwner* value) {
  delete value;
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  env.SetInstanceData<AddonOwner, finalizeAddon>(new AddonOwner(env));
  exports.Set(
    "registerEventCallback",
    Napi::Function::New(env, registerEventCallback)
  );
  exports.Set("handshake", Napi::Function::New(env, handshake));
  exports.Set("ping", Napi::Function::New(env, ping));
  exports.Set("shutdown", Napi::Function::New(env, shutdown));
  return exports;
}

}  // namespace

NODE_API_MODULE(windows_media, initialize)

