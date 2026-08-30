#include <napi.h>

#include <cmath>
#include <atomic>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "core/engine.hpp"

#ifndef WINDOWS_MEDIA_COMMIT
#define WINDOWS_MEDIA_COMMIT "unknown"
#endif

namespace {

using syrnike::windows_media::Engine;
using syrnike::windows_media::EngineDesiredState;
using syrnike::windows_media::EngineFailure;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::DiagnosticEvent;
using syrnike::windows_media::FatalEngineFailureEvent;
using syrnike::windows_media::LifecycleEvent;
using syrnike::windows_media::PublicEvent;
using syrnike::windows_media::RemoteVideoDemand;
using syrnike::windows_media::RoomStateChangedEvent;
using syrnike::windows_media::RoomIntent;
using syrnike::windows_media::TrackStateChangedEvent;
using syrnike::windows_media::engineStateName;
using syrnike::windows_media::trackKindName;

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

[[noreturn]] void throwProtocolInvalid(Napi::Env env, const std::string& message) {
  auto error = Napi::TypeError::New(env, message);
  error.Value().Set("code", "desired_state_invalid");
  error.Value().Set("stage", "binding_decode");
  error.Value().Set("retryable", false);
  throw error;
}

void requireExactKeys(
  Napi::Env env,
  const Napi::Object& object,
  const std::vector<const char*>& expected
) {
  // The utility host performs exact excess-property validation before calling
  // the addon. Native decoding only probes the fixed field set so hostile
  // objects cannot make the parser allocate an unbounded property-name array.
  for (const auto* key : expected) {
    if (!object.HasOwnProperty(key)) {
      throwProtocolInvalid(env, std::string("Object is missing field: ") + key);
    }
  }
}

std::string boundedAsciiString(
  Napi::Env env,
  const Napi::Value& value,
  const char* field,
  std::size_t maximum_length
) {
  if (!value.IsString()) {
    throwProtocolInvalid(env, std::string(field) + " must be a string");
  }
  std::size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > maximum_length) {
    throwProtocolInvalid(env, std::string(field) + " exceeds its bounded length");
  }
  std::vector<char> buffer(length + 1);
  std::size_t copied = 0;
  if (napi_get_value_string_utf8(
        env,
        value,
        buffer.data(),
        buffer.size(),
        &copied
      ) != napi_ok || copied != length) {
    throwProtocolInvalid(env, std::string(field) + " could not be decoded");
  }
  for (std::size_t index = 0; index < copied; ++index) {
    const auto character = static_cast<unsigned char>(buffer[index]);
    if (character < 0x21 || character > 0x7e) {
      throwProtocolInvalid(env, std::string(field) + " must use printable ASCII");
    }
  }
  return std::string(buffer.data(), copied);
}

std::string boundedIdentifier(
  Napi::Env env,
  const Napi::Value& value,
  const char* field
) {
  return boundedAsciiString(
    env,
    value,
    field,
    syrnike::windows_media::kMaximumIdentifierLength
  );
}

void requireOffIntent(Napi::Env env, const Napi::Value& value, const char* field) {
  if (!value.IsObject() || value.IsArray() || value.IsNull()) {
    throwProtocolInvalid(env, std::string(field) + " intent must be an object");
  }
  const auto intent = value.As<Napi::Object>();
  requireExactKeys(env, intent, {"state"});
  const auto state = intent.Get("state");
  if (boundedAsciiString(env, state, field, 16) != "off") {
    throwProtocolInvalid(env, std::string(field) + " currently supports only off");
  }
}

