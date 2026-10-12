#include "node_event_sink.hpp"

#include <memory>
#include <utility>

namespace syrnike::desktop_native {
namespace {

Napi::Object errorToObject(Napi::Env env, const NativeError& error) {
  auto result = Napi::Object::New(env);
  result.Set("code", error.code);
  result.Set("message", error.message);
  if (!error.stage.empty()) result.Set("stage", error.stage);
  result.Set("retryable", error.retryable);
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

Napi::Object foregroundWindowToObject(
  Napi::Env env,
  const ForegroundWindow& window
) {
  auto result = Napi::Object::New(env);
  result.Set("pid", window.process_id);
  result.Set("processName", window.process_name);
  if (window.process_path) result.Set("processPath", *window.process_path);
  else result.Set("processPath", env.Null());
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

Napi::Object eventToObject(Napi::Env env, const RuntimeEvent& event) {
  auto result = Napi::Object::New(env);
  switch (event.type) {
    case NativeEventType::Reply:
      result.Set("type", "reply");
      result.Set("requestId", event.request_id);
      result.Set("ok", event.ok);
      if (event.error) result.Set("error", errorToObject(env, *event.error));
      break;
    case NativeEventType::RuntimeError:
      result.Set("type", "runtimeError");
      result.Set("sequence", static_cast<double>(event.sequence));
      if (event.error) result.Set("error", errorToObject(env, *event.error));
      break;
    case NativeEventType::Input:
      result.Set("type", "input");
      result.Set("sequence", static_cast<double>(event.sequence));
      if (event.input) result.Set("input", inputToObject(env, *event.input));
      break;
    case NativeEventType::ForegroundWindow:
      result.Set("type", "foregroundWindow");
      result.Set("sequence", static_cast<double>(event.sequence));
      if (event.foreground_window) {
        result.Set(
          "window",
          foregroundWindowToObject(env, *event.foreground_window)
        );
      } else {
        result.Set("window", env.Null());
      }
      break;
  }
  return result;
}

void deliver(
  Napi::Env env,
  Napi::Function callback,
  RuntimeEvent* raw_event
) {
  std::unique_ptr<RuntimeEvent> event(raw_event);
  try {
    callback.Call({eventToObject(env, *event)});
    event->on_drop = {};
  } catch (...) {
    discardEvent(*event);
  }
}

}  // namespace

NodeEventSink::NodeEventSink(
  Napi::Env env,
  Napi::Function callback,
  const char* resource_name
) {
  control_callback_ = Napi::ThreadSafeFunction::New(
    env,
    callback,
    Napi::String::New(env, resource_name),
    256,
    1
  );
  realtime_callback_ = Napi::ThreadSafeFunction::New(
    env,
    callback,
    Napi::String::New(env, resource_name),
    1024,
    1
  );
}

NodeEventSink::~NodeEventSink() { close(); }

bool NodeEventSink::emit(RuntimeEvent event) {
  std::lock_guard lock(lifecycle_mutex_);
  if (closed_.load()) {
    discardEvent(event);
    return false;
  }
  auto* payload = new (std::nothrow) RuntimeEvent(std::move(event));
  if (!payload) return false;
  auto& callback = eventLane(*payload) == EventLane::realtime
    ? realtime_callback_
    : control_callback_;
  const auto status = callback.NonBlockingCall(payload, deliver);
  if (status == napi_ok) return true;
  discardEvent(*payload);
  delete payload;
  return false;
}

void NodeEventSink::close() {
  std::lock_guard lock(lifecycle_mutex_);
  if (closed_.exchange(true)) return;
  control_callback_.Release();
  realtime_callback_.Release();
}

}  // namespace syrnike::desktop_native
