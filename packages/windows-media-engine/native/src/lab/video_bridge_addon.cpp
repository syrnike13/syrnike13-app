#include <napi.h>
#include <windows.h>

#include <cmath>
#include <vector>

#include "livekit/livekit_room_transport.hpp"
#include "video/remote_video_track.hpp"
#include "video/shared_texture_pool.hpp"

namespace syrnike::windows_media::video {
class RemoteVideoFaultInjector {
 public:
  static bool injectOldFrame(RemoteVideoTrack& owner) {
    livekit::VideoFrameEvent event;
    event.frame =
        livekit::VideoFrame::create(640, 360, livekit::VideoBufferType::BGRA);
    event.timestamp_us = 1;
    return owner.acceptDecoded(owner.revision_.load() - 1, std::move(event));
  }
};
}  // namespace syrnike::windows_media::video

namespace {
using syrnike::windows_media::video::SharedTexturePool;
std::shared_ptr<syrnike::windows_media::video::RemoteVideoTrack> remote;
std::shared_ptr<syrnike::windows_media::LiveKitRoomTransport> transport;
std::unique_ptr<syrnike::windows_media::RoomOwner> room;
Napi::Value leaseObject(
    Napi::Env env, const syrnike::windows_media::video::TextureLease& lease) {
  auto result = Napi::Object::New(env);
  result.Set("version", 1);
  result.Set("generation",
             Napi::Number::New(env, static_cast<double>(lease.generation)));
  result.Set("sequence",
             Napi::Number::New(env, static_cast<double>(lease.sequence)));
  result.Set("slot", lease.slot);
  result.Set("width", lease.width);
  result.Set("height", lease.height);
  result.Set("timestamp",
             Napi::Number::New(env, static_cast<double>(lease.timestamp_us)));
  result.Set("ingressUs",
             Napi::Number::New(env, static_cast<double>(lease.ingress_us)));
  result.Set("publicationId",
             lease.publication_id.empty() ? "fixture" : lease.publication_id);
  result.Set("participantIdentity", lease.participant_identity.empty()
                                        ? "fixture"
                                        : lease.participant_identity);
  result.Set("handle",
             Napi::Number::New(env, static_cast<double>(lease.handle)));
  return result;
}
std::uint64_t integer(const Napi::Value& value) {
  if (!value.IsNumber())
    throw Napi::TypeError::New(value.Env(), "Expected integer");
  const auto number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number < 0 || number > 9007199254740991.0 ||
      std::floor(number) != number)
    throw Napi::TypeError::New(value.Env(), "Invalid integer");
  return static_cast<std::uint64_t>(number);
}
Napi::Value begin(const Napi::CallbackInfo& info) {
  static std::uint64_t pattern_generation = 0;
  auto& pool = SharedTexturePool::processPool();
  pool.retire(pattern_generation);
  pattern_generation = pool.beginGeneration();
  return Napi::Number::New(info.Env(), static_cast<double>(pattern_generation));
}
Napi::Value pattern(const Napi::CallbackInfo& info) {
  try {
    const auto generation = integer(info[0]);
    const auto frame = integer(info[1]);
    const auto width_value = integer(info[2]);
    const auto height_value = integer(info[3]);
    if (width_value == 0 || width_value > 3840 || height_value == 0 ||
        height_value > 2160)
      throw Napi::TypeError::New(info.Env(), "Invalid dimensions");
    const auto width = static_cast<std::uint32_t>(width_value);
    const auto height = static_cast<std::uint32_t>(height_value);
    std::vector<std::uint8_t> pixels(std::size_t{width} * height * 4);
    for (std::size_t offset = 0; offset < pixels.size(); offset += 4) {
      pixels[offset] = static_cast<std::uint8_t>(frame % 255);
      pixels[offset + 1] = 128;
      pixels[offset + 2] = 32;
      pixels[offset + 3] = 255;
    }
    const auto lease = SharedTexturePool::processPool().upload(
        generation, width, height, static_cast<std::int64_t>(frame * 16667),
        pixels);
    if (!lease) return info.Env().Null();
    return leaseObject(info.Env(), *lease);
  } catch (const std::exception& error) {
    Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
}
Napi::Value release(const Napi::CallbackInfo& info) {
  const auto slot = integer(info[2]);
  if (slot >= SharedTexturePool::kSlots)
    return Napi::Boolean::New(info.Env(), false);
  return Napi::Boolean::New(info.Env(),
                            SharedTexturePool::processPool().release(
                                integer(info[0]), integer(info[1]),
                                static_cast<std::uint32_t>(slot)));
}
Napi::Value snapshot(const Napi::CallbackInfo& info) {
  const auto state = SharedTexturePool::processPool().snapshot();
  auto result = Napi::Object::New(info.Env());
  result.Set(
      "generation",
      Napi::Number::New(info.Env(), static_cast<double>(state.generation)));
  result.Set(
      "backingBytes",
      Napi::Number::New(info.Env(), static_cast<double>(state.backing_bytes)));
  result.Set("accepted", Napi::Number::New(
                             info.Env(), static_cast<double>(state.accepted)));
  result.Set("dropped",
             Napi::Number::New(info.Env(), static_cast<double>(state.dropped)));
  result.Set("released", Napi::Number::New(
                             info.Env(), static_cast<double>(state.released)));
  result.Set("invalidReleases",
             Napi::Number::New(info.Env(),
                               static_cast<double>(state.invalid_releases)));
  result.Set("delivered", state.delivered);
  result.Set("retired", state.retired);
  result.Set("quarantined", state.quarantined);
  result.Set("retiredGenerations", state.retired_generations);
  result.Set("oldestAgeMs", state.oldest_age_ms);
  result.Set("releaseP50Ms", state.release_p50_ms);
  result.Set("releaseP95Ms", state.release_p95_ms);
  result.Set("releaseMaxMs", state.release_max_ms);
  result.Set("stalledMs", state.stalled_ms);
  result.Set(
      "decoded",
      Napi::Number::New(info.Env(),
                        remote ? static_cast<double>(remote->decoded()) : 0));
  result.Set("failed", remote && remote->failed());
  result.Set("room", room ? syrnike::windows_media::roomConnectionStateName(
                                room->state())
                          : "absent");
  return result;
}
Napi::Value startRemote(const Napi::CallbackInfo& info) {
  if (room) throw Napi::Error::New(info.Env(), "Remote Room already started");
  std::vector<std::string> args;
  for (std::size_t i = 0; i < 6; ++i) {
    if (!info[i].IsString())
      throw Napi::TypeError::New(info.Env(), "Expected remote configuration");
    auto value = info[i].As<Napi::String>().Utf8Value();
    if (value.empty() || value.size() > 8192)
      throw Napi::TypeError::New(info.Env(), "Invalid remote configuration");
    args.push_back(std::move(value));
  }
  remote = std::make_shared<syrnike::windows_media::video::RemoteVideoTrack>(
      args[4], args[5]);
  transport =
      std::make_shared<syrnike::windows_media::LiveKitRoomTransport>(remote);
  const std::weak_ptr<syrnike::windows_media::video::RemoteVideoTrack>
      observer = remote;
  room = std::make_unique<syrnike::windows_media::RoomOwner>(
      transport,
      [observer](const syrnike::windows_media::RoomConnectionEvent& event) {
        if (const auto owner = observer.lock())
          owner->demand(event.state ==
                        syrnike::windows_media::RoomConnectionState::Connected);
      });
  const auto result = room->beginConnect({args[0], args[1], args[2], args[3]});
  if (!result.ok)
    throw Napi::Error::New(info.Env(), "Remote Room connect rejected");
  return info.Env().Undefined();
}
Napi::Value takeRemote(const Napi::CallbackInfo& info) {
  if (!remote) return info.Env().Null();
  const auto lease = remote->takeFrame();
  return lease ? leaseObject(info.Env(), *lease) : info.Env().Null();
}
Napi::Value demandRemote(const Napi::CallbackInfo& info) {
  if (!remote || !info[0].IsBoolean())
    throw Napi::TypeError::New(info.Env(), "Invalid remote demand");
  remote->demand(info[0].As<Napi::Boolean>().Value());
  return info.Env().Undefined();
}
// Main-only handle broker. It does not create or own a D3D device.
Napi::Value duplicate(const Napi::CallbackInfo& info) {
  const auto pid = integer(info[0]);
  if (pid > MAXDWORD) throw Napi::TypeError::New(info.Env(), "Invalid process");
  const auto process =
      OpenProcess(PROCESS_DUP_HANDLE, FALSE, static_cast<DWORD>(pid));
  HANDLE target = nullptr;
  const auto succeeded =
      process &&
      DuplicateHandle(process, reinterpret_cast<HANDLE>(integer(info[1])),
                      GetCurrentProcess(), &target, 0, FALSE,
                      DUPLICATE_SAME_ACCESS);
  if (process) CloseHandle(process);
  if (!succeeded)
    throw Napi::Error::New(info.Env(), "Texture handle duplication failed");
  return Napi::Buffer<std::uint8_t>::Copy(
      info.Env(), reinterpret_cast<const std::uint8_t*>(&target),
      sizeof(target));
}
Napi::Value closeHandle(const Napi::CallbackInfo& info) {
  if (!info[0].IsBuffer())
    throw Napi::TypeError::New(info.Env(), "Invalid handle");
  const auto buffer = info[0].As<Napi::Buffer<std::uint8_t>>();
  if (buffer.Length() != sizeof(HANDLE))
    throw Napi::TypeError::New(info.Env(), "Invalid handle size");
  HANDLE handle = nullptr;
  memcpy(&handle, buffer.Data(), sizeof(handle));
  if (handle) CloseHandle(handle);
  memset(buffer.Data(), 0, buffer.Length());
  return info.Env().Undefined();
}
Napi::Object init(Napi::Env env, Napi::Object exports) {
  env.AddCleanupHook([] {
    if (remote) remote->stop();
    room.reset();
    transport.reset();
    remote.reset();
  });
  exports.Set("begin", Napi::Function::New(env, begin));
  exports.Set(
      "generation",
      Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
        return Napi::Number::New(
            info.Env(),
            static_cast<double>(
                remote ? remote->generation()
                       : SharedTexturePool::processPool().generation()));
      }));
  exports.Set("nowMicros",
              Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
                return Napi::Number::New(
                    info.Env(),
                    static_cast<double>(
                        std::chrono::duration_cast<std::chrono::microseconds>(
                            std::chrono::steady_clock::now().time_since_epoch())
                            .count()));
              }));
  exports.Set("startRemote", Napi::Function::New(env, startRemote));
  exports.Set("takeRemote", Napi::Function::New(env, takeRemote));
  exports.Set("injectLateFrame",
              Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
                return Napi::Boolean::New(
                    info.Env(),
                    remote &&
                        syrnike::windows_media::video::
                            RemoteVideoFaultInjector::injectOldFrame(*remote));
              }));
  exports.Set("demandRemote", Napi::Function::New(env, demandRemote));
  exports.Set("pattern", Napi::Function::New(env, pattern));
  exports.Set("release", Napi::Function::New(env, release));
  exports.Set("snapshot", Napi::Function::New(env, snapshot));
  exports.Set("duplicate", Napi::Function::New(env, duplicate));
  exports.Set("closeHandle", Napi::Function::New(env, closeHandle));
  return exports;
}
NODE_API_MODULE(video_bridge_lab, init)
}  // namespace