EngineDesiredState parseDesiredState(Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject() || value.IsArray() || value.IsNull()) {
    throwProtocolInvalid(env, "Desired state must be an object");
  }
  const auto object = value.As<Napi::Object>();
  requireExactKeys(env, object, {
    "revision", "room", "microphone", "camera", "screen", "output",
    "remoteVideoDemand",
  });
  const auto revision_value = object.Get("revision");
  if (!revision_value.IsNumber()) {
    throwProtocolInvalid(env, "Desired state revision must be a number");
  }
  const double revision_number = revision_value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(revision_number) || revision_number < 1 ||
      revision_number > 9007199254740991.0 ||
      std::floor(revision_number) != revision_number) {
    throwProtocolInvalid(env, "Desired state revision must be a positive safe integer");
  }

  std::optional<RoomIntent> room;
  const auto room_value = object.Get("room");
  if (!room_value.IsNull()) {
    if (!room_value.IsObject() || room_value.IsArray()) {
      throwProtocolInvalid(env, "Room intent must be null or an object");
    }
    const auto room_object = room_value.As<Napi::Object>();
    requireExactKeys(env, room_object, {"roomId", "participantIdentity"});
    room = RoomIntent{
      boundedIdentifier(env, room_object.Get("roomId"), "roomId"),
      boundedIdentifier(
        env,
        room_object.Get("participantIdentity"),
        "participantIdentity"
      ),
    };
  }
  requireOffIntent(env, object.Get("microphone"), "microphone");
  requireOffIntent(env, object.Get("camera"), "camera");
  requireOffIntent(env, object.Get("screen"), "screen");
  requireOffIntent(env, object.Get("output"), "output");

  const auto demands_value = object.Get("remoteVideoDemand");
  if (!demands_value.IsArray()) {
    throwProtocolInvalid(env, "remoteVideoDemand must be an array");
  }
  const auto demands_array = demands_value.As<Napi::Array>();
  if (demands_array.Length() > syrnike::windows_media::kMaximumRemoteVideoDemands) {
    throwProtocolInvalid(env, "remoteVideoDemand exceeds its bounded entry limit");
  }
  std::vector<RemoteVideoDemand> demands;
  demands.reserve(demands_array.Length());
  for (std::uint32_t index = 0; index < demands_array.Length(); ++index) {
    const auto entry_value = demands_array.Get(index);
    if (!entry_value.IsObject() || entry_value.IsArray() || entry_value.IsNull()) {
      throwProtocolInvalid(env, "remoteVideoDemand entry must be an object");
    }
    const auto entry = entry_value.As<Napi::Object>();
    requireExactKeys(env, entry, {
      "participantIdentity", "publicationId", "quality",
    });
    const auto quality = entry.Get("quality");
    if (boundedAsciiString(env, quality, "quality", 16) != "off") {
      throwProtocolInvalid(env, "Remote video quality currently supports only off");
    }
    demands.push_back(RemoteVideoDemand{
      boundedIdentifier(
        env,
        entry.Get("participantIdentity"),
        "participantIdentity"
      ),
      boundedIdentifier(env, entry.Get("publicationId"), "publicationId"),
    });
  }
  return EngineDesiredState{
    static_cast<std::uint64_t>(revision_number),
    std::move(room),
    std::move(demands),
  };
}

Napi::Object desiredStateObject(Napi::Env env, const EngineDesiredState& state) {
  auto object = Napi::Object::New(env);
  object.Set("revision", Napi::Number::New(env, static_cast<double>(state.revision)));
  if (state.room) {
    auto room = Napi::Object::New(env);
    room.Set("roomId", state.room->room_id);
    room.Set("participantIdentity", state.room->participant_identity);
    object.Set("room", room);
  } else {
    object.Set("room", env.Null());
  }
  for (const auto* field : {"microphone", "camera", "screen", "output"}) {
    auto intent = Napi::Object::New(env);
    intent.Set("state", "off");
    object.Set(field, intent);
  }
  auto demands = Napi::Array::New(env, state.remote_video_demand.size());
  for (std::size_t index = 0; index < state.remote_video_demand.size(); ++index) {
    auto entry = Napi::Object::New(env);
    entry.Set("participantIdentity", state.remote_video_demand[index].participant_identity);
    entry.Set("publicationId", state.remote_video_demand[index].publication_id);
    entry.Set("quality", "off");
    demands.Set(static_cast<std::uint32_t>(index), entry);
  }
  object.Set("remoteVideoDemand", demands);
  return object;
}

std::chrono::milliseconds requestDeadline(
  Napi::Env env,
  const Napi::CallbackInfo& info,
  std::size_t index,
  std::chrono::milliseconds fallback
) {
  if (info.Length() <= index || info[index].IsUndefined()) return fallback;
  if (!info[index].IsNumber()) {
    throwProtocolInvalid(env, "Request deadline must be a number");
  }
  const double value = info[index].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(value) || value < 1 ||
      value > syrnike::windows_media::kMaximumRequestDeadlineMs ||
      std::floor(value) != value) {
    throwProtocolInvalid(env, "Request deadline is outside the bounded range");
  }
  return std::chrono::milliseconds(static_cast<std::uint32_t>(value));
}

