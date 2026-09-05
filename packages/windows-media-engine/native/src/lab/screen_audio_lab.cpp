#include "audio/livekit_screen_audio_session.hpp"
#include "capture/window_capture.hpp"
#include "capture/wgc_window_capture.hpp"
#include "screen/production_screen_pipeline.hpp"
#include "livekit/livekit_screen_publication_adapter.hpp"
#include "sources/win32_source_enumerator.hpp"
#include "lab/audio_pulse_recorder.hpp"
#include "lab/reference_audio_playback.hpp"
#include "lab/audio_session_volume_probe.hpp"
#include <cstdlib>
#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media;
using namespace std::chrono_literals;
namespace {
std::string environment(const char* name) {
  const auto* value = std::getenv(name);
  if (!value || !*value) throw std::runtime_error(std::string("Missing ") + name);
  return value;
}
void require(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}
}  // namespace
int main(int argc, char** argv) {
  try {
    require(argc == 3, "Expected fixture PID and duration seconds");
    const auto pid = static_cast<DWORD>(std::stoul(argv[1]));
    const auto seconds = std::stoul(argv[2]);
    const auto* scenario_value = std::getenv("MEDIA_LAB_AUDIO_SCENARIO");
    const std::string scenario = scenario_value ? scenario_value : "sync";
    require(scenario == "sync" || scenario == "system" || scenario == "process-isolation" ||
                scenario == "audio-stop" || scenario == "video-stop" || scenario == "audio-loss" ||
                scenario == "source-close" || scenario == "slow-source" ||
                scenario == "audio-cycles" || scenario == "default-output",
            "Unknown audio scenario");
    require(seconds >= 5 && seconds <= 660, "Duration outside audio lab bounds");
    auto transport = std::make_shared<LiveKitRoomTransport>();
    Engine engine(EngineOptions{.room_transport = transport});
    require(engine.start().ok, "Engine start failed");
    require(engine
                .installCredentialLease({"audio-lab", environment("LIVEKIT_URL"),
                                         environment("LIVEKIT_PUBLISHER_TOKEN")})
                .ok,
            "Credential installation failed");
    EngineDesiredState desired;
    desired.revision = 1;
    desired.room = RoomIntent{"native-v2-media-lab", "native-v2-publisher", "audio-lab"};
    require(engine.applyDesiredState(desired).ok, "Room intent rejected");
    const auto connected_by = std::chrono::steady_clock::now() + 12s;
    while (!transport->activeRoom() && std::chrono::steady_clock::now() < connected_by)
      std::this_thread::sleep_for(10ms);
    require(transport->activeRoom() != nullptr, "Room did not connect");
    {
      std::unique_ptr<lab::ReferenceAudioPlayback> reference_playback;
      if (scenario == "system")
        reference_playback = std::make_unique<lab::ReferenceAudioPlayback>(transport->activeRoom());
      sources::SourceRegistry registry(sources::createWin32SourceEnumerator());
      sources::EnumerationOptions options;
      options.kind = sources::EnumerationOptions::Kind::Window;
      const auto sources = registry.enumerate(options).sources;
      const auto sourceForPid = [&](DWORD expected) {
        for (const auto& source : sources) {
          if (source.title != "Syrnike audio sync fixture") continue;
          const auto target = registry.resolveWindowTarget(source.id);
          DWORD candidate = 0;
          if (target.target)
            GetWindowThreadProcessId(reinterpret_cast<HWND>(target.target->platformValue()),
                                     &candidate);
          if (candidate == expected) return source.id;
        }
        return std::string{};
      };
      const auto source_id = sourceForPid(pid);
      require(!source_id.empty(), "Owned fixture window was not enumerated");
      const auto* audio_pid_value = std::getenv("MEDIA_LAB_AUDIO_TARGET_PID");
      const auto audio_pid =
          audio_pid_value ? static_cast<DWORD>(std::stoul(audio_pid_value)) : pid;
      const auto identity =
          audio::AudioProcessIdentity::fromWindow(registry, sourceForPid(audio_pid));
      require(identity && identity->pid() == audio_pid, "Fixture identity changed");
      const auto window_target = registry.resolveWindowTarget(source_id);
      const auto window = reinterpret_cast<HWND>(window_target.target->platformValue());
      RECT bounds{};
      GetClientRect(window, &bounds);
      std::cout << "AUDIO_WINDOW_DIAGNOSTIC visible=" << IsWindowVisible(window)
                << " minimized=" << IsIconic(window) << " client=" << bounds.right << "x"
                << bounds.bottom << std::endl;
      capture::WindowCapture capture(registry, source_id, capture::createWgcWindowCaptureBackend());
      auto frames = std::make_shared<screen::ScreenFramePipeline>();
      screen::ProductionScreenPipeline video(
          capture::processD3d11Device(false), frames, screen::kScreenProfile720p30,
          [transport](std::function<void()> keyframe) {
            return std::make_shared<LiveKitScreenPublicationAdapter>(
                transport, LiveKitScreenEncoderControls{std::move(keyframe)});
          },
          {}, true);
      lab::AudioPulseRecorder audio_references;
      lab::AudioSessionVolumeProbe session_volumes;
      std::uint64_t observed_packets = 0;
      audio::ScreenAudioOwner audio_owner([&] {
        return std::make_unique<audio::LiveKitScreenAudioSession>(
            transport, [&](const audio::PcmPacket& packet) {
              audio_references.observe(packet);
              // Stall only the publication worker, with real Windows capture
              // continuing independently. This is explicit fault injection.
              if (scenario == "slow-source" && ++observed_packets <= 1000 &&
                  observed_packets % 500 == 0)
                std::this_thread::sleep_for(250ms);
            });
      });
      require(audio_owner.applyDesired(
                  1,
                  audio::ScreenAudioIntent{
                      scenario == "system" ? audio::ScreenAudioMode::system_exclude_client
                                           : audio::ScreenAudioMode::include_process_tree,
                      scenario == "system" ? audio::AudioProcessIdentity::current() : identity}),
              "Audio intent rejected");
      const auto audio_deadline = std::chrono::steady_clock::now() + 15s;
      while (audio_owner.stats().state != audio::ScreenAudioState::running &&
             !audio_owner.stats().failure && std::chrono::steady_clock::now() < audio_deadline)
        std::this_thread::sleep_for(5ms);
      require(audio_owner.stats().state == audio::ScreenAudioState::running,
              "Audio publication failed");
      const auto capture_started = capture.start();
      if (!capture_started.ok)
        throw std::runtime_error(capture_started.failure ? capture_started.failure->code + ": " +
                                                               capture_started.failure->message
                                                         : "Window capture failed");
      require(video.start("screen-audio-sync", 5s).ok, "Video publication failed");
      std::jthread producer([&](std::stop_token stop) {
        while (!stop.stop_requested())
          if (auto frame = capture.waitForFrame(50ms)) (void)frames->submit(std::move(*frame));
      });
      std::cout << "SCREEN_AUDIO_READY" << std::endl;
      const auto end = std::chrono::steady_clock::now() + std::chrono::seconds{seconds};
      const auto change_at = std::chrono::steady_clock::now() + 8s;
      bool changed = false;
      bool source_closed = false;
      unsigned completed_cycles = 0;
      std::uint64_t audio_revision = 1;
      bool cycle_audio_on = true;
      auto cycle_at = std::chrono::steady_clock::now() + 1s;
      while (std::chrono::steady_clock::now() < end) {
        session_volumes.observe();
        if (scenario == "audio-cycles" && completed_cycles < 30 &&
            std::chrono::steady_clock::now() >= cycle_at) {
          require(
              audio_owner.applyDesired(
                  ++audio_revision,
                  cycle_audio_on ? std::nullopt
                                 : std::optional{audio::ScreenAudioIntent{
                                       audio::ScreenAudioMode::include_process_tree, identity}}),
              "Cycle intent rejected");
          const auto expected =
              cycle_audio_on ? audio::ScreenAudioState::stopped : audio::ScreenAudioState::running;
          const auto deadline = std::chrono::steady_clock::now() + 6s;
          while (audio_owner.stats().state != expected && !audio_owner.stats().failure &&
                 std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(5ms);
          const auto snapshot = audio_owner.stats();
          require(snapshot.state == expected && !snapshot.failure, "Audio lifecycle cycle failed");
          if (cycle_audio_on) {
            ++completed_cycles;
            require(snapshot.session.clients == 0 && snapshot.session.threads == 0 &&
                        snapshot.session.queue_depth == 0,
                    "Audio resources survived cycle stop");
            DWORD handles = 0;
            require(GetProcessHandleCount(GetCurrentProcess(), &handles) != FALSE,
                    "Cycle handle query failed");
            std::cout << "AUDIO_OWNER_CYCLE {\"cycle\":" << completed_cycles
                      << ",\"handles\":" << handles
                      << ",\"clients\":0,\"captureThreads\":0,\"pcmDepth\":0}" << std::endl;
          }
          cycle_audio_on = !cycle_audio_on;
          cycle_at = std::chrono::steady_clock::now() + (cycle_audio_on ? 1s : 200ms);
        }
        const auto audio_failure = audio_owner.stats().failure;
        require(
            !audio_failure || (scenario == "audio-loss" &&
                               audio_failure->code == audio::ScreenAudioFailureCode::target_exited),
            "Audio owner failed while streaming");
        require(video.state() != screen::ProductionScreenPipelineState::failed,
                "Video failed while streaming");
        if (!changed && std::chrono::steady_clock::now() >= change_at) {
          changed = true;
          if (scenario == "audio-stop")
            require(audio_owner.applyDesired(2, std::nullopt), "Independent audio off rejected");
          if (scenario == "source-close")
            require(PostMessageW(window, WM_CLOSE, 0, 0) != FALSE, "Fixture close failed");
          if (scenario == "video-stop") {
            producer.request_stop();
            producer.join();
            require(capture.stop(5s).ok, "Independent capture stop failed");
            require(video.stop(std::chrono::steady_clock::now() + 5s).ok,
                    "Independent video stop failed");
          }
        }
        while (auto event = capture.waitForEvent(0ms)) {
          if (scenario == "source-close" &&
              event->kind == capture::WindowCaptureEventKind::SourceClosed) {
            source_closed = true;
            producer.request_stop();
            if (producer.joinable()) producer.join();
            require(capture.stop(5s).ok, "Closed capture did not drain");
            require(video.stop(std::chrono::steady_clock::now() + 5s).ok,
                    "Closed video did not unpublish");
          }
        }
        std::this_thread::sleep_for(20ms);
      }
      producer.request_stop();
      if (producer.joinable()) producer.join();
      if (scenario == "audio-cycles")
        require(completed_cycles == 30, "Thirty audio lifecycle cycles did not finish");
      require(audio_owner.stop(std::chrono::steady_clock::now() + 25s), "Audio owner did not stop");
      const auto audio_stats = audio_owner.stats().session;
      session_volumes.observe();
      std::cout << "AUDIO_SESSION_VOLUME_REPORT {\"foreignActiveSessions\":"
                << session_volumes.sessions()
                << ",\"observations\":" << session_volumes.observations()
                << ",\"volumeChanges\":0,\"muteChanges\":0}" << std::endl;
      require(audio_stats.maximum_queue_depth <= audio::kAudioQueueCapacity,
              "PCM queue exceeded its hard bound");
      if (scenario == "slow-source")
        require(audio_stats.superseded_packets > 0,
                "Slow publication did not exercise old PCM drops");
      const auto final_failure = audio_owner.stats().failure;
      require(
          !final_failure || (scenario == "audio-loss" &&
                             final_failure->code == audio::ScreenAudioFailureCode::target_exited),
          "Audio teardown failed");
      if (scenario == "audio-loss")
        require(audio_owner.stats().failure && audio_owner.stats().failure->code ==
                                                   audio::ScreenAudioFailureCode::target_exited,
                "Audio target exit was not reported");
      if (scenario == "source-close") require(source_closed, "Selected window did not close");
      if (reference_playback) {
        require(!reference_playback->failed() && reference_playback->audiblePackets() >= 15 &&
                    reference_playback->playedSamples() >= 48000 * 5,
                "Own remote reference voice was not actually played");
        std::cout << "REFERENCE_PLAYBACK_REPORT {\"audiblePackets\":"
                  << reference_playback->audiblePackets()
                  << ",\"playedSamples\":" << reference_playback->playedSamples() << "}"
                  << std::endl;
      }
      require(capture.stop(5s).ok, "Window capture did not stop");
      require(video.stop(std::chrono::steady_clock::now() + 5s).ok,
              "Video publication did not stop");
      std::cout << "SCREEN_AUDIO_REPORT {\"submitted\":" << audio_stats.submitted
                << ",\"audioFailure\":\""
                << (audio_owner.stats().failure ? "target_exited" : "none") << "\""
                << ",\"maximumSubmitAgeUs\":" << audio_stats.maximum_submit_age_us
                << ",\"maximumQueueDepth\":" << audio_stats.maximum_queue_depth
                << ",\"supersededPackets\":" << audio_stats.superseded_packets
                << ",\"stalePackets\":" << audio_stats.stale_packets
                << ",\"videoConsumed\":" << video.stats().total_publication_consumed << "}"
                << std::endl;
    }
    require(engine.shutdown(12s).ok, "Engine shutdown failed");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << std::endl;
    return 1;
  }
}
