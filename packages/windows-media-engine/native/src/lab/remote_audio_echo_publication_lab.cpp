#include "audio/livekit_microphone_dsp.hpp"
#include "audio/microphone_pipeline.hpp"
#include "audio/microphone_sender.hpp"
#include "audio/remote_audio_output.hpp"
#include "audio/remote_audio_tracks.hpp"
#include "lab/remote_audio_probe.hpp"

#include <cstdlib>
#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media;
using namespace syrnike::windows_media::audio;
namespace {
using Clock = std::chrono::steady_clock;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
const char* environment(const char* key) {
  const auto* value = std::getenv(key);
  require(value && *value, "Echo publication lab environment missing");
  return value;
}
}
int remoteAudioEchoPublication() {
  RemoteAudioMixerWorker mixer;
  auto tracks = std::make_shared<RemoteAudioTracks>(mixer);
  auto transport = std::make_shared<LiveKitRoomTransport>(tracks);
  Engine engine(EngineOptions{.room_transport = transport});
  require(engine.start().ok, "Echo publication engine failed");
  require(engine.installCredentialLease({"echo-lab", environment("LIVEKIT_URL"), environment("LIVEKIT_OBSERVER_TOKEN")}).ok,
          "Echo publication credential failed");
  EngineDesiredState desired;
  desired.revision = 1;
  desired.room = RoomIntent{"native-v2-remote-audio-lab", "remote-listener", "echo-lab"};
  require(engine.applyDesiredState(desired).ok, "Echo publication Room intent failed");
  const auto connect_deadline = Clock::now() + std::chrono::seconds{12};
  while (!transport->activeRoom() && Clock::now() < connect_deadline) std::this_thread::sleep_for(std::chrono::milliseconds{10});
  const auto room = transport->activeRoom();
  require(room && tracks->attachRoom(room) && tracks->seedConnectedRoom(), "Echo publication Room attachment failed");
  {
    AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
    const auto devices = registry.refresh();
    require(devices.status == AudioRegistryStatus::ready, "Echo publication registry failed");
    RemoteAudioOutput output(mixer);
    require(output.selectOutput(registry, {AudioDirection::output, {}}) == RemoteOutputFailure::none, "Echo publication output failed");
    MicrophonePipeline microphone(makeLiveKitMicrophoneEnhancement);
    require(microphone.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none, "Echo publication input failed");
    MicrophoneDspConfig config;
    // The local SFU fixture proves publication continuity with digital silence.
    // Muting occurs after enhancement, so the real AEC path is still exercised.
    config.muted = true;
    require(microphone.configure(config) == MicrophonePipelineFailure::none &&
            microphone.setEchoReference(output.echoReference()) == MicrophonePipelineFailure::none &&
            microphone.setDemand({true, true, true}) == MicrophonePipelineFailure::none, "Echo microphone setup failed");
    MicrophoneSender sender(transport, microphone.output(), microphone.outputEvent());
    require(sender.start() == MicrophonePublicationFailure::none, "Echo microphone publication failed");
    std::uint64_t active_observations = 0, unsupported_observations = 0;
    const auto observe = [&](std::chrono::seconds duration) {
      const auto began = Clock::now();
      while (Clock::now() - began < duration) {
        const auto echo = microphone.stats().meter.echo;
        if (echo == EchoAvailability::active) ++active_observations;
        if (echo == EchoAvailability::unsupported) ++unsupported_observations;
        std::this_thread::sleep_for(std::chrono::milliseconds{20});
      }
    };
    observe(std::chrono::seconds{3});
    const auto before = sender.stats();
    const auto input_before = microphone.stats();
    require(active_observations > 20 && tracks->stats().reading == 2 && before.published && before.submitted > 150,
            "Real rendered reference did not reach publishing microphone");
    syrnike::windows_media::lab::render_probe_epoch = output.stats().active.epoch;
    syrnike::windows_media::lab::render_stop_client = true;
    const auto loss_deadline = Clock::now() + std::chrono::seconds{2};
    while (output.stats().active.state != WasapiOutputState::failed && Clock::now() < loss_deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds{10});
    require(output.stats().active.failure == WasapiOutputFailure::no_progress, "Output loss was not detected");
    observe(std::chrono::seconds{2});
    const auto after_loss = sender.stats();
    require(microphone.stats().meter.echo == EchoAvailability::unavailable && after_loss.published &&
            after_loss.submitted > before.submitted + 150 && after_loss.publication_commits == 1 &&
            transport->activeRoom() == room && room->connectionState() == livekit::ConnectionState::Connected,
            "Output loss disturbed microphone publication/Room or retained AEC availability");
    require(output.reconcile(registry, devices.revision) == RemoteOutputFailure::none &&
            microphone.setEchoReference(output.echoReference()) == MicrophonePipelineFailure::none, "Echo output recovery failed");
    observe(std::chrono::seconds{2});
    const auto restored = sender.stats();
    const auto input_after = microphone.stats();
    require(unsupported_observations > 20 && restored.published && restored.submitted > after_loss.submitted + 150 &&
            restored.publication_commits == 1 && restored.failure == MicrophonePublicationFailure::none &&
            input_after.capture.generation == input_before.capture.generation && input_after.capture_opens == 1,
            "Renderer epoch replacement did not preserve microphone with typed AEC limitation");
    require(sender.stop(Clock::now() + std::chrono::seconds{6}) && microphone.stop(Clock::now() + std::chrono::seconds{5}) &&
            output.stop(Clock::now() + std::chrono::seconds{5}), "Echo publication cleanup deadline");
    std::cout << "{\"scope\":\"rendered-reference-published-microphone-output-loss\",\"status\":\"pass\","
              << "\"activeAecObservations\":" << active_observations << ",\"unsupportedEpochObservations\":" << unsupported_observations
              << ",\"submittedBeforeLoss\":" << before.submitted << ",\"submittedAfterLoss\":" << after_loss.submitted
              << ",\"submittedAfterRecovery\":" << restored.submitted << ",\"publicationCommits\":" << restored.publication_commits
              << ",\"captureOpens\":" << input_after.capture_opens << ",\"roomPreserved\":true,\"outputLossUnavailable\":true,"
              << "\"epochOutcome\":\"unsupported\",\"publicationMuted\":true}" << std::endl;
  }
  require(tracks->detachRoom(), "Echo tracks detach failed");
  require(engine.shutdown().ok, "Echo engine shutdown failed");
  tracks->stop();
  require(mixer.stop(Clock::now() + std::chrono::seconds{5}), "Echo mixer stop failed");
  return 0;
}