class AddonOwner final {
 public:
  explicit AddonOwner(Napi::Env env) : env_(env) {}

  ~AddonOwner() {
    static_cast<void>(engine_.shutdown());
    if (public_callback_) {
      napi_release_threadsafe_function(
        public_callback_,
        napi_tsfn_release
      );
      public_callback_ = nullptr;
    }
    if (diagnostic_callback_) {
      napi_release_threadsafe_function(
        diagnostic_callback_,
        napi_tsfn_release
      );
      diagnostic_callback_ = nullptr;
    }
  }

  AddonOwner(const AddonOwner&) = delete;
  AddonOwner& operator=(const AddonOwner&) = delete;

  Napi::Value registerPublicEventCallback(const Napi::CallbackInfo& info) {
    if (public_callback_) {
      throwFailure(env_, EngineFailure{
        "callback_already_registered",
        "Only one public event callback may be registered",
        "register_public_event_callback",
        false,
      });
      return env_.Undefined();
    }
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(
        env_,
        "registerPublicEventCallback requires one function"
      );
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
      &public_callback_
    );
    if (created != napi_ok) {
      public_callback_ = nullptr;
      throw Napi::Error::New(env_, "Failed to create bounded public callback");
    }
    const auto registered = engine_.registerEventCallback(
      [this](const PublicEvent& event) { enqueueEvent(event); }
    );
    if (!registered.ok) {
      napi_release_threadsafe_function(
        public_callback_,
        napi_tsfn_abort
      );
      public_callback_ = nullptr;
      return requireSuccess(env_, registered);
    }
    return Napi::Boolean::New(env_, true);
  }

  Napi::Value registerDiagnosticEventCallback(const Napi::CallbackInfo& info) {
    if (diagnostic_callback_) {
      throwFailure(env_, EngineFailure{
        "callback_already_registered",
        "Only one diagnostic event callback may be registered",
        "register_diagnostic_callback",
        false,
      });
      return env_.Undefined();
    }
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(
        env_,
        "registerDiagnosticEventCallback requires one function"
      );
    }
    const auto resource_name = Napi::String::New(env_, "windows-media-diagnostic");
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
      &AddonOwner::callDiagnosticJavaScript,
      &diagnostic_callback_
    );
    if (created != napi_ok) {
      diagnostic_callback_ = nullptr;
      throw Napi::Error::New(env_, "Failed to create bounded diagnostic callback");
    }
    const auto registered = engine_.registerDiagnosticEventCallback(
      [this](const DiagnosticEvent& event) { enqueueDiagnostic(event); }
    );
    if (!registered.ok) {
      napi_release_threadsafe_function(diagnostic_callback_, napi_tsfn_abort);
      diagnostic_callback_ = nullptr;
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
    result.Set("protocolVersion", syrnike::windows_media::kProtocolVersion);
    result.Set("engineState", engineStateName(engine_.state()));
    result.Set("build", build);
    return result;
  }

  Napi::Value ping(const Napi::CallbackInfo& info) {
    const auto result = engine_.ping(requestDeadline(
      env_, info, 0, syrnike::windows_media::kPingDeadline
    ));
    if (!result.ok) return requireSuccess(env_, result);
    auto pong = Napi::Object::New(env_);
    pong.Set("type", "pong");
    pong.Set("engineState", engineStateName(engine_.state()));
    return pong;
  }

  Napi::Value applyDesiredState(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || info.Length() > 2) {
      throwProtocolInvalid(
        env_,
        "applyDesiredState requires desired state and an optional deadline"
      );
    }
    const auto result = engine_.applyDesiredState(
      parseDesiredState(env_, info[0]),
      requestDeadline(env_, info, 1, syrnike::windows_media::kControlDeadline)
    );
    if (!result.ok) {
      throwFailure(env_, result.failure.value_or(EngineFailure{
        "native_failure",
        "Windows media engine rejected desired state without a typed failure",
        "apply_desired_state",
        false,
      }));
      return env_.Undefined();
    }
    auto accepted = Napi::Object::New(env_);
    accepted.Set("type", "desiredStateAccepted");
    accepted.Set(
      "acceptedRevision",
      Napi::Number::New(env_, static_cast<double>(result.accepted_revision))
    );
    accepted.Set("disposition", result.duplicate ? "duplicate" : "accepted");
    return accepted;
  }

  Napi::Value querySnapshot(const Napi::CallbackInfo& info) {
    const auto result = engine_.querySnapshot(requestDeadline(
      env_, info, 0, syrnike::windows_media::kControlDeadline
    ));
    if (!result.ok || !result.snapshot) {
      throwFailure(env_, result.failure.value_or(EngineFailure{
        "native_failure",
        "Windows media engine returned no snapshot",
        "query_snapshot",
        false,
      }));
      return env_.Undefined();
    }
    const auto& value = *result.snapshot;
    auto snapshot = Napi::Object::New(env_);
    snapshot.Set("engineState", engineStateName(value.engine_state));
    if (value.desired_state) {
      snapshot.Set(
        "acceptedRevision",
        Napi::Number::New(env_, static_cast<double>(value.accepted_revision))
      );
      snapshot.Set("desiredState", desiredStateObject(env_, *value.desired_state));
      snapshot.Set("roomState", value.desired_state->room ? "desired" : "off");
    } else {
      snapshot.Set("acceptedRevision", env_.Null());
      snapshot.Set("desiredState", env_.Null());
      snapshot.Set("roomState", "off");
    }
    auto tracks = Napi::Object::New(env_);
    tracks.Set("microphone", "off");
    tracks.Set("camera", "off");
    tracks.Set("screen", "off");
    tracks.Set("output", "off");
    snapshot.Set("tracks", tracks);
    auto response = Napi::Object::New(env_);
    response.Set("type", "snapshot");
    response.Set("snapshot", snapshot);
    return response;
  }

  Napi::Value shutdown(const Napi::CallbackInfo& info) {
    const auto result = engine_.shutdown(requestDeadline(
      env_, info, 0, syrnike::windows_media::kShutdownDeadline
    ));
    if (!result.ok) return requireSuccess(env_, result);
    auto stopped = Napi::Object::New(env_);
    stopped.Set("type", "shutdownComplete");
    stopped.Set("engineState", engineStateName(engine_.state()));
    return stopped;
  }

 private:
  struct QueuedEvent {
    PublicEvent value;
  };

  struct QueuedDiagnostic {
    DiagnosticEvent value;
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
    if (const auto* lifecycle = std::get_if<LifecycleEvent>(&queued->value)) {
      event.Set("type", "engineStateChanged");
      event.Set(
        "sequence",
        Napi::Number::New(env, static_cast<double>(lifecycle->sequence))
      );
      event.Set("previous", engineStateName(lifecycle->previous));
      event.Set("state", engineStateName(lifecycle->state));
      if (lifecycle->failure) {
        event.Set("failure", failureObject(env, *lifecycle->failure));
      }
    } else if (const auto* room =
                 std::get_if<RoomStateChangedEvent>(&queued->value)) {
      event.Set("type", "roomStateChanged");
      event.Set("sequence", Napi::Number::New(env, static_cast<double>(room->sequence)));
      event.Set("revision", Napi::Number::New(env, static_cast<double>(room->revision)));
      event.Set("state", room->desired ? "desired" : "off");
    } else if (const auto* track =
                 std::get_if<TrackStateChangedEvent>(&queued->value)) {
      event.Set("type", "trackStateChanged");
      event.Set("sequence", Napi::Number::New(env, static_cast<double>(track->sequence)));
      event.Set("revision", Napi::Number::New(env, static_cast<double>(track->revision)));
      event.Set("track", trackKindName(track->track));
      event.Set("state", "off");
    } else if (const auto* fatal =
                 std::get_if<FatalEngineFailureEvent>(&queued->value)) {
      event.Set("type", "fatalEngineFailure");
      event.Set("sequence", Napi::Number::New(env, static_cast<double>(fatal->sequence)));
      event.Set("failure", failureObject(env, fatal->failure));
    }
    callback.Call({event});
  }

  static void callDiagnosticJavaScript(
    napi_env raw_env,
    napi_value raw_callback,
    void*,
    void* raw_data
  ) {
    std::unique_ptr<QueuedDiagnostic> queued(
      static_cast<QueuedDiagnostic*>(raw_data)
    );
    if (!raw_env || !raw_callback || !queued) return;
    Napi::Env env(raw_env);
    Napi::Function callback(env, raw_callback);
    auto event = Napi::Object::New(env);
    event.Set(
      "sequence",
      Napi::Number::New(env, static_cast<double>(queued->value.sequence))
    );
    event.Set(
      "timestampMs",
      Napi::Number::New(env, static_cast<double>(queued->value.timestamp_ms))
    );
    event.Set("component", queued->value.component);
    event.Set("operation", queued->value.operation);
    event.Set("code", queued->value.code);
    auto metrics = Napi::Array::New(env, queued->value.metrics.size());
    for (std::size_t index = 0; index < queued->value.metrics.size(); ++index) {
      auto metric = Napi::Object::New(env);
      metric.Set("name", queued->value.metrics[index].name);
      metric.Set("value", queued->value.metrics[index].value);
      metrics.Set(static_cast<std::uint32_t>(index), metric);
    }
    event.Set("metrics", metrics);
    callback.Call({event});
  }

  void enqueueEvent(const PublicEvent& event) {
    if (!public_callback_) return;
    auto queued = std::make_unique<QueuedEvent>(QueuedEvent{event});
    const napi_status status = napi_call_threadsafe_function(
      public_callback_,
      queued.get(),
      napi_tsfn_nonblocking
    );
    if (status == napi_ok) {
      static_cast<void>(queued.release());
      return;
    }
    // Public state is lossless. The utility process is the recovery boundary,
    // so queue overflow becomes a visible crash/restart instead of silent loss.
    std::terminate();
  }

  void enqueueDiagnostic(const DiagnosticEvent& event) {
    if (!diagnostic_callback_) return;
    auto queued = std::make_unique<QueuedDiagnostic>(QueuedDiagnostic{event});
    const napi_status status = napi_call_threadsafe_function(
      diagnostic_callback_,
      queued.get(),
      napi_tsfn_nonblocking
    );
    if (status == napi_ok) {
      static_cast<void>(queued.release());
    } else {
      diagnostic_events_dropped_.fetch_add(1, std::memory_order_relaxed);
    }
  }

  Napi::Env env_;
  Engine engine_;
  napi_threadsafe_function public_callback_ = nullptr;
  napi_threadsafe_function diagnostic_callback_ = nullptr;
  std::atomic_uint64_t diagnostic_events_dropped_{0};
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

