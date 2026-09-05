#include <napi.h>

#include <array>
#include <atomic>
#include <cmath>
#include <deque>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "core/engine.hpp"
#include "livekit/livekit_room_transport.hpp"

#ifndef WINDOWS_MEDIA_COMMIT
#define WINDOWS_MEDIA_COMMIT "unknown"
#endif

namespace {

using syrnike::windows_media::CredentialLease;
using syrnike::windows_media::DiagnosticEvent;
using syrnike::windows_media::Engine;
using syrnike::windows_media::EngineDesiredState;
using syrnike::windows_media::EngineFailure;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::engineStateName;
using syrnike::windows_media::FatalEngineFailureEvent;
using syrnike::windows_media::LifecycleEvent;
using syrnike::windows_media::LiveKitRoomTransport;
using syrnike::windows_media::PublicEvent;
using syrnike::windows_media::RemoteVideoDemand;
using syrnike::windows_media::RoomIntent;
using syrnike::windows_media::roomPublicStateName;
using syrnike::windows_media::RoomStateChangedEvent;
using syrnike::windows_media::trackKindName;
using syrnike::windows_media::TrackStateChangedEvent;

void throwFailure(Napi::Env env, const EngineFailure &failure) {
  auto error = Napi::Error::New(env, failure.message);
  error.Value().Set("code", failure.code);
  error.Value().Set("stage", failure.stage);
  error.Value().Set("retryable", Napi::Boolean::New(env, failure.retryable));
  error.ThrowAsJavaScriptException();
}

Napi::Value requireSuccess(Napi::Env env, const EngineResult &result) {
  if (result.ok)
    return env.Undefined();
  throwFailure(env, result.failure.value_or(EngineFailure{
                        "native_failure",
                        "Windows media engine returned an untyped failure",
                        "binding",
                        false,
                    }));
  return env.Undefined();
}

template <std::size_t Size>
Napi::String protocolField(
    Napi::Env env, const std::array<std::string_view, Size> &fields,
    std::size_t index) {
  const auto field = fields.at(index);
  return Napi::String::New(env, field.data(), field.size());
}

Napi::Object failureObject(Napi::Env env, const EngineFailure &failure) {
  auto object = Napi::Object::New(env);
  const auto &fields = syrnike::windows_media::protocol::fields::kFailure;
  object.Set(protocolField(env, fields, 0), failure.code);
  object.Set(protocolField(env, fields, 1), failure.message);
  object.Set(protocolField(env, fields, 2), failure.stage);
  object.Set(protocolField(env, fields, 3), failure.retryable);
  return object;
}

[[noreturn]] void throwProtocolInvalid(Napi::Env env,
                                       const std::string &message) {
  auto error = Napi::TypeError::New(env, message);
  error.Value().Set("code", "desired_state_invalid");
  error.Value().Set("stage", "binding_decode");
  error.Value().Set("retryable", false);
  throw error;
}

void requireExactKeys(Napi::Env env, const Napi::Object &object,
                      const std::vector<const char *> &expected) {
  // The utility host performs exact excess-property validation before calling
  // the addon. Native decoding only probes the fixed field set so hostile
  // objects cannot make the parser allocate an unbounded property-name array.
  for (const auto *key : expected) {
    if (!object.HasOwnProperty(key)) {
      throwProtocolInvalid(env, std::string("Object is missing field: ") + key);
    }
  }
}

template <std::size_t Size>
void requireExactKeys(Napi::Env env, const Napi::Object &object,
                      const std::array<std::string_view, Size> &expected) {
  for (const auto key : expected) {
    const auto property = Napi::String::New(env, key.data(), key.size());
    if (!object.HasOwnProperty(property)) {
      throwProtocolInvalid(env, std::string("Object is missing field: ") +
                                    std::string(key));
    }
  }
}

std::string boundedAsciiString(Napi::Env env, const Napi::Value &value,
                               const char *field, std::size_t maximum_length) {
  if (!value.IsString()) {
    throwProtocolInvalid(env, std::string(field) + " must be a string");
  }
  std::size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > maximum_length) {
    throwProtocolInvalid(env,
                         std::string(field) + " exceeds its bounded length");
  }
  std::vector<char> buffer(length + 1);
  std::size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(),
                                 &copied) != napi_ok ||
      copied != length) {
    throwProtocolInvalid(env, std::string(field) + " could not be decoded");
  }
  for (std::size_t index = 0; index < copied; ++index) {
    const auto character = static_cast<unsigned char>(buffer[index]);
    if (character < 0x21 || character > 0x7e) {
      throwProtocolInvalid(env,
                           std::string(field) + " must use printable ASCII");
    }
  }
  return std::string(buffer.data(), copied);
}

