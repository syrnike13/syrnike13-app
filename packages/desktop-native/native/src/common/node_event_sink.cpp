#include "node_event_sink.hpp"

#include <chrono>
#include <cstdlib>
#include <cstdint>
#include <exception>
#include <memory>
#include <new>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "coalescing_event_lane.hpp"
#include "control_event_lane.hpp"
#include "diagnostic_log.hpp"

namespace syrnike::desktop_native {
namespace {

std::optional<std::string> environmentValue(const char* name) {
  char* value = nullptr;
  std::size_t length = 0;
  if (_dupenv_s(&value, &length, name) != 0 || !value) {
    return std::nullopt;
  }
  std::unique_ptr<char, decltype(&std::free)> owned(value, &std::free);
  return std::string(owned.get());
}

std::size_t controlLaneCapacity() noexcept {
  const auto smoke_mode =
      environmentValue("SYRNIKE_NATIVE_SMOKE_TEST_MODE");
  if (!smoke_mode || *smoke_mode != "1") {
    return ControlEventLane::kCapacity;
  }
  const auto configured =
      environmentValue("SYRNIKE_NATIVE_CONTROL_EVENT_CAPACITY");
  if (!configured) return ControlEventLane::kCapacity;
  char* end = nullptr;
  const auto parsed = std::strtoull(configured->c_str(), &end, 10);
  if (end == configured->c_str() || *end != '\0' ||
      parsed == 0 || parsed > ControlEventLane::kCapacity) {
    return ControlEventLane::kCapacity;
  }
  return static_cast<std::size_t>(parsed);
}

Napi::Number jsNumber(Napi::Env env, std::uint64_t value) {
  return Napi::Number::New(env, static_cast<double>(value));
}

void setIfPresent(Napi::Object& object, const char* key, const std::string& value) {
  if (!value.empty()) object.Set(key, value);
}

Napi::Object errorToObject(Napi::Env env, const NativeError& error) {
  auto result = Napi::Object::New(env);
  result.Set("code", error.code);
  result.Set("message", error.message);
  setIfPresent(result, "stage", error.stage);
  result.Set("retryable", error.retryable);
  setIfPresent(result, "sessionId", error.session_id);
  if (error.generation) {
    result.Set("generation", jsNumber(env, *error.generation));
  }
  if (error.hresult) {
    result.Set("hresult", Napi::Number::New(env, static_cast<double>(*error.hresult)));
  }
  return result;
}

Napi::Array devicesToArray(Napi::Env env, const std::vector<DeviceInfo>& devices) {
  auto result = Napi::Array::New(env, devices.size());
  for (std::size_t index = 0; index < devices.size(); ++index) {
    const auto& device = devices[index];
    auto value = Napi::Object::New(env);
    value.Set("deviceId", device.device_id);
    value.Set("label", device.label);
    value.Set("kind", device.kind);
    value.Set("isDefault", device.is_default);
    result.Set(static_cast<std::uint32_t>(index), value);
  }
  return result;
}

Napi::Array sourcesToArray(Napi::Env env, const std::vector<DisplaySourceInfo>& sources) {
  auto result = Napi::Array::New(env, sources.size());
  for (std::size_t index = 0; index < sources.size(); ++index) {
    const auto& source = sources[index];
    auto value = Napi::Object::New(env);
    value.Set("id", source.id);
    value.Set("name", source.name);
    value.Set("type", source.source_type);
    if (source.thumbnail_data_url) value.Set("thumbnailDataUrl", *source.thumbnail_data_url);
    else value.Set("thumbnailDataUrl", env.Null());
    if (source.app_icon_data_url) value.Set("appIconDataUrl", *source.app_icon_data_url);
    else value.Set("appIconDataUrl", env.Null());
    if (source.native_handle != 0) {
      value.Set("nativeHandle", Napi::BigInt::New(env, source.native_handle));
    }
    if (source.process_id != 0) value.Set("processId", source.process_id);
    if (source.process_path) value.Set("processPath", *source.process_path);
    setIfPresent(value, "classification", source.classification);
    value.Set("audioAvailable", source.audio_available);
    value.Set("audioMode", source.audio_mode);
    result.Set(static_cast<std::uint32_t>(index), value);
  }
  return result;
}

Napi::Object inputToObject(Napi::Env env, const InputEvent& input) {
  auto result = Napi::Object::New(env);
  result.Set("type", input.event_type);
  result.Set("source", input.source);
  result.Set("code", input.code);
  result.Set("label", input.label);
  auto pressed = Napi::Array::New(env, input.pressed_codes.size());
  for (std::size_t index = 0; index < input.pressed_codes.size(); ++index) {
    pressed.Set(static_cast<std::uint32_t>(index), input.pressed_codes[index]);
  }
  result.Set("pressedCodes", pressed);
  return result;
}

Napi::Object foregroundWindowToObject(Napi::Env env, const ForegroundWindow& window) {
  auto result = Napi::Object::New(env);
  result.Set("pid", window.process_id);
  result.Set("processName", window.process_name);
  if (window.process_path) {
    result.Set("processPath", *window.process_path);
  } else {
    result.Set("processPath", env.Null());
  }
  result.Set("title", window.title);
  result.Set("className", window.class_name);
  result.Set("visible", window.visible);
  result.Set("fullscreenLike", window.fullscreen_like);
  auto bounds = Napi::Object::New(env);
  bounds.Set("x", window.bounds.x);
  bounds.Set("y", window.bounds.y);
  bounds.Set("width", window.bounds.width);
  bounds.Set("height", window.bounds.height);
  result.Set("bounds", bounds);
  return result;
}

Napi::Object eventResultToObject(Napi::Env env, const RuntimeEvent& event) {
  auto result = Napi::Object::New(env);
  setIfPresent(result, "sessionId", event.session_id);
  if (!event.session_id.empty()) result.Set("generation", jsNumber(env, event.generation));
  setIfPresent(result, "kind", event.kind);
  setIfPresent(result, "status", event.status);
  setIfPresent(result, "state", event.state);
  setIfPresent(result, "detail", event.detail);
  setIfPresent(result, "nativeParticipantIdentity", event.native_participant_identity);
  setIfPresent(result, "captureMethod", event.capture_method);
  if (!event.devices.empty()) result.Set("devices", devicesToArray(env, event.devices));
  if (!event.sources.empty()) result.Set("sources", sourcesToArray(env, event.sources));
  if (event.type == "activeSpeakers" || !event.participant_identities.empty()) {
    auto participants = Napi::Array::New(env, event.participant_identities.size());
    for (std::size_t index = 0; index < event.participant_identities.size(); ++index) {
      participants.Set(
        static_cast<std::uint32_t>(index),
        event.participant_identities[index]
      );
    }
    result.Set("participantIdentities", participants);
  }
  if (event.width > 0) result.Set("width", event.width);
  if (event.height > 0) result.Set("height", event.height);
  if (event.fps > 0) result.Set("fps", event.fps);
  if (event.bitrate > 0) result.Set("bitrate", event.bitrate);
  return result;
}

Napi::Object sessionToObject(Napi::Env env, const RuntimeEvent& event) {
  auto session = Napi::Object::New(env);
  session.Set("kind", event.kind);
  session.Set("sessionId", event.session_id);
  if (event.kind == "microphone") {
    auto audio = Napi::Object::New(env);
    audio.Set("mode", "microphone");
    audio.Set("sampleRate", 48'000);
    audio.Set("channels", 1);
    audio.Set("noiseSuppression", event.noise_suppression);
    audio.Set("echoCancellation", event.echo_cancellation);
    session.Set("audio", audio);
  } else if (event.kind == "screen") {
    session.Set("encoder", "mf_h264_d3d11");
    session.Set("width", event.width);
    session.Set("height", event.height);
    session.Set("fps", event.fps);
    session.Set("bitrate", event.bitrate);
    auto audio = Napi::Object::New(env);
    audio.Set("mode", event.audio_mode.empty() ? "none" : event.audio_mode);
    if (event.audio_target_process_id != 0) {
      audio.Set("targetProcessId", event.audio_target_process_id);
    }
    setIfPresent(audio, "loopbackMode", event.loopback_mode);
    session.Set("audio", audio);
  }
  setIfPresent(session, "nativeParticipantIdentity", event.native_participant_identity);
  return session;
}

Napi::Object lifecycleStateToObject(Napi::Env env, const RuntimeEvent& event) {
  auto state = Napi::Object::New(env);
  state.Set("status", event.status == "stopped" ? "idle" : event.status);
  state.Set("sessionId", event.session_id);
  setIfPresent(state, "message", event.detail);
  setIfPresent(state, "deviceId", event.device_id);
  if (event.width > 0) state.Set("width", event.width);
  if (event.height > 0) state.Set("height", event.height);
  if (event.fps > 0) state.Set("fps", event.fps);
  if (event.bitrate > 0) state.Set("bitrate", event.bitrate);
  if (!event.audio_mode.empty()) {
    auto audio = Napi::Object::New(env);
    audio.Set("mode", event.audio_mode);
    state.Set("audio", audio);
  }
  return state;
}

Napi::Object statsToObject(Napi::Env env, const RuntimeEvent& event) {
  auto stats = Napi::Object::New(env);
  stats.Set("sessionId", event.session_id);
  auto methods = Napi::Object::New(env);
  methods.Set("wgc_gpu", jsNumber(env, event.method_wgc_gpu));
  methods.Set("dxgi_gpu", jsNumber(env, event.method_dxgi_gpu));
  stats.Set("methods", methods);
  setIfPresent(stats, "activeMethod", event.capture_method);
  stats.Set("videoFrames", jsNumber(env, event.frames));
  stats.Set(
      "videoRecoverableLostCount",
      jsNumber(env, event.video_recoverable_lost_count));
  stats.Set(
      "videoGpuPoolSlotsAvailable",
      jsNumber(env, event.video_gpu_pool_slots_available));
  stats.Set(
      "videoGpuPoolSlotsTotal",
      jsNumber(env, event.video_gpu_pool_slots_total));
  stats.Set(
      "videoDxgiDuplicationHoldUsMax",
      jsNumber(env, event.video_dxgi_duplication_hold_us_max));
  stats.Set("videoSourceUpdates", jsNumber(env, event.video_source_updates));
  stats.Set("videoGpuSubmissions", jsNumber(env, event.video_gpu_submissions));
  stats.Set("videoIdleRefreshes", jsNumber(env, event.video_idle_refreshes));
  stats.Set(
      "videoCoalescedSourceUpdates",
      jsNumber(env, event.video_coalesced_source_updates));
  stats.Set(
      "videoEncoderBackpressureTicks",
      jsNumber(env, event.video_encoder_backpressure_ticks));
  stats.Set(
      "videoSupersededReadyFrames",
      jsNumber(env, event.video_superseded_ready_frames));
  stats.Set(
      "videoGpuCompletionP50Us",
      jsNumber(env, event.video_gpu_completion_p50_us));
  stats.Set(
      "videoGpuCompletionP95Us",
      jsNumber(env, event.video_gpu_completion_p95_us));
  stats.Set(
      "videoGpuCompletionMaxUs",
      jsNumber(env, event.video_gpu_completion_max_us));
  stats.Set("rtpStatsAvailable", event.rtp_stats_available);
  stats.Set("rtpPacketsSent", jsNumber(env, event.rtp_packets_sent));
  stats.Set("rtpBytesSent", jsNumber(env, event.rtp_bytes_sent));
  stats.Set("rtpFramesSent", jsNumber(env, event.rtp_frames_sent));
  stats.Set("rtpFramesEncoded", jsNumber(env, event.rtp_frames_encoded));
  setIfPresent(stats, "encoderImplementation", event.encoder_implementation);
  if (event.audio_frames > 0 || event.audio_packets > 0) {
    stats.Set("audioFrames", jsNumber(env, event.audio_frames));
    stats.Set("audioPackets", jsNumber(env, event.audio_packets));
    stats.Set("audioPeakDb", event.audio_peak_db);
    stats.Set("audioRmsDb", event.audio_rms_db);
  }
  return stats;
}

Napi::Object eventToObject(Napi::Env env, const RuntimeEvent& event) {
  auto result = Napi::Object::New(env);
  result.Set("type", event.type);
  result.Set("sequence", jsNumber(env, event.sequence));
  setIfPresent(result, "requestId", event.request_id);
  setIfPresent(result, "kind", event.kind);
  setIfPresent(result, "trackId", event.track_id);

  if (event.type == "reply") {
    result.Set("ok", event.ok);
    if (event.ok) {
      if (event.kind == "devices") {
        result.Set("result", devicesToArray(env, event.devices));
      } else if (event.kind == "sources") {
        result.Set("result", sourcesToArray(env, event.sources));
      } else if (event.kind == "microphone" || event.kind == "screen") {
        result.Set("result", sessionToObject(env, event));
      } else if (event.kind == "microphoneConfig") {
        auto config = Napi::Object::New(env);
        if (event.revision) config.Set("revision", jsNumber(env, *event.revision));
        setIfPresent(config, "deviceId", event.device_id);
        result.Set("result", config);
      } else if (event.kind == "preview") {
        auto preview = Napi::Object::New(env);
        preview.Set("sessionId", event.session_id);
        result.Set("result", preview);
      }
    } else if (event.error) {
      result.Set("error", errorToObject(env, *event.error));
    }
    return result;
  }

  setIfPresent(result, "sessionId", event.session_id);
  if (!event.session_id.empty()) result.Set("generation", jsNumber(env, event.generation));
  if (event.type == "remoteVideoFrame" || event.type == "localScreenPreviewFrame" ||
      event.type == "localCameraPreviewFrame" ||
      event.type == "remoteScreenPublicationAvailable" ||
      event.type == "remoteScreenPublicationUnavailable") {
    result.Set("participantIdentity", event.participant_identity);
    result.Set("source", event.video_source);
  }
  if (event.type == "remoteVideoFrame" || event.type == "localScreenPreviewFrame" ||
      event.type == "localCameraPreviewFrame") {
    result.Set("frameSequence", jsNumber(env, event.frame_sequence));
    result.Set("timestampUs", jsNumber(env, event.timestamp_us));
    result.Set("width", event.width);
    result.Set("height", event.height);
    const auto handle = event.nt_handle;
    result.Set(
      "ntHandle",
      Napi::Buffer<std::uint8_t>::Copy(
        env,
        reinterpret_cast<const std::uint8_t*>(&handle),
        sizeof(handle)
      )
    );
  }
  if (event.type == "localScreenPreviewTrackRemoved" ||
      event.type == "localCameraPreviewTrackRemoved") {
    result.Set("source", event.video_source);
  }
  if (event.error) result.Set("error", errorToObject(env, *event.error));
  if (event.type == "sessionLifecycle") {
    result.Set("state", lifecycleStateToObject(env, event));
  } else if (event.type == "sessionStarted") {
    result.Set("session", sessionToObject(env, event));
  } else if (event.type == "sessionStopped") {
    setIfPresent(result, "reason", event.reason);
  } else if (event.type == "stats") {
    result.Set("stats", statsToObject(env, event));
  } else if (event.type == "screenBackendRestart") {
    result.Set("backend", event.capture_method);
    result.Set("reason", event.reason);
    result.Set("count", jsNumber(env, event.video_recoverable_lost_count));
  } else if (event.type == "microphoneMetrics") {
    auto metrics = Napi::Object::New(env);
    metrics.Set("revision", static_cast<double>(event.revision.value_or(0)));
    metrics.Set("inputDb", event.input_db);
    metrics.Set("thresholdDb", event.threshold_db);
    metrics.Set("open", event.gate_open);
    result.Set("metrics", metrics);
  } else if (event.type == "microphonePreviewStarted") {
    auto preview = Napi::Object::New(env);
    preview.Set("sessionId", event.session_id);
    result.Set("preview", preview);
  } else if (event.input) {
    result.Set("input", inputToObject(env, *event.input));
  } else if (event.foreground_window) {
    result.Set("window", foregroundWindowToObject(env, *event.foreground_window));
  }
  if (!event.devices.empty()) result.Set("devices", devicesToArray(env, event.devices));
  if (!event.sources.empty()) result.Set("sources", sourcesToArray(env, event.sources));
  if (event.type == "activeSpeakers" || !event.participant_identities.empty()) {
    auto participants = Napi::Array::New(env, event.participant_identities.size());
    for (std::size_t index = 0; index < event.participant_identities.size(); ++index) {
      participants.Set(
        static_cast<std::uint32_t>(index),
        event.participant_identities[index]
      );
    }
    result.Set("participantIdentities", participants);
  }
  if (event.type == "screenCaptureEnded") {
    result.Set("reason", event.reason);
    setIfPresent(result, "message", event.detail);
  }
  return result;
}

void logJsListenerFailure(
  const RuntimeEvent& event,
  const std::string& message
) noexcept {
  try {
    diagnostics::DiagnosticLog::instance().write(
      "native_event_listener_exception",
      {
        {"eventType", event.type},
        {"message", diagnostics::redactForDiagnostics(message)}
      }
    );
  } catch (...) {
  }
}

bool deliverEventToJs(
  Napi::Env env,
  Napi::Function callback,
  RuntimeEvent& event
) {
  if (env == nullptr || callback.IsEmpty()) {
    discardEvent(event);
    return false;
  }
  Napi::Object value;
  try {
    value = eventToObject(env, event);
  } catch (const std::exception& error) {
    discardEvent(event);
    logJsListenerFailure(event, error.what());
    return false;
  } catch (...) {
    discardEvent(event);
    logJsListenerFailure(event, "native event serialization failed");
    return false;
  }
  try {
    callback.Call({value});
  } catch (const Napi::Error& error) {
    if (env.IsExceptionPending()) {
      static_cast<void>(env.GetAndClearPendingException());
    }
    discardEvent(event);
    logJsListenerFailure(event, error.Message());
    return true;
  } catch (const std::exception& error) {
    if (env.IsExceptionPending()) {
      static_cast<void>(env.GetAndClearPendingException());
    }
    discardEvent(event);
    logJsListenerFailure(event, error.what());
    return true;
  } catch (...) {
    if (env.IsExceptionPending()) {
      static_cast<void>(env.GetAndClearPendingException());
    }
    discardEvent(event);
    logJsListenerFailure(event, "unknown JS listener exception");
    return true;
  }
  event.on_drop = {};
  return true;
}

void callEventCallback(
  Napi::Env env,
  Napi::Function callback,
  RuntimeEvent* raw_event
) {
  std::unique_ptr<RuntimeEvent> event(raw_event);
  if (!event) return;
  static_cast<void>(deliverEventToJs(env, callback, *event));
}

void logMediaDrop(const RuntimeEvent& event, std::uint64_t count) noexcept {
  // A stalled renderer can drop continuously. Powers-of-two sampling preserves
  // evidence without moving the flood into the diagnostic log.
  if ((count & (count - 1)) != 0) return;
  try {
    diagnostics::DiagnosticLog::instance().write(
      "native_event_media_dropped",
      {
        {"eventType", event.type},
        {"dropped", count}
      }
    );
  } catch (...) {
    // Diagnostic field construction can allocate. Observability is lossy and
    // must never disturb exact ownership of the accepted replacement frame.
  }
}

void callMediaEventCallback(
  Napi::Env env,
  Napi::Function callback,
  std::shared_ptr<CoalescingEventLane>* raw_lane
) {
  std::unique_ptr<std::shared_ptr<CoalescingEventLane>> lane_holder(raw_lane);
  if (!lane_holder || !*lane_holder) return;
  auto batch = (*lane_holder)->beginCallback();
  if (!batch.active()) return;
  if (!batch.deliver() || env == nullptr || callback.IsEmpty()) {
    discardEventBatch(batch.events());
    return;
  }
  for (auto& event : batch.events()) {
    if (event) static_cast<void>(deliverEventToJs(env, callback, *event));
  }
}

void callControlEventCallback(
  Napi::Env env,
  Napi::Function callback,
  std::shared_ptr<ControlEventLane>* raw_lane
) {
  std::unique_ptr<std::shared_ptr<ControlEventLane>> lane_holder(raw_lane);
  if (!lane_holder || !*lane_holder) return;
  auto events = (*lane_holder)->beginCallback();
  for (auto& event : events) {
    if (event) static_cast<void>(deliverEventToJs(env, callback, *event));
  }
}

}  // namespace

NodeEventSink::NodeEventSink(
  Napi::Env env,
  Napi::Function callback,
  const char* resource_name
) : control_callback_(Napi::ThreadSafeFunction::New(
      env,
      callback,
      resource_name,
      1,
      1
    )),
    media_callback_(Napi::ThreadSafeFunction::New(
      env,
      callback,
      std::string(resource_name) + "-media",
      1,
      1
    )),
    metrics_callback_(Napi::ThreadSafeFunction::New(
      env,
      callback,
      std::string(resource_name) + "-metrics",
      1,
      1
    )),
    control_lane_(std::make_shared<ControlEventLane>(controlLaneCapacity())),
    media_lane_(std::make_shared<CoalescingEventLane>()) {}

NodeEventSink::~NodeEventSink() {
  try {
    close();
  } catch (...) {
  }
}

bool NodeEventSink::emit(RuntimeEvent event) {
  // close() first marks the control lane closed to wake a bounded producer,
  // then takes this mutex before discarding accepted events or releasing the
  // TSFNs. This keeps release ownership and the TSFN handles valid until emit
  // reports whether it consumed the event.
  std::lock_guard lifecycle_lock(lifecycle_mutex_);
  if (closed_.load(std::memory_order_acquire)) {
    if (eventLane(event) == EventLane::control) return false;
    discardEvent(event);
    return true;
  }
  const auto lane = eventLane(event);
  if (lane == EventLane::control) {
    const auto event_sequence = event.sequence;
    ControlEventLane::PushResult pushed;
    try {
      pushed = control_lane_->push(std::move(event));
    } catch (const std::exception& error) {
      logJsListenerFailure(event, error.what());
      return false;
    } catch (...) {
      logJsListenerFailure(event, "control event staging failed");
      return false;
    }
    if (!pushed.accepted) {
      // EventSink::emit(false) leaves release ownership with SequencedEmitter's
      // fallback guard. Clear the lane's moved copy so it cannot release the
      // same native handle a second time while being destroyed.
      if (pushed.rejected) pushed.rejected->on_drop = {};
      try {
        diagnostics::DiagnosticLog::instance().write(
          pushed.timed_out
            ? "native_event_control_backpressure_timeout"
            : "native_event_control_rejected",
          {{"queueDepth", static_cast<std::uint64_t>(control_lane_->size())}}
        );
      } catch (...) {
      }
      return false;
    }
    if (!pushed.schedule_callback) return true;
    auto* lane_payload = new (std::nothrow)
      std::shared_ptr<ControlEventLane>(control_lane_);
    if (!lane_payload) {
      control_lane_->rejectScheduledCallbackAndDiscard(event_sequence);
      try {
        diagnostics::DiagnosticLog::instance().write(
          "native_event_control_schedule_allocation_failed"
        );
      } catch (...) {
      }
      return false;
    }
    napi_status status = napi_generic_failure;
    try {
      status = control_callback_.NonBlockingCall(
        lane_payload,
        callControlEventCallback
      );
    } catch (...) {
      status = napi_generic_failure;
    }
    if (status == napi_ok) return true;
    delete lane_payload;
    control_lane_->rejectScheduledCallbackAndDiscard(event_sequence);
    try {
      diagnostics::DiagnosticLog::instance().write(
        "native_event_control_schedule_failed",
        {
          {"napiStatus", static_cast<std::int64_t>(status)},
          {"queueFull", status == napi_queue_full}
        }
      );
      // Telemetry: TSFN backpressure indicates JS thread starvation
      if (status == napi_queue_full) {
        diagnostics::DiagnosticLog::instance().write(
          "tsfn_backpressure",
          {{"lane", "control"}, {"capacity", static_cast<std::uint64_t>(512)}}
        );
      }
    } catch (...) {
    }
    return false;
  }
  if (lane == EventLane::media) {
    CoalescingEventLane::PushResult pushed;
    try {
      pushed = media_lane_->push(std::move(event));
    } catch (...) {
      // The lane guard has already released a retained media handle. Media is
      // lossy, so allocation pressure must not surface as an actor failure.
      return true;
    }
    if (pushed.discarded) {
      discardEvent(*pushed.discarded);
      logMediaDrop(*pushed.discarded, pushed.dropped_count);
    }
    if (!pushed.accepted || !pushed.schedule_callback) return true;
    std::shared_ptr<CoalescingEventLane>* lane_payload = nullptr;
    napi_status status = napi_generic_failure;
    try {
      lane_payload = new std::shared_ptr<CoalescingEventLane>(media_lane_);
      status = media_callback_.NonBlockingCall(
        lane_payload, callMediaEventCallback
      );
    } catch (...) {
      status = napi_generic_failure;
    }
    if (status == napi_ok) return true;
    delete lane_payload;
    media_lane_->cancelScheduledCallbackAndDiscard();
    return true;
  }
  RuntimeEventResourceGuard resource(event);
  try {
    resource.attach(event);
  } catch (...) {
    if (lane == EventLane::control) {
      resource.transfer();
      return false;
    }
    resource.discard();
    return true;
  }
  RuntimeEvent* payload = nullptr;
  try {
    payload = new RuntimeEvent(std::move(event));
  } catch (...) {
    if (lane == EventLane::control) {
      resource.transfer();
      return false;
    }
    resource.discard();
    return true;
  }
  resource.transfer();
  napi_status status = napi_ok;
  try {
    switch (lane) {
      case EventLane::control:
        status = control_callback_.NonBlockingCall(payload, callEventCallback);
        break;
      case EventLane::media:
        status = napi_generic_failure;
        break;
      case EventLane::telemetry:
        status = metrics_callback_.NonBlockingCall(payload, callEventCallback);
        break;
    }
  } catch (...) {
    status = napi_generic_failure;
  }
  if (status == napi_ok) return true;
  if (lane == EventLane::control) {
    // false means the sink did not consume resource ownership; the emitter's
    // fallback remains responsible for it.
    payload->on_drop = {};
  } else {
    discardEvent(*payload);
  }
  delete payload;
  if (lane == EventLane::telemetry) return true;
  return false;
}

void NodeEventSink::close() {
  if (closed_.exchange(true, std::memory_order_acq_rel)) return;
  control_lane_->requestClose();
  std::lock_guard lifecycle_lock(lifecycle_mutex_);
  control_lane_->closeAndDiscard();
  media_lane_->closeAndDiscard();
  if (!media_lane_->waitForInFlightCallbacks(std::chrono::seconds(5))) {
    try {
      diagnostics::DiagnosticLog::instance().write(
        "native_event_media_callback_shutdown_timeout"
      );
    } catch (...) {
    }
  }
  try { metrics_callback_.Release(); } catch (...) {}
  try { media_callback_.Release(); } catch (...) {}
  try { control_callback_.Release(); } catch (...) {}
}

}  // namespace syrnike::desktop_native