Napi::Value registerPublicEventCallback(const Napi::CallbackInfo& info) {
  return guarded(info, [&info](AddonOwner& value) {
    return value.registerPublicEventCallback(info);
  });
}

Napi::Value registerDiagnosticEventCallback(const Napi::CallbackInfo& info) {
  return guarded(info, [&info](AddonOwner& value) {
    return value.registerDiagnosticEventCallback(info);
  });
}

Napi::Value handshake(const Napi::CallbackInfo& info) {
  return guarded(info, [](AddonOwner& value) { return value.handshake(); });
}

Napi::Value ping(const Napi::CallbackInfo& info) {
  return guarded(info, [&info](AddonOwner& value) { return value.ping(info); });
}

Napi::Value applyDesiredState(const Napi::CallbackInfo& info) {
  return guarded(info, [&info](AddonOwner& value) {
    return value.applyDesiredState(info);
  });
}

Napi::Value querySnapshot(const Napi::CallbackInfo& info) {
  return guarded(info, [&info](AddonOwner& value) {
    return value.querySnapshot(info);
  });
}

Napi::Value shutdown(const Napi::CallbackInfo& info) {
  return guarded(info, [&info](AddonOwner& value) {
    return value.shutdown(info);
  });
}

void finalizeAddon(Napi::Env, AddonOwner* value) {
  delete value;
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  env.SetInstanceData<AddonOwner, finalizeAddon>(new AddonOwner(env));
  exports.Set(
    "registerPublicEventCallback",
    Napi::Function::New(env, registerPublicEventCallback)
  );
  exports.Set(
    "registerDiagnosticEventCallback",
    Napi::Function::New(env, registerDiagnosticEventCallback)
  );
  exports.Set("handshake", Napi::Function::New(env, handshake));
  exports.Set("applyDesiredState", Napi::Function::New(env, applyDesiredState));
  exports.Set("querySnapshot", Napi::Function::New(env, querySnapshot));
  exports.Set("ping", Napi::Function::New(env, ping));
  exports.Set("shutdown", Napi::Function::New(env, shutdown));
  return exports;
}

}  // namespace

NODE_API_MODULE(windows_media, initialize)
