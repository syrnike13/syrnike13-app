#include <chrono>
#include <atomic>
#include <condition_variable>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "common/event_sink.hpp"
#include "media/livekit_voice_session.hpp"
#include "media/media_runtime.hpp"

namespace {

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    {
      std::lock_guard lock(mutex_);
      events_.push_back(std::move(event));
    }
    changed_.notify_all();
    return true;
  }

  void close() override {}

  bool waitReply(
    const std::string& request_id,
    std::chrono::milliseconds timeout = std::chrono::seconds(5)
  ) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return true;
      }
      return false;
    });
  }

  bool hasReply(const std::string& request_id) {
    std::lock_guard lock(mutex_);
    for (const auto& event : events_) {
      if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return true;
    }
    return false;
  }

  std::optional<syrnike::desktop_native::RuntimeEvent> reply(
      const std::string& request_id) {
    std::lock_guard lock(mutex_);
    for (const auto& event : events_) {
      if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return event;
    }
    return std::nullopt;
  }

  bool waitTrackFailure(
    const std::string& track_id,
    std::chrono::milliseconds timeout = std::chrono::seconds(2)
  ) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == syrnike::desktop_native::NativeEventType::RuntimeError && event.track_id == track_id &&
            event.status.empty() && event.kind.empty() && event.error &&
            event.error->code == "audio_output_direct_sink_attach_failed") {
          return true;
        }
      }
      return false;
    });
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  using syrnike::desktop_native::MediaCommand;
  using syrnike::desktop_native::media::DeterministicFakeLiveKitVoiceSession;
  using syrnike::desktop_native::media::MediaRuntime;

  auto sink = std::make_shared<CollectingSink>();
  auto livekit = std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  livekit->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Connect, true);

  std::mutex slow_microphone_mutex;
  std::condition_variable slow_microphone_changed;
  bool slow_microphone_started = false;
  bool release_slow_microphone = false;
  MediaRuntime runtime(
    sink,
    livekit,
    {},
    [&](const MediaCommand& command) {
      if (command.type != syrnike::desktop_native::NativeCommandType::ConfigureMicrophone) return;
      std::unique_lock lock(slow_microphone_mutex);
      slow_microphone_started = true;
      slow_microphone_changed.notify_all();
      slow_microphone_changed.wait_for(
        lock,
        std::chrono::seconds(5),
        [&] { return release_slow_microphone; }
      );
    }
  );

  MediaCommand configure;
  configure.type = syrnike::desktop_native::NativeCommandType::ConfigureMicrophone;
  configure.request_id = "slow-microphone-configure";
  configure.revision = 1;
  configure.has_revision = true;
  require(runtime.dispatch(configure), "media runtime rejected microphone configure");
  {
    std::unique_lock lock(slow_microphone_mutex);
    require(
      slow_microphone_changed.wait_for(
        lock,
        std::chrono::seconds(1),
        [&] { return slow_microphone_started; }
      ),
      "slow microphone operation did not reach its worker"
    );
  }

  MediaCommand microphone_probe;
  microphone_probe.type = syrnike::desktop_native::NativeCommandType::ProbeMicrophoneActor;
  microphone_probe.request_id = "probe-microphone";
  const auto microphone_probe_started = std::chrono::steady_clock::now();
  require(runtime.dispatch(microphone_probe), "media runtime rejected microphone probe");
  require(
    sink->waitReply("probe-microphone", std::chrono::milliseconds(500)),
    "microphone probe waited behind the slow microphone operation"
  );
  require(
    std::chrono::steady_clock::now() - microphone_probe_started <
      std::chrono::milliseconds(500),
    "microphone probe exceeded its independent routing deadline"
  );
  require(
    !sink->hasReply("slow-microphone-configure"),
    "slow microphone operation completed before its device delay was released"
  );
  {
    std::lock_guard lock(slow_microphone_mutex);
    release_slow_microphone = true;
  }
  slow_microphone_changed.notify_all();
  require(
    sink->waitReply("slow-microphone-configure", std::chrono::seconds(1)),
    "microphone configure did not complete after the slow device was released"
  );

  MediaCommand connect;
  connect.type = syrnike::desktop_native::NativeCommandType::ConnectVoice;
  connect.request_id = "voice-connect";
  connect.session_id = "voice-session";
  connect.generation = 1;
  connect.livekit_url = "wss://livekit.example";
  connect.livekit_token = "token";
  require(runtime.dispatch(connect), "media runtime rejected voice connect");

  livekit->waitUntilPending(
    DeterministicFakeLiveKitVoiceSession::Operation::Connect,
    1
  );

  MediaCommand screen_probe;
  screen_probe.type = syrnike::desktop_native::NativeCommandType::ProbeScreenActor;
  screen_probe.request_id = "probe-screen";
  require(runtime.dispatch(screen_probe), "media runtime rejected screen probe");

  MediaCommand query_probe;
  query_probe.type = syrnike::desktop_native::NativeCommandType::ProbeQueryWorker;
  query_probe.request_id = "probe-query";
  require(runtime.dispatch(query_probe), "media runtime rejected query probe");

  require(
    sink->waitReply("probe-query", std::chrono::milliseconds(500)),
    "query probe did not reply independently"
  );
  require(
    sink->waitReply("probe-screen", std::chrono::milliseconds(500)),
    "screen probe did not reply while screen connect was blocked"
  );

  require(
    !sink->hasReply("voice-connect"),
    "voice connect completed before the blocked connect was released"
  );

  livekit->releaseNext(
    DeterministicFakeLiveKitVoiceSession::Operation::Connect
  );

  require(
    sink->waitReply("voice-connect", std::chrono::seconds(2)),
    "voice connect did not complete after connect released"
  );

  livekit->setBlocked(
    DeterministicFakeLiveKitVoiceSession::Operation::Publish,
    true
  );
  auto blocked_publication = std::async(std::launch::async, [&] {
    const auto owner_call =
      syrnike::desktop_native::media::requireSessionPortValue(
        livekit->bindCurrentOwner("voice-session", 1)
      );
    return livekit->publication().publishVideoTrack(
      owner_call,
      {},
      ::livekit::TrackPublishOptions{}
    );
  });
  livekit->waitUntilPending(
    DeterministicFakeLiveKitVoiceSession::Operation::Publish,
    1
  );

  MediaCommand renderer_release;
  renderer_release.type = syrnike::desktop_native::NativeCommandType::ReleaseRemoteVideoFrame;
  renderer_release.request_id = "voice-control-release";
  renderer_release.session_id = "voice-session";
  renderer_release.generation = 1;
  renderer_release.track_id = "remote-camera";
  renderer_release.frame_sequence = 91;
  renderer_release.diagnostic_host_epoch = 7;
  require(
    runtime.dispatch(renderer_release),
    "media runtime rejected renderer release during blocked publication"
  );

  MediaCommand voice_control_probe;
  voice_control_probe.type = syrnike::desktop_native::NativeCommandType::ProbeVoiceControl;
  voice_control_probe.request_id = "probe-voice-control";
  voice_control_probe.diagnostic_host_epoch = 7;
  const auto voice_probe_started = std::chrono::steady_clock::now();
  require(
    runtime.dispatch(voice_control_probe),
    "media runtime rejected voice-control probe"
  );
  require(
    sink->waitReply("probe-voice-control", std::chrono::milliseconds(500)),
    "voice-control probe waited behind blocked publication"
  );
  require(
    sink->waitReply("voice-control-release", std::chrono::milliseconds(500)),
    "renderer release waited behind blocked publication"
  );
  require(
    std::chrono::steady_clock::now() - voice_probe_started <
      std::chrono::milliseconds(500),
    "voice-control probe exceeded its independent deadline"
  );
  const auto voice_probe = sink->reply("probe-voice-control");
  require(
    voice_probe && voice_probe->kind == "voiceControlProbe" &&
      voice_probe->voice_control_host_epoch == 7 &&
      voice_probe->voice_control_queue_capacity > 0 &&
      !voice_probe->voice_control_worker_owner.empty() &&
      !voice_probe->voice_control_retirement_owner.empty(),
    "voice-control probe lost capacity, epoch, or cleanup ownership"
  );
  livekit->releaseNext(
    DeterministicFakeLiveKitVoiceSession::Operation::Publish
  );
  require(
    blocked_publication.wait_for(std::chrono::seconds(1)) ==
      std::future_status::ready,
    "blocked publication did not finish after release"
  );
  if (blocked_publication.get().hasError()) {
    throw std::runtime_error("released publication failed");
  }

  MediaCommand disconnect;
  disconnect.type = syrnike::desktop_native::NativeCommandType::DisconnectVoice;
  disconnect.request_id = "voice-disconnect";
  disconnect.session_id = "voice-session";
  disconnect.generation = 2;
  require(runtime.dispatch(disconnect), "media runtime rejected voice disconnect");
  require(
    sink->waitReply("voice-disconnect", std::chrono::seconds(2)),
    "voice disconnect did not retire the previous generation"
  );

  MediaCommand track_failure;
  track_failure.type = syrnike::desktop_native::NativeCommandType::VoiceRemoteAudioTrackFailed;
  track_failure.session_id = "voice-session";
  track_failure.generation = 2;
  track_failure.track_id = "failed-audio-track";
  track_failure.video_source = "audio_output_direct_sink_attach_failed";
  track_failure.internal_message = "injected direct sink attach failure";
  require(runtime.dispatch(std::move(track_failure)),
    "media runtime rejected track-scoped audio failure");
  require(sink->waitTrackFailure("failed-audio-track"),
    "remote audio track failure terminalized the global output lane");

  std::mutex release_mutex;
  std::condition_variable released;
  bool stale_frame_released = false;
  MediaCommand stale_frame;
  stale_frame.type = syrnike::desktop_native::NativeCommandType::RemoteVideoFrame;
  stale_frame.session_id = "voice-session";
  stale_frame.generation = 1;
  stale_frame.track_id = "stale-track";
  stale_frame.frame_sequence = 44;
  stale_frame.on_drop = [&] {
    {
      std::lock_guard lock(release_mutex);
      stale_frame_released = true;
    }
    released.notify_all();
  };
  require(runtime.dispatch(std::move(stale_frame)), "media runtime rejected stale frame cleanup");
  {
    std::unique_lock lock(release_mutex);
    require(
      released.wait_for(lock, std::chrono::seconds(1), [&] { return stale_frame_released; }),
      "stale-generation frame was not released by its owning actor worker"
    );
  }

  runtime.requestShutdown();
  runtime.shutdownAndWait();
  runtime.shutdownAndWait();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
