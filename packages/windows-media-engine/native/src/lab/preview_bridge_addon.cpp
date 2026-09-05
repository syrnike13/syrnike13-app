#include <napi.h>
#include <cmath>
#include "lab/screen_cpu_lab.hpp"
#include "livekit/livekit_room_transport.hpp"
#include "screen/local_screen_preview.hpp"

namespace {
using namespace syrnike::windows_media;
using namespace std::chrono_literals;
using screen::LocalScreenPreview;
struct ConnectionObserver final : LiveKitRoomObserver {
  std::atomic_uint64_t reconnects{0};
  void stop() override {}
  void onConnectionStateChanged(livekit::Room&, const livekit::ConnectionStateChangedEvent& event) override {
    if (event.state == livekit::ConnectionState::Reconnecting) ++reconnects;
  }
};
struct Owner {
  std::shared_ptr<lab::PreviewLabControl> control = std::make_shared<lab::PreviewLabControl>();
  std::shared_ptr<ConnectionObserver> observer = std::make_shared<ConnectionObserver>();
  std::shared_ptr<LiveKitRoomTransport> transport;
  std::unique_ptr<RoomOwner> room;
  std::thread worker;
  ~Owner() {
    control->stop = true;
    if (worker.joinable()) worker.join();
    LocalScreenPreview::processPreview().stopPublication();
    room.reset(); transport.reset();
  }
};
std::uint64_t integer(const Napi::Value& value) {
  if (!value.IsNumber()) throw Napi::TypeError::New(value.Env(), "Expected integer");
  const auto n = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(n) || n < 0 || n > 9007199254740991.0 || std::floor(n) != n)
    throw Napi::TypeError::New(value.Env(), "Invalid integer");
  return static_cast<std::uint64_t>(n);
}
Napi::Value start(const Napi::CallbackInfo& info) {
  auto* owner = info.Env().GetInstanceData<Owner>();
  if (owner->room) throw Napi::Error::New(info.Env(), "Publisher already started");
  std::array<std::string, 4> args;
  for (std::size_t i = 0; i < args.size(); ++i) {
    if (!info[i].IsString()) throw Napi::TypeError::New(info.Env(), "Invalid publisher configuration");
    args[i] = info[i].As<Napi::String>().Utf8Value();
    if (args[i].empty() || args[i].size() > 8192)
      throw Napi::TypeError::New(info.Env(), "Invalid publisher configuration");
  }
  owner->transport = std::make_shared<LiveKitRoomTransport>(owner->observer);
  owner->room = std::make_unique<RoomOwner>(owner->transport, [](const RoomConnectionEvent&) {});
  const auto started = owner->room->beginConnect({args[0], args[1], args[2], "publisher"});
  if (!started.ok) throw Napi::Error::New(info.Env(), "Publisher Room connect rejected");
  owner->worker = std::thread([control = owner->control, transport = owner->transport, scenario = args[3]] {
    const auto deadline = std::chrono::steady_clock::now() + 15s;
    while (!control->stop && !transport->activeRoom() && std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(5ms);
    if (control->stop) return;
    if (!transport->activeRoom()) {
      std::lock_guard lock(control->mutex);
      control->failure = "Publisher Room deadline"; control->done = true; return;
    }
    lab::runScreenPreviewLab(transport, control, scenario);
  });
  return info.Env().Undefined();
}
Napi::Value take(const Napi::CallbackInfo& info) {
  const auto lease = LocalScreenPreview::processPreview().takeFrame();
  if (!lease) return info.Env().Null();
  auto value = Napi::Object::New(info.Env());
  const auto number = [&](const char* key, auto n) {
    value.Set(key, Napi::Number::New(info.Env(), static_cast<double>(n)));
  };
  number("version", 1); value.Set("kind", "local-preview");
  number("generation", lease->generation); number("revision", lease->revision);
  number("sequence", lease->sequence); number("slot", lease->slot);
  number("publicationGeneration", lease->publication_generation);
  number("sourceGeneration", lease->source_generation);
  number("width", lease->width); number("height", lease->height);
  number("timestamp", lease->timestamp_us); number("handle", lease->handle);
  return value;
}
Napi::Value snapshot(const Napi::CallbackInfo& info) {
  auto* owner = info.Env().GetInstanceData<Owner>();
  auto value = Napi::Object::New(info.Env());
  const auto preview = LocalScreenPreview::processPreview().stats();
  const auto number = [&](const char* key, auto n) {
    value.Set(key, Napi::Number::New(info.Env(), static_cast<double>(n)));
  };
  value.Set("state", screen::previewStateName(preview.state));
  value.Set("desired", preview.desired); value.Set("publicationActive", preview.publication_active);
  number("generation", preview.generation); number("revision", preview.revision);
  number("accepted", preview.accepted); number("delivered", preview.delivered);
  number("released", preview.released); number("poolDrops", preview.pool_drops);
  number("pressureDrops", preview.pressure_drops); number("superseded", preview.superseded);
  number("invalidReleases", preview.invalid_releases); number("previewFailures", preview.failures);
  number("backingBytes", preview.backing_bytes); number("offerMaxUs", preview.offer_max_us);
  number("gpuMaxUs", preview.gpu_max_us); number("outstanding", preview.outstanding);
  number("pending", preview.pending); number("quarantined", preview.quarantined);
  number("processBudget", preview.process_budget);
  number("lastGpuResult", preview.last_gpu_result); number("failureAgeUs", preview.failure_age_us);
  number("sdkReconnects", owner->observer->reconnects.load());
  const auto room = owner->transport ? owner->transport->activeRoom() : nullptr;
  value.Set("sdkConnected", room && room->connectionState() == livekit::ConnectionState::Connected);
  std::lock_guard lock(owner->control->mutex);
  const auto& stats = owner->control->stats;
  value.Set("networkAvailable", stats.network.available_outgoing_bitrate.has_value());
  number("networkAvailableOutgoingBitrate", stats.network.available_outgoing_bitrate.value_or(0));
  number("networkMeasuredAtMs", stats.network.measured_at_ms);
  value.Set("adaptiveEnabled", stats.adaptive_enabled);
  number("adaptiveProfile", stats.current_profile);
  number("profileChanges", stats.profile_changes);
  number("profileGeneration", stats.profile_generation);
  value.Set("done", owner->control->done); value.Set("failure", owner->control->failure);
  number("publicationConsumed", stats.total_publication_consumed);
  number("publicationFailures", stats.sender.terminal_failures);
  number("publicationDepth", stats.sender.video_depth);
  number("encoderFrames", stats.encoder.encoded); number("encoderStalls", stats.encoder.output_stalls);
  number("captureAgeUs", stats.capture_age_last_us);
  number("publicationBytes", stats.memory.total_bytes);
  number("captureActive", stats.capture.active); number("capturePending", stats.capture.pending);
  number("conversionSlots", stats.converter.slots_in_use);
  number("encoderInputSlots", stats.encoder.input_slots_in_use);
  number("encoderOutputSlots", stats.encoder.output_slots_in_use);
  return value;
}
Napi::Object init(Napi::Env env, Napi::Object exports) {
  env.SetInstanceData(new Owner());
  exports.Set("start", Napi::Function::New(env, start));
  exports.Set("take", Napi::Function::New(env, take));
  exports.Set("snapshot", Napi::Function::New(env, snapshot));
  exports.Set("stop", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    info.Env().GetInstanceData<Owner>()->control->stop = true;
    return info.Env().Undefined();
  }));
  exports.Set("demand", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    if (!info[1].IsBoolean()) throw Napi::TypeError::New(info.Env(), "Invalid demand");
    return Napi::Boolean::New(info.Env(), LocalScreenPreview::processPreview().demand(
        integer(info[0]), info[1].As<Napi::Boolean>().Value()));
  }));
  exports.Set("budget", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), LocalScreenPreview::processPreview().setProcessBudget(integer(info[0])));
  }));
  exports.Set("release", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    const auto slot = integer(info[2]);
    return Napi::Boolean::New(info.Env(), slot < LocalScreenPreview::kSlots &&
        LocalScreenPreview::processPreview().release(integer(info[0]), integer(info[1]), static_cast<std::uint32_t>(slot)));
  }));
  return exports;
}
NODE_API_MODULE(preview_bridge_lab, init)
}