std::string boundedIdentifier(Napi::Env env, const Napi::Value &value,
                              const char *field) {
  return boundedAsciiString(env, value, field,
                            syrnike::windows_media::kMaximumIdentifierLength);
}

void requireOffIntent(Napi::Env env, const Napi::Value &value,
                      const char *field) {
  if (!value.IsObject() || value.IsArray() || value.IsNull()) {
    throwProtocolInvalid(env, std::string(field) + " intent must be an object");
  }
  const auto intent = value.As<Napi::Object>();
  requireExactKeys(env, intent, {"state"});
  const auto state = intent.Get("state");
  if (boundedAsciiString(env, state, field, 16) != "off") {
    throwProtocolInvalid(env,
                         std::string(field) + " currently supports only off");
  }
}

EngineDesiredState parseDesiredState(Napi::Env env, const Napi::Value &value) {
  if (!value.IsObject() || value.IsArray() || value.IsNull()) {
    throwProtocolInvalid(env, "Desired state must be an object");
  }
  const auto object = value.As<Napi::Object>();
  requireExactKeys(
      env, object,
      syrnike::windows_media::protocol::fields::kEngineDesiredState);
  const auto revision_value = object.Get("revision");
  if (!revision_value.IsNumber()) {
    throwProtocolInvalid(env, "Desired state revision must be a number");
  }
  const double revision_number =
      revision_value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(revision_number) || revision_number < 1 ||
      revision_number > 9007199254740991.0 ||
      std::floor(revision_number) != revision_number) {
    throwProtocolInvalid(
        env, "Desired state revision must be a positive safe integer");
  }

  std::optional<RoomIntent> room;
  const auto room_value = object.Get("room");
  if (!room_value.IsNull()) {
    if (!room_value.IsObject() || room_value.IsArray()) {
      throwProtocolInvalid(env, "Room intent must be null or an object");
    }
    const auto room_object = room_value.As<Napi::Object>();
    requireExactKeys(env, room_object,
                     syrnike::windows_media::protocol::fields::kRoomIntent);
    room = RoomIntent{
        boundedIdentifier(env, room_object.Get("roomId"), "roomId"),
        boundedIdentifier(env, room_object.Get("participantIdentity"),
                          "participantIdentity"),
        boundedIdentifier(env, room_object.Get("credentialLeaseId"),
                          "credentialLeaseId"),
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
  if (demands_array.Length() >
      syrnike::windows_media::kMaximumRemoteVideoDemands) {
    throwProtocolInvalid(env,
                         "remoteVideoDemand exceeds its bounded entry limit");
  }
  std::vector<RemoteVideoDemand> demands;
  demands.reserve(demands_array.Length());
  for (std::uint32_t index = 0; index < demands_array.Length(); ++index) {
    const auto entry_value = demands_array.Get(index);
    if (!entry_value.IsObject() || entry_value.IsArray() ||
        entry_value.IsNull()) {
      throwProtocolInvalid(env, "remoteVideoDemand entry must be an object");
    }
    const auto entry = entry_value.As<Napi::Object>();
    requireExactKeys(
        env, entry,
        syrnike::windows_media::protocol::fields::kRemoteVideoDemand);
    const auto quality = entry.Get("quality");
    if (boundedAsciiString(env, quality, "quality", 16) != "off") {
      throwProtocolInvalid(env,
                           "Remote video quality currently supports only off");
    }
    demands.push_back(RemoteVideoDemand{
        boundedIdentifier(env, entry.Get("participantIdentity"),
                          "participantIdentity"),
        boundedIdentifier(env, entry.Get("publicationId"), "publicationId"),
    });
  }
  return EngineDesiredState{
      static_cast<std::uint64_t>(revision_number),
      std::move(room),
      {},
      {},
      {},
      {},
      std::move(demands),
  };
}

Napi::Object desiredStateObject(Napi::Env env,
                                const EngineDesiredState &state) {
  auto object = Napi::Object::New(env);
  object.Set("revision",
             Napi::Number::New(env, static_cast<double>(state.revision)));
  if (state.room) {
    auto room = Napi::Object::New(env);
    room.Set("roomId", state.room->room_id);
    room.Set("participantIdentity", state.room->participant_identity);
    room.Set("credentialLeaseId", state.room->credential_lease_id);
    object.Set("room", room);
  } else {
    object.Set("room", env.Null());
  }
  for (const auto *field : {"microphone", "camera", "screen", "output"}) {
    auto intent = Napi::Object::New(env);
    intent.Set("state", "off");
    object.Set(field, intent);
  }
  auto demands = Napi::Array::New(env, state.remote_video_demand.size());
  for (std::size_t index = 0; index < state.remote_video_demand.size();
       ++index) {
    auto entry = Napi::Object::New(env);
    entry.Set("participantIdentity",
              state.remote_video_demand[index].participant_identity);
    entry.Set("publicationId", state.remote_video_demand[index].publication_id);
    entry.Set("quality", "off");
    demands.Set(static_cast<std::uint32_t>(index), entry);
  }
  object.Set("remoteVideoDemand", demands);
  return object;
}

std::chrono::milliseconds requestDeadline(Napi::Env env,
                                          const Napi::CallbackInfo &info,
                                          std::size_t index,
                                          std::chrono::milliseconds fallback) {
  if (info.Length() <= index || info[index].IsUndefined())
    return fallback;
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
private:
  struct PublicDispatchState final {
    std::mutex mutex;
    std::deque<PublicEvent> events;
    bool dispatch_scheduled = false;
    napi_threadsafe_function callback = nullptr;
  };
  struct DiagnosticDispatchState final {
    napi_threadsafe_function callback = nullptr;
    std::atomic_uint64_t dropped{0};
  };

public:
  explicit AddonOwner(Napi::Env env)
      : env_(env), room_transport_(std::make_shared<LiveKitRoomTransport>()),
        engine_(syrnike::windows_media::EngineOptions{
            .room_transport = room_transport_,
        }) {}

  ~AddonOwner() { cleanup(); }

  void cleanup() {
    const auto shutdown = engine_.shutdown();
    if (!shutdown.ok) {
      // Native callbacks still own their TSFN references until Engine shutdown
      // completes. The utility process is the escalation boundary.
      std::terminate();
    }
    if (public_dispatch_) {
      auto dispatch = std::exchange(public_dispatch_, {});
      napi_release_threadsafe_function(dispatch->callback, napi_tsfn_abort);
    }
    if (diagnostic_dispatch_) {
      auto dispatch = std::exchange(diagnostic_dispatch_, {});
      napi_release_threadsafe_function(dispatch->callback, napi_tsfn_abort);
    }
  }

  AddonOwner(const AddonOwner &) = delete;
  AddonOwner &operator=(const AddonOwner &) = delete;

  Napi::Value registerPublicEventCallback(const Napi::CallbackInfo &info) {
    if (public_dispatch_) {
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
          env_, "registerPublicEventCallback requires one function");
    }
    const auto resource_name =
        Napi::String::New(env_, "windows-media-lifecycle");
    auto dispatch = std::make_shared<PublicDispatchState>();
    auto *finalizer_hold = new std::shared_ptr<PublicDispatchState>(dispatch);
    const napi_status created = napi_create_threadsafe_function(
        env_, info[0], nullptr, resource_name, 1, 1, finalizer_hold,
        &AddonOwner::finalizePublicDispatch, dispatch.get(),
        &AddonOwner::callJavaScript, &dispatch->callback);
    if (created != napi_ok) {
      delete finalizer_hold;
      throw Napi::Error::New(env_, "Failed to create bounded public callback");
    }
    public_dispatch_ = dispatch;
    const auto registered =
        engine_.registerEventCallback([dispatch](const PublicEvent &event) {
          enqueueEvent(*dispatch, event);
        });
    if (!registered.ok) {
      auto failed_dispatch = std::exchange(public_dispatch_, {});
      napi_release_threadsafe_function(failed_dispatch->callback,
                                       napi_tsfn_abort);
      return requireSuccess(env_, registered);
    }
    return Napi::Boolean::New(env_, true);
  }

  Napi::Value registerDiagnosticEventCallback(const Napi::CallbackInfo &info) {
    if (diagnostic_dispatch_) {
      throwFailure(env_,
                   EngineFailure{
                       "callback_already_registered",
                       "Only one diagnostic event callback may be registered",
                       "register_diagnostic_callback",
                       false,
                   });
      return env_.Undefined();
    }
    if (info.Length() != 1 || !info[0].IsFunction()) {
      throw Napi::TypeError::New(
          env_, "registerDiagnosticEventCallback requires one function");
    }
    const auto resource_name =
        Napi::String::New(env_, "windows-media-diagnostic");
    auto dispatch = std::make_shared<DiagnosticDispatchState>();
    auto *finalizer_hold =
        new std::shared_ptr<DiagnosticDispatchState>(dispatch);
    const napi_status created = napi_create_threadsafe_function(
        env_, info[0], nullptr, resource_name,
        syrnike::windows_media::kEventQueueCapacity, 1, finalizer_hold,
        &AddonOwner::finalizeDiagnosticDispatch, dispatch.get(),
        &AddonOwner::callDiagnosticJavaScript, &dispatch->callback);
    if (created != napi_ok) {
      delete finalizer_hold;
      throw Napi::Error::New(env_,
                             "Failed to create bounded diagnostic callback");
    }
    diagnostic_dispatch_ = dispatch;
    const auto registered = engine_.registerDiagnosticEventCallback(
        [dispatch](const DiagnosticEvent &event) {
          enqueueDiagnostic(*dispatch, event);
        });
    if (!registered.ok) {
      auto failed_dispatch = std::exchange(diagnostic_dispatch_, {});
      napi_release_threadsafe_function(failed_dispatch->callback,
                                       napi_tsfn_abort);
      return requireSuccess(env_, registered);
    }
    return Napi::Boolean::New(env_, true);
  }

  Napi::Value handshake() {
    const auto started = engine_.start();
    if (!started.ok)
      return requireSuccess(env_, started);
    auto build = Napi::Object::New(env_);
    build.Set("commit", WINDOWS_MEDIA_COMMIT);
    build.Set("napi", std::to_string(NAPI_VERSION));
    build.Set("protocolSchemaSha256",
              std::string(syrnike::windows_media::protocol::kSchemaSha256));
    auto result = Napi::Object::New(env_);
    result.Set("protocolVersion", syrnike::windows_media::kProtocolVersion);
    result.Set("engineState", engineStateName(engine_.state()));
    result.Set("build", build);
    return result;
  }

  Napi::Value ping(const Napi::CallbackInfo &info) {
    const auto result = engine_.ping(
        requestDeadline(env_, info, 0, syrnike::windows_media::kPingDeadline));
    if (!result.ok)
      return requireSuccess(env_, result);
    auto pong = Napi::Object::New(env_);
    pong.Set("type", "pong");
    pong.Set("engineState", engineStateName(engine_.state()));
    return pong;
  }

  Napi::Value installCredentialLease(const Napi::CallbackInfo &info) {
    if (info.Length() < 1 || info.Length() > 2 || !info[0].IsObject() ||
        info[0].IsArray() || info[0].IsNull()) {
      throwProtocolInvalid(env_, "installCredentialLease requires a credential "
                                 "lease and optional deadline");
    }
    const auto object = info[0].As<Napi::Object>();
    requireExactKeys(
        env_, object,
        syrnike::windows_media::protocol::fields::kCredentialLease);
    const auto result = engine_.installCredentialLease(
        CredentialLease{
            boundedIdentifier(env_, object.Get("leaseId"), "leaseId"),
            boundedAsciiString(env_, object.Get("serverUrl"), "serverUrl",
                               2048),
            boundedAsciiString(env_, object.Get("accessToken"), "accessToken",
                               16384),
        },
        requestDeadline(env_, info, 1,
                        syrnike::windows_media::kControlDeadline));
    if (!result.ok) {
      throwFailure(env_, result.failure.value_or(EngineFailure{
                             "native_failure",
                             "Windows media engine rejected a credential lease "
                             "without a typed failure",
                             "install_credential_lease",
                             false,
                         }));
      return env_.Undefined();
    }
    auto installed = Napi::Object::New(env_);
    installed.Set("type", "credentialLeaseInstalled");
    installed.Set("leaseId", result.lease_id);
    return installed;
  }

  Napi::Value applyDesiredState(const Napi::CallbackInfo &info) {
    if (info.Length() < 1 || info.Length() > 2) {
      throwProtocolInvalid(
          env_,
          "applyDesiredState requires desired state and an optional deadline");
    }
    const auto result = engine_.applyDesiredState(
        parseDesiredState(env_, info[0]),
        requestDeadline(env_, info, 1,
                        syrnike::windows_media::kControlDeadline));
    if (!result.ok) {
      throwFailure(env_, result.failure.value_or(EngineFailure{
                             "native_failure",
                             "Windows media engine rejected desired state "
                             "without a typed failure",
                             "apply_desired_state",
                             false,
                         }));
      return env_.Undefined();
    }
    auto accepted = Napi::Object::New(env_);
    accepted.Set("type", "desiredStateAccepted");
    accepted.Set(
        "acceptedRevision",
        Napi::Number::New(env_, static_cast<double>(result.accepted_revision)));
    accepted.Set("disposition", result.duplicate ? "duplicate" : "accepted");
    return accepted;
  }

  Napi::Value querySnapshot(const Napi::CallbackInfo &info) {
    const auto result = engine_.querySnapshot(requestDeadline(
        env_, info, 0, syrnike::windows_media::kControlDeadline));
    if (!result.ok || !result.snapshot) {
      throwFailure(env_, result.failure.value_or(EngineFailure{
                             "native_failure",
                             "Windows media engine returned no snapshot",
                             "query_snapshot",
                             false,
                         }));
      return env_.Undefined();
    }
    const auto &value = *result.snapshot;
    auto snapshot = Napi::Object::New(env_);
    snapshot.Set("engineState", engineStateName(value.engine_state));
    if (value.desired_state) {
      snapshot.Set("acceptedRevision",
                   Napi::Number::New(
                       env_, static_cast<double>(value.accepted_revision)));
      snapshot.Set("desiredState",
                   desiredStateObject(env_, *value.desired_state));
    } else {
      snapshot.Set("acceptedRevision", env_.Null());
      snapshot.Set("desiredState", env_.Null());
    }
    snapshot.Set("roomState", roomPublicStateName(value.room_state));
    if (value.room_failure) {
      snapshot.Set("roomFailure", failureObject(env_, *value.room_failure));
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

  Napi::Value shutdown(const Napi::CallbackInfo &info) {
    const auto result = engine_.shutdown(requestDeadline(
        env_, info, 0, syrnike::windows_media::kShutdownDeadline));
    if (!result.ok)
      return requireSuccess(env_, result);
    auto stopped = Napi::Object::New(env_);
    stopped.Set("type", "shutdownComplete");
    stopped.Set("engineState", engineStateName(engine_.state()));
    return stopped;
  }

private:
  struct QueuedDiagnostic {
    DiagnosticEvent value;
  };

  static void finalizePublicDispatch(napi_env, void *raw_data, void *) {
    delete static_cast<std::shared_ptr<PublicDispatchState> *>(raw_data);
  }

  static void finalizeDiagnosticDispatch(napi_env, void *raw_data, void *) {
    delete static_cast<std::shared_ptr<DiagnosticDispatchState> *>(raw_data);
  }

  static void callJavaScript(napi_env raw_env, napi_value raw_callback,
                             void *raw_context, void *) {
    auto *dispatch = static_cast<PublicDispatchState *>(raw_context);
    if (!raw_env || !raw_callback || !dispatch)
      return;
    const auto queued = takePublicEvent(*dispatch);
    if (!queued)
      return;
    Napi::Env env(raw_env);
    Napi::Function callback(env, raw_callback);
    auto event = Napi::Object::New(env);
    if (const auto *lifecycle = std::get_if<LifecycleEvent>(&*queued)) {
      const auto &fields = syrnike::windows_media::protocol::event_fields::
          kEngineStateChangedRequired;
      event.Set(protocolField(env, fields, 0), "engineStateChanged");
      event.Set(protocolField(env, fields, 1),
                Napi::Number::New(env,
                                  static_cast<double>(lifecycle->sequence)));
      event.Set(protocolField(env, fields, 2),
                engineStateName(lifecycle->previous));
      event.Set(protocolField(env, fields, 3),
                engineStateName(lifecycle->state));
      if (lifecycle->failure) {
        const auto &optional = syrnike::windows_media::protocol::event_fields::
            kEngineStateChangedOptional;
        event.Set(protocolField(env, optional, 0),
                  failureObject(env, *lifecycle->failure));
      }
    } else if (const auto *room =
                   std::get_if<RoomStateChangedEvent>(&*queued)) {
      const auto &fields = syrnike::windows_media::protocol::event_fields::
          kRoomStateChangedRequired;
      event.Set(protocolField(env, fields, 0), "roomStateChanged");
      event.Set(protocolField(env, fields, 1),
                Napi::Number::New(env, static_cast<double>(room->sequence)));
      event.Set(protocolField(env, fields, 2),
                Napi::Number::New(env, static_cast<double>(room->revision)));
      event.Set(protocolField(env, fields, 3), roomPublicStateName(room->state));
      if (room->failure) {
        const auto &optional = syrnike::windows_media::protocol::event_fields::
            kRoomStateChangedOptional;
        event.Set(protocolField(env, optional, 0),
                  failureObject(env, *room->failure));
      }
    } else if (const auto *track =
                   std::get_if<TrackStateChangedEvent>(&*queued)) {
      const auto &fields = syrnike::windows_media::protocol::event_fields::
          kTrackStateChangedRequired;
      event.Set(protocolField(env, fields, 0), "trackStateChanged");
      event.Set(protocolField(env, fields, 1),
                Napi::Number::New(env, static_cast<double>(track->sequence)));
      event.Set(protocolField(env, fields, 2),
                Napi::Number::New(env, static_cast<double>(track->revision)));
      event.Set(protocolField(env, fields, 3), trackKindName(track->track));
      event.Set(protocolField(env, fields, 4), "off");
    } else if (const auto *fatal =
                   std::get_if<FatalEngineFailureEvent>(&*queued)) {
      const auto &fields = syrnike::windows_media::protocol::event_fields::
          kFatalEngineFailureRequired;
      event.Set(protocolField(env, fields, 0), "fatalEngineFailure");
      event.Set(protocolField(env, fields, 1),
                Napi::Number::New(env, static_cast<double>(fatal->sequence)));
      event.Set(protocolField(env, fields, 2),
                failureObject(env, fatal->failure));
    }
    callback.Call({event});
    schedulePublicDispatch(*dispatch);
  }

  static void callDiagnosticJavaScript(napi_env raw_env,
                                       napi_value raw_callback, void *,
                                       void *raw_data) {
    std::unique_ptr<QueuedDiagnostic> queued(
        static_cast<QueuedDiagnostic *>(raw_data));
    if (!raw_env || !raw_callback || !queued)
      return;
    Napi::Env env(raw_env);
    Napi::Function callback(env, raw_callback);
    auto event = Napi::Object::New(env);
    event.Set("sequence", Napi::Number::New(env, static_cast<double>(
                                                     queued->value.sequence)));
    event.Set("timestampMs",
              Napi::Number::New(
                  env, static_cast<double>(queued->value.timestamp_ms)));
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

  static void enqueueEvent(PublicDispatchState &dispatch,
                           const PublicEvent &event) {
    static_assert(std::variant_size_v<PublicEvent> == 4,
                  "New public event variants require a coalescing policy");
    static_assert(syrnike::windows_media::kEventQueueCapacity >= 7,
                  "The public queue must hold every coalesced state category");
    bool schedule = false;
    {
      std::lock_guard lock(dispatch.mutex);
      for (auto iterator = dispatch.events.begin();
           iterator != dispatch.events.end(); ++iterator) {
        const bool same_room_state =
            std::holds_alternative<RoomStateChangedEvent>(event) &&
            std::holds_alternative<RoomStateChangedEvent>(*iterator);
        const bool same_lifecycle_state =
            std::holds_alternative<LifecycleEvent>(event) &&
            std::holds_alternative<LifecycleEvent>(*iterator);
        const bool same_fatal_state =
            std::holds_alternative<FatalEngineFailureEvent>(event) &&
            std::holds_alternative<FatalEngineFailureEvent>(*iterator);
        const auto *incoming_track =
            std::get_if<TrackStateChangedEvent>(&event);
        const auto *queued_track =
            std::get_if<TrackStateChangedEvent>(&*iterator);
        const bool same_track = incoming_track && queued_track &&
                                incoming_track->track == queued_track->track;
        if (same_room_state || same_lifecycle_state || same_fatal_state ||
            same_track) {
          // Remove the stale state and append the replacement below so
          // dispatch order remains monotonic by event sequence.
          dispatch.events.erase(iterator);
          break;
        }
      }
      dispatch.events.push_back(event);
      if (!dispatch.dispatch_scheduled) {
        dispatch.dispatch_scheduled = true;
        schedule = true;
      }
    }
    if (schedule)
      postPublicDispatch(dispatch);
  }

  static std::optional<PublicEvent>
  takePublicEvent(PublicDispatchState &dispatch) {
    std::lock_guard lock(dispatch.mutex);
    if (dispatch.events.empty()) {
      dispatch.dispatch_scheduled = false;
      return std::nullopt;
    }
    auto event = std::move(dispatch.events.front());
    dispatch.events.pop_front();
    dispatch.dispatch_scheduled = false;
    return event;
  }

  static void schedulePublicDispatch(PublicDispatchState &dispatch) {
    bool schedule = false;
    {
      std::lock_guard lock(dispatch.mutex);
      if (!dispatch.events.empty() && !dispatch.dispatch_scheduled) {
        dispatch.dispatch_scheduled = true;
        schedule = true;
      }
    }
    if (schedule)
      postPublicDispatch(dispatch);
  }

  static void postPublicDispatch(PublicDispatchState &dispatch) {
    if (!dispatch.callback)
      return;
    const auto status = napi_call_threadsafe_function(
        dispatch.callback, nullptr, napi_tsfn_nonblocking);
    if (status != napi_ok) {
      std::lock_guard lock(dispatch.mutex);
      dispatch.dispatch_scheduled = false;
    }
  }

  static void enqueueDiagnostic(DiagnosticDispatchState &dispatch,
                                const DiagnosticEvent &event) {
    auto queued = std::make_unique<QueuedDiagnostic>(QueuedDiagnostic{event});
    const napi_status status = napi_call_threadsafe_function(
        dispatch.callback, queued.get(), napi_tsfn_nonblocking);
    if (status == napi_ok) {
      static_cast<void>(queued.release());
    } else {
      dispatch.dropped.fetch_add(1, std::memory_order_relaxed);
    }
  }

  Napi::Env env_;
  std::shared_ptr<LiveKitRoomTransport> room_transport_;
  Engine engine_;
  std::shared_ptr<PublicDispatchState> public_dispatch_;
  std::shared_ptr<DiagnosticDispatchState> diagnostic_dispatch_;
};

AddonOwner *owner(const Napi::CallbackInfo &info) {
  auto *value = info.Env().GetInstanceData<AddonOwner>();
  if (!value)
    throw std::runtime_error("Windows media addon owner is unavailable");
  return value;
}

template <typename Operation>
Napi::Value guarded(const Napi::CallbackInfo &info, Operation operation) {
  try {
    return operation(*owner(info));
  } catch (const Napi::Error &error) {
    error.ThrowAsJavaScriptException();
  } catch (const std::exception &error) {
    throwFailure(info.Env(), EngineFailure{
                                 "native_exception",
                                 error.what(),
                                 "binding",
                                 false,
                             });
  } catch (...) {
    throwFailure(info.Env(),
                 EngineFailure{
                     "native_exception",
                     "Unknown exception crossed the Windows media binding",
                     "binding",
                     false,
                 });
  }
  return info.Env().Undefined();
}

Napi::Value registerPublicEventCallback(const Napi::CallbackInfo &info) {
  return guarded(info, [&info](AddonOwner &value) {
    return value.registerPublicEventCallback(info);
  });
}

Napi::Value registerDiagnosticEventCallback(const Napi::CallbackInfo &info) {
  return guarded(info, [&info](AddonOwner &value) {
    return value.registerDiagnosticEventCallback(info);
  });
}

Napi::Value handshake(const Napi::CallbackInfo &info) {
  return guarded(info, [](AddonOwner &value) { return value.handshake(); });
}

Napi::Value ping(const Napi::CallbackInfo &info) {
  return guarded(info, [&info](AddonOwner &value) { return value.ping(info); });
}

Napi::Value applyDesiredState(const Napi::CallbackInfo &info) {
  return guarded(info, [&info](AddonOwner &value) {
    return value.applyDesiredState(info);
  });
}

Napi::Value installCredentialLease(const Napi::CallbackInfo &info) {
  return guarded(info, [&info](AddonOwner &value) {
    return value.installCredentialLease(info);
  });
}

Napi::Value querySnapshot(const Napi::CallbackInfo &info) {
  return guarded(
      info, [&info](AddonOwner &value) { return value.querySnapshot(info); });
}

Napi::Value shutdown(const Napi::CallbackInfo &info) {
  return guarded(info,
                 [&info](AddonOwner &value) { return value.shutdown(info); });
}

void finalizeAddon(Napi::Env, AddonOwner *value) { delete value; }

void cleanupAddon(void *value) {
  // Instance-data and TSFN finalizers have no relative ordering. Stop native
  // producers and release their TSFN references before either is finalized.
  static_cast<AddonOwner *>(value)->cleanup();
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  auto value = std::make_unique<AddonOwner>(env);
  if (napi_add_env_cleanup_hook(env, cleanupAddon, value.get()) != napi_ok) {
    throw Napi::Error::New(env, "Failed to register media environment cleanup");
  }
  env.SetInstanceData<AddonOwner, finalizeAddon>(value.release());
  exports.Set("registerPublicEventCallback",
              Napi::Function::New(env, registerPublicEventCallback));
  exports.Set("registerDiagnosticEventCallback",
              Napi::Function::New(env, registerDiagnosticEventCallback));
  exports.Set("handshake", Napi::Function::New(env, handshake));
  exports.Set("installCredentialLease",
              Napi::Function::New(env, installCredentialLease));
  exports.Set("applyDesiredState", Napi::Function::New(env, applyDesiredState));
  exports.Set("querySnapshot", Napi::Function::New(env, querySnapshot));
  exports.Set("ping", Napi::Function::New(env, ping));
  exports.Set("shutdown", Napi::Function::New(env, shutdown));
  return exports;
}

} // namespace

NODE_API_MODULE(windows_media, initialize)
