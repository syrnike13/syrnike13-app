#include "audio/livekit_screen_audio_session.hpp"
#include "capture/window_capture.hpp"
#include "capture/wgc_window_capture.hpp"
#include "screen/production_screen_pipeline.hpp"
#include "livekit/livekit_screen_publication_adapter.hpp"
#include "sources/win32_source_enumerator.hpp"
#include "lab/audio_pulse_recorder.hpp"
#include "lab/reference_audio_playback.hpp"
#include "lab/audio_session_volume_probe.hpp"
#include "lab/preview_pixel_observer.hpp"
#include "lab/gpu_contention.hpp"
#include "lab/encoder_contention.hpp"
#include <syncstream>
#include <tlhelp32.h>
#include <psapi.h>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <fstream>
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
  if (!ok) {
    std::cerr << "LAB_REQUIRE_FAILURE " << message << std::endl;
    throw std::runtime_error(message);
  }
}
void logTermination() noexcept {
  std::cerr << "LAB_TERMINATE" << std::endl;
  if (const auto error = std::current_exception()) {
    try {
      std::rethrow_exception(error);
    } catch (const std::exception& cause) {
      std::cerr << cause.what() << std::endl;
    } catch (...) {
      std::cerr << "Unknown active exception" << std::endl;
    }
  }
  void* frames[32]{};
  const auto count = CaptureStackBackTrace(0, 32, frames, nullptr);
  for (USHORT index = 0; index < count; ++index) {
    HMODULE module{};
    char name[MAX_PATH]{};
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCSTR>(frames[index]), &module);
    GetModuleFileNameA(module, name, MAX_PATH);
    std::cerr << std::filesystem::path(name).filename().string() << "+0x" << std::hex
        << (reinterpret_cast<std::uintptr_t>(frames[index]) - reinterpret_cast<std::uintptr_t>(module))
        << std::dec << std::endl;
  }
  std::abort();
}
}  // namespace
int main(int argc, char** argv) {
  std::set_terminate(logTermination);
  try {
    require(argc == 3, "Expected fixture PID and duration seconds");
    const auto pid = static_cast<DWORD>(std::stoul(argv[1]));
    const auto seconds = std::stoul(argv[2]);
    const auto* scenario_value = std::getenv("MEDIA_LAB_AUDIO_SCENARIO");
    const std::string scenario = scenario_value ? scenario_value : "sync";
    require(scenario == "sync" || scenario == "system" || scenario == "process-isolation" ||
                scenario == "audio-stop" || scenario == "video-stop" || scenario == "audio-loss" ||
                scenario == "source-close" || scenario == "slow-source" ||
                scenario == "audio-cycles" || scenario == "default-output" || scenario == "bitrate",
            "Unknown audio scenario");
    const bool bitrate_lab = scenario == "bitrate";
    const auto* bitrate_scenario_value = std::getenv("MEDIA_LAB_BITRATE_SCENARIO");
    const std::string_view bitrate_scenario = bitrate_scenario_value ? bitrate_scenario_value : "network";
    require(bitrate_scenario == "network" || bitrate_scenario == "preview-stall" ||
                bitrate_scenario == "gpu-pressure" || bitrate_scenario == "late-static", "Unknown bitrate scenario");
    const bool preview_stall = bitrate_lab && bitrate_scenario == "preview-stall";
    const bool gpu_pressure = bitrate_lab && bitrate_scenario == "gpu-pressure";
    const bool late_static = bitrate_lab && bitrate_scenario == "late-static";
    require(seconds >= 5 && seconds <= (bitrate_lab ? 1260UL : 660UL), "Duration outside audio lab bounds");
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
      if (scenario == "system" || preview_stall)
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
      std::osyncstream(std::cout) << "AUDIO_WINDOW_DIAGNOSTIC visible=" << IsWindowVisible(window)
                << " minimized=" << IsIconic(window) << " client=" << bounds.right << "x"
                << bounds.bottom << std::endl;
      capture::WindowCapture capture(registry, source_id, capture::createWgcWindowCaptureBackend());
      auto frames = std::make_shared<screen::ScreenFramePipeline>();
      const auto gpu = capture::processD3d11Device(false);
      const auto profile = bitrate_lab ? screen::kScreenProfile1080p60 : screen::kScreenProfile720p30;
      screen::ProductionScreenPipeline video(
          gpu, frames, profile,
          [transport](std::function<void()> keyframe) {
            return std::make_shared<LiveKitScreenPublicationAdapter>(
                transport, LiveKitScreenEncoderControls{std::move(keyframe)});
          },
          {}, true);
      std::unique_ptr<lab::PreviewPixelObserver> preview;
      std::unique_ptr<lab::GpuContention> contention;
      std::unique_ptr<lab::EncoderContention> encoder_contention;
      if (bitrate_lab) {
        require(video.enableAdaptiveQuality(1U << 4, 4), "Exact 1080p60 preset was not admitted");
        preview = std::make_unique<lab::PreviewPixelObserver>();
        contention = std::make_unique<lab::GpuContention>(gpu);
        if (gpu_pressure) encoder_contention = std::make_unique<lab::EncoderContention>(gpu);
      }
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
      std::osyncstream(std::cout) << "SCREEN_AUDIO_READY" << std::endl;
      const auto began = std::chrono::steady_clock::now();
      const auto end = began + std::chrono::seconds{seconds};
      std::uint64_t last_bitrate_sample_ms = 0;
      const auto change_at = std::chrono::steady_clock::now() + 8s;
      bool changed = false;
      bool source_closed = false;
      unsigned completed_cycles = 0;
      std::uint64_t audio_revision = 1;
      bool cycle_audio_on = true;
      auto cycle_at = std::chrono::steady_clock::now() + 1s;
      bool fixture_static = false;
      bool audio_failure_reported = false;
      while (std::chrono::steady_clock::now() < end) {
        if (bitrate_lab) {
          const auto elapsed = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - began).count());
          const bool preview_stalled = preview_stall && elapsed >= 20000 && elapsed < 160000;
          const bool make_static = late_static && elapsed >= 30000 && elapsed < 70000;
          if (make_static != fixture_static) {
            require(PostMessageW(window, WM_APP + 139, make_static ? 1 : 0, 0) != FALSE,
                    "Static fixture control failed");
            fixture_static = make_static;
          }
          if (!preview_stalled) preview->poll();
          const bool busy = gpu_pressure ? elapsed >= 20000 && elapsed < 140000
              : elapsed % 300000 >= 150000 && elapsed % 300000 < 160000;
          contention->setActive(busy);
          if (encoder_contention) {
            encoder_contention->setActive(busy);
            require(!encoder_contention->failed(), "Competing hardware encoder failed");
          }
          require(SUCCEEDED(contention->failure()), "GPU contention fixture failed");
          if (elapsed - last_bitrate_sample_ms >= 500) {
            const auto s = video.stats();
            const auto audio_stats = audio_owner.stats().session;
            DWORD handles = 0, threads = 0;
            require(GetProcessHandleCount(GetCurrentProcess(), &handles) != FALSE, "Handle query failed");
            const auto thread_snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            require(thread_snapshot != INVALID_HANDLE_VALUE, "Thread snapshot failed");
            THREADENTRY32 entry{sizeof(THREADENTRY32)};
            if (Thread32First(thread_snapshot, &entry)) do {
              if (entry.th32OwnerProcessID == GetCurrentProcessId()) ++threads;
            } while (Thread32Next(thread_snapshot, &entry));
            CloseHandle(thread_snapshot);
            PROCESS_MEMORY_COUNTERS_EX memory{};
            require(GetProcessMemoryInfo(GetCurrentProcess(),
                reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)) != FALSE,
                "Memory query failed");
            std::osyncstream(std::cout) << "BITRATE_SAMPLE {\"elapsedMs\":" << elapsed
                << ",\"profile\":" << s.current_profile << ",\"generation\":" << s.profile_generation
                << ",\"encoderInstance\":" << s.encoder.instance_id
                << ",\"width\":" << profile.width << ",\"height\":" << profile.height
                << ",\"fps\":" << profile.frames_per_second
                << ",\"targetBps\":" << s.target_bitrate << ",\"appliedBps\":" << s.bitrate.applied_bitrate
                << ",\"updates\":" << s.bitrate_updates << ",\"outcome\":" << static_cast<int>(s.bitrate.outcome)
                << ",\"platformResult\":" << s.bitrate.platform_result
                << ",\"reason\":" << static_cast<int>(s.decision_reason)
                << ",\"warning\":" << (s.quality_warning ? "true" : "false")
                << ",\"networkBps\":" << s.network.available_outgoing_bitrate.value_or(0)
                << ",\"senderAllocationKnown\":" << (s.network.sender_bitrate_allocation ? "true" : "false")
                << ",\"senderAllocationBps\":" << s.network.sender_bitrate_allocation.value_or(0)
                << ",\"networkMeasuredAtMs\":" << s.network.measured_at_ms
                << ",\"packetSendDelayKnown\":" << (s.network.packet_send_delay_us ? "true" : "false")
                << ",\"packetSendDelayUs\":" << s.network.packet_send_delay_us.value_or(0)
                << ",\"packetSendDelayMeasuredAtMs\":" << s.network.packet_send_delay_measured_at_ms
                << ",\"networkBackpressureDrops\":" << s.network_backpressure_drops
                << ",\"captureFrames\":" << s.capture_frames << ",\"encoderFrames\":" << s.encoder.encoded
                << ",\"encodedBytes\":" << s.encoder.encoded_bytes
                << ",\"keyframes\":" << s.encoder.keyframes
                << ",\"keyframeBytes\":" << s.encoder.keyframe_bytes
                << ",\"lastKeyframeBytes\":" << s.encoder.last_keyframe_bytes
                << ",\"consumed\":" << s.total_publication_consumed
                << ",\"videoDepth\":" << s.sender.video_depth << ",\"bytes\":" << s.memory.total_bytes
                << ",\"handles\":" << handles << ",\"threads\":" << threads
                << ",\"privateBytes\":" << memory.PrivateUsage
                << ",\"previewFrames\":" << preview->frames << ",\"previewChanges\":" << preview->content_changes
                << ",\"previewAgeMaxUs\":" << preview->maximum_age_us
                << ",\"previewStalled\":" << (preview_stalled ? "true" : "false")
                << ",\"fixtureStatic\":" << (fixture_static ? "true" : "false")
                << ",\"remoteVoicePlayed\":" << (reference_playback ? reference_playback->playedSamples() : 0)
                << ",\"audioPackets\":" << audio_stats.submitted
                << ",\"audioQueueDepth\":" << audio_stats.queue_depth
                << ",\"audioQueueMaximumDepth\":" << audio_stats.maximum_queue_depth
                << ",\"audioSupersededPackets\":" << audio_stats.superseded_packets
                << ",\"audioStalePackets\":" << audio_stats.stale_packets
                << ",\"audioMaximumSubmitAgeUs\":" << audio_stats.maximum_submit_age_us
                << ",\"keyframeRequests\":" << s.keyframe_requests
                << ",\"gpuActive\":" << (busy ? "true" : "false")
                << ",\"gpuDurationUs\":" << s.converter.gpu_duration_last_us
                << ",\"gpuDurationMaxUs\":" << s.converter.gpu_duration_max_us
                << ",\"gpuFixtureBytes\":" << lab::GpuContention::allocated_bytes
                << ",\"competingEncoderFrames\":" << (encoder_contention ? encoder_contention->frames() : 0)
                << ",\"competingEncoderBytes\":" << (encoder_contention ? lab::EncoderContention::tracked_bytes : 0)
                << ",\"gpuBatches\":" << contention->batches() << "}" << std::endl;
            last_bitrate_sample_ms = elapsed;
          }
        }
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
            std::osyncstream(std::cout) << "AUDIO_OWNER_CYCLE {\"cycle\":" << completed_cycles
                      << ",\"handles\":" << handles
                      << ",\"clients\":0,\"captureThreads\":0,\"pcmDepth\":0}" << std::endl;
          }
          cycle_audio_on = !cycle_audio_on;
          cycle_at = std::chrono::steady_clock::now() + (cycle_audio_on ? 1s : 200ms);
        }
        const auto audio_failure = audio_owner.stats().failure;
        if (audio_failure && !audio_failure_reported) {
          audio_failure_reported = true;
          std::osyncstream(std::cout) << "AUDIO_OWNER_FAILURE {\"code\":" << static_cast<int>(audio_failure->code)
              << ",\"platformResult\":" << audio_failure->result
              << ",\"utilityRetirementRequired\":" << (audio_failure->utility_retirement_required ? "true" : "false")
              << "}" << std::endl;
        }
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
      if (scenario == "bitrate") {
        const auto end_path = environment("MEDIA_LAB_MEASURED_END_PATH");
        std::ofstream measured_end(std::filesystem::path(std::u8string(end_path.begin(), end_path.end())));
        measured_end << std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        measured_end.flush();
        require(static_cast<bool>(measured_end), "Measured interval end could not be recorded");
      }
      producer.request_stop();
      if (producer.joinable()) producer.join();
      if (preview) preview->drain();
      if (contention) contention->setActive(false);
      if (scenario == "audio-cycles")
        require(completed_cycles == 30, "Thirty audio lifecycle cycles did not finish");
      require(audio_owner.stop(std::chrono::steady_clock::now() + 25s), "Audio owner did not stop");
      const auto audio_stats = audio_owner.stats().session;
      session_volumes.observe();
      std::osyncstream(std::cout) << "AUDIO_SESSION_VOLUME_REPORT {\"foreignActiveSessions\":"
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
        std::osyncstream(std::cout) << "REFERENCE_PLAYBACK_REPORT {\"audiblePackets\":"
                  << reference_playback->audiblePackets()
                  << ",\"playedSamples\":" << reference_playback->playedSamples() << "}"
                  << std::endl;
      }
      require(capture.stop(5s).ok, "Window capture did not stop");
      require(video.stop(std::chrono::steady_clock::now() + 5s).ok,
              "Video publication did not stop");
      if (bitrate_lab)
        std::osyncstream(std::cout) << "BITRATE_STOP {\"warning\":" << (video.stats().quality_warning ? "true" : "false")
                  << ",\"encoderInstance\":" << video.stats().encoder.instance_id << "}" << std::endl;
      std::osyncstream(std::cout) << "SCREEN_AUDIO_REPORT {\"submitted\":" << audio_stats.submitted
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
