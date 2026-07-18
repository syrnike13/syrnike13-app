#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "media/audio_constants.hpp"
#include "media/camera_capture.hpp"
#include "media/livekit_connect_policy.hpp"
#include "media/microphone_audio_processor.hpp"
#include "media/microphone_echo_reference.hpp"
#include "media/microphone_metrics_cadence.hpp"
#include "media/remote_audio_output.hpp"
#include "media/remote_video_bridge.hpp"
#include "media/runtime_config.hpp"
#include "media/screen_audio_capture.hpp"
#include "media/voice_gate.hpp"

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

std::vector<float> frameAtDb(float db) {
  return std::vector<float>(
    syrnike::voice::kSamplesPer10Ms,
    std::pow(10.0f, db / 20.0f)
  );
}

float frameRms(const std::vector<float>& frame) {
  if (frame.empty()) return 0.0f;
  double square_sum = 0.0;
  for (const float sample : frame) {
    square_sum += static_cast<double>(sample) * sample;
  }
  return static_cast<float>(std::sqrt(square_sum / frame.size()));
}

float framePeak(const std::vector<float>& frame) {
  float peak = 0.0f;
  for (const float sample : frame) peak = std::max(peak, std::abs(sample));
  return peak;
}

bool isExactSilence(const std::vector<float>& frame) {
  return std::all_of(frame.begin(), frame.end(), [](float sample) {
    return sample == 0.0f;
  });
}

}  // namespace

int main() try {
  using syrnike::desktop_native::media::CameraFormat;
  const auto camera_formats = syrnike::desktop_native::media::rankCameraOutputFormats(
    CameraFormat{1280, 720, 30, 1},
    {
      CameraFormat{640, 480, 30, 1},
      CameraFormat{1920, 1080, 30, 1},
      CameraFormat{1280, 720, 15, 1},
      CameraFormat{1280, 720, 30, 1},
      CameraFormat{},
    });
  require(
    camera_formats.size() == 4 &&
      camera_formats.front() == CameraFormat{1280, 720, 30, 1} &&
      camera_formats[1] == CameraFormat{1280, 720, 15, 1},
    "camera output formats are not ranked from the requested format to the nearest fallback"
  );

  const std::vector<std::uint8_t> padded_rows{
    1, 2, 3, 4, 90, 90, 90, 90,
    5, 6, 7, 8, 91, 91, 91, 91,
  };
  require(
    syrnike::desktop_native::media::copyCameraBgraRows(
      padded_rows.data(), 8, 1, 2) ==
      std::vector<std::uint8_t>{1, 2, 3, 4, 5, 6, 7, 8},
    "camera BGRA copy retained source-row padding"
  );
  require(
    syrnike::desktop_native::media::copyCameraBgraRows(
      padded_rows.data() + 8, -8, 1, 2) ==
      std::vector<std::uint8_t>{5, 6, 7, 8, 1, 2, 3, 4},
    "camera BGRA copy did not normalize a bottom-up frame"
  );

  syrnike::voice::RuntimeConfig config;
  config.echo_cancellation_enabled = true;
  const auto enabled = syrnike::voice::microphoneCleanupApmOptions(config, true);
  require(enabled.noise_suppression, "noise suppression was not enabled");
  require(enabled.echo_cancellation, "echo cancellation ignored a valid reference");

  config.automatic_gain_control_enabled = true;
  require(
    syrnike::voice::microphoneCleanupApmOptions(config, true) == enabled,
    "AGC changes recreated the cleanup APM configuration"
  );

  const auto without_reference =
    syrnike::voice::microphoneCleanupApmOptions(config, false);
  require(!without_reference.echo_cancellation, "echo cancellation ran without reference audio");

  syrnike::voice::RuntimeConfig clipping_config;
  clipping_config.input_volume = 2.0f;
  clipping_config.voice_gate_enabled = false;
  clipping_config.noise_suppression_enabled = false;
  clipping_config.echo_cancellation_enabled = false;
  clipping_config.automatic_gain_control_enabled = true;
  syrnike::voice::MicrophoneAudioProcessor clipping_processor;
  const auto clipping_frame = clipping_processor.processFrame(
    std::vector<float>(syrnike::voice::kSamplesPer10Ms, 0.75f),
    clipping_config,
    nullptr
  );
  require(
    clipping_frame.clipped_samples == syrnike::voice::kSamplesPer10Ms,
    "pre-AGC PCM16 boundary clipping was not reported"
  );

  using LiveKitConnectPolicy =
    syrnike::desktop_native::media::LiveKitConnectPolicy;
  const LiveKitConnectPolicy::Clock::time_point connect_started_at{};
  const auto room_options = LiveKitConnectPolicy::roomOptions(
    LiveKitConnectPolicy::remainingConnectTimeout(
      connect_started_at,
      connect_started_at
    )
  );
  require(
    room_options.connect_timeout.has_value() &&
      *room_options.connect_timeout == std::chrono::seconds(7),
    "LiveKit connect timeout no longer reserves publication and cleanup headroom"
  );
  require(
    room_options.join_retries.has_value() && *room_options.join_retries == 0,
    "LiveKit initial join retries can exceed the host request deadline"
  );
  require(
    LiveKitConnectPolicy::remainingConnectTimeout(
      connect_started_at,
      connect_started_at + std::chrono::seconds(2)
    ) == std::chrono::seconds(5),
    "LiveKit connect timeout does not account for actor preparation time"
  );
  require(
    LiveKitConnectPolicy::remainingPostConnectWait(
      connect_started_at,
      connect_started_at + std::chrono::seconds(6)
    ) == std::chrono::seconds(1),
    "post-connect settle budget changed before the outer request deadline"
  );
  require(
    LiveKitConnectPolicy::remainingPostConnectWait(
      connect_started_at,
      connect_started_at + std::chrono::milliseconds(7'500)
    ) == std::chrono::milliseconds(500),
    "post-connect settle budget does not shrink near the outer request deadline"
  );
  require(
    LiveKitConnectPolicy::remainingPostConnectWait(
      connect_started_at,
      connect_started_at + std::chrono::seconds(8)
    ) == std::chrono::milliseconds(0),
    "post-connect settle budget exceeded the cleanup headroom"
  );

  using MicrophoneMetricsCadence =
    syrnike::desktop_native::media::MicrophoneMetricsCadence;
  const MicrophoneMetricsCadence::Clock::time_point cadence_started_at{};
  MicrophoneMetricsCadence metrics_cadence(cadence_started_at);
  int metric_emissions = 0;
  for (int frame = 1; frame <= 20; ++frame) {
    const auto frame_time = cadence_started_at + std::chrono::milliseconds(frame * 10);
    if (metrics_cadence.shouldEmit(frame_time)) ++metric_emissions;
  }
  require(metric_emissions == 4, "microphone metrics are not emitted at 20Hz");

  MicrophoneMetricsCadence delayed_metrics_cadence(cadence_started_at);
  require(
    delayed_metrics_cadence.shouldEmit(cadence_started_at + std::chrono::milliseconds(120)),
    "delayed microphone metrics did not emit the latest sample"
  );
  require(
    !delayed_metrics_cadence.shouldEmit(cadence_started_at + std::chrono::milliseconds(140)),
    "delayed microphone metrics emitted a catch-up burst"
  );
  require(
    delayed_metrics_cadence.shouldEmit(cadence_started_at + std::chrono::milliseconds(150)),
    "microphone metrics did not resume their 20Hz cadence"
  );

  using syrnike::desktop_native::media::RemoteAudioSettings;
  using syrnike::desktop_native::media::normalizeRemoteAudioIdentity;
  using syrnike::desktop_native::media::resolveRemoteAudioGain;
  require(
    syrnike::desktop_native::media::remoteAudioRenderBufferDuration() ==
      std::chrono::milliseconds(50),
    "remote audio renderer no longer requests its low-latency shared buffer"
  );
  require(
    syrnike::desktop_native::media::remoteAudioRenderChannels() == 2,
    "remote audio renderer no longer preserves stereo"
  );
  require(
    syrnike::desktop_native::media::remoteAudioPlayoutStartDuration() ==
      std::chrono::milliseconds(20),
    "remote audio playout lost its underrun protection"
  );
  require(
    syrnike::desktop_native::media::remoteAudioMaxQueuedDuration() ==
      std::chrono::milliseconds(200),
    "remote audio queue is no longer latency bounded"
  );
  require(
    syrnike::voice::kScreenAudioFramesPerPacket == 480,
    "screen audio is no longer packetized into LiveKit 10 ms frames"
  );
  require(
    syrnike::desktop_native::media::remoteAudioLimiterTargetGain(0.9F) == 1.0F,
    "remote audio limiter changes signals below its ceiling"
  );
  require(
    std::abs(
      syrnike::desktop_native::media::remoteAudioLimiterTargetGain(1.96F) - 0.5F
    ) < 0.001F,
    "remote audio limiter does not prevent digital clipping"
  );
  const auto encoded_identity =
    "voice:v1|windows_native|client-a|epoch-a|voice-op-a|user-a";
  require(
    normalizeRemoteAudioIdentity(encoded_identity) == "user-a",
    "native remote audio identity differs from the renderer base identity"
  );
  const auto malformed_identity = "voice:v1|windows_native|user-a";
  require(
    normalizeRemoteAudioIdentity(malformed_identity) == malformed_identity,
    "malformed native identity did not preserve its full fallback key"
  );
  RemoteAudioSettings remote_audio;
  remote_audio.user_volumes["user-a"] = 0.4F;
  remote_audio.stream_volumes["user-a"] = 1.7F;
  require(
    std::abs(resolveRemoteAudioGain(remote_audio, encoded_identity, false) - 0.4F) < 0.001F,
    "participant microphone volume did not reach the native mixer"
  );
  require(
    std::abs(resolveRemoteAudioGain(remote_audio, encoded_identity, true) - 1.7F) < 0.001F,
    "participant stream volume did not stay independent from microphone volume"
  );
  remote_audio.stream_mutes["user-a"] = true;
  require(
    resolveRemoteAudioGain(remote_audio, encoded_identity, true) == 0.0F,
    "participant stream mute did not override its native gain"
  );

  using livekit::TrackSource;
  using syrnike::desktop_native::media::remoteVideoSourceLabel;
  require(
    syrnike::desktop_native::media::kRemoteVideoFirstFrameTimeout ==
      std::chrono::seconds(5),
    "remote video first-frame recovery timeout changed"
  );
  require(
    remoteVideoSourceLabel(TrackSource::SOURCE_SCREENSHARE, std::nullopt) == "screen",
    "publication screen source was not preserved in remote video metadata"
  );
  require(
    remoteVideoSourceLabel(
      TrackSource::SOURCE_CAMERA,
      TrackSource::SOURCE_SCREENSHARE
    ) == "camera",
    "publication camera source was not preserved in remote video metadata"
  );
  require(
    remoteVideoSourceLabel(
      TrackSource::SOURCE_UNKNOWN,
      TrackSource::SOURCE_SCREENSHARE
    ) == "screen",
    "remote video source did not fall back to track metadata"
  );

  syrnike::voice::MicrophoneEchoReferenceBuffer reference(2);
  std::vector<float> stereo(
    static_cast<std::size_t>(syrnike::voice::kSamplesPer10Ms) * 2,
    0.25f
  );
  reference.pushInterleavedFloatStereo(
    stereo.data(), syrnike::voice::kSamplesPer10Ms, false
  );
  const auto mono = reference.popFrame();
  require(mono.has_value(), "echo reference did not produce a 10ms frame");
  require(mono->size() == syrnike::voice::kSamplesPer10Ms, "echo frame size changed");
  for (int index = 0; index < 3; ++index) {
    reference.pushInterleavedFloatStereo(
      stereo.data(), syrnike::voice::kSamplesPer10Ms, false
    );
  }
  require(reference.queuedFrames() == 2, "echo reference queue is unbounded");

  {
    syrnike::voice::VoiceGateProcessor gate(48'000);
    syrnike::voice::VoiceGateConfig gate_config;
    gate_config.enabled = false;
    gate_config.auto_threshold = false;
    gate_config.manual_threshold_db = -26.0f;
    gate.updateConfig(gate_config);
    auto input = frameAtDb(-18.0f);
    const auto expected_rms = frameRms(input);
    const auto metrics = gate.processFrame(input);
    require(metrics.open && metrics.gain == 1.0f, "disabled voice gate was not open");
    require(
      std::abs(frameRms(input) - expected_rms) < 0.000001f,
      "disabled voice gate changed output RMS"
    );
  }

  {
    syrnike::voice::VoiceGateProcessor gate(48'000);
    syrnike::voice::VoiceGateConfig gate_config;
    gate_config.enabled = true;
    gate_config.auto_threshold = false;
    gate_config.manual_threshold_db = -26.0f;
    gate_config.hysteresis_db = 6.0f;
    gate_config.attack_ms = 4;
    gate_config.hold_ms = 50;
    gate_config.release_ms = 100;
    gate_config.lookahead_ms = 0;
    gate.updateConfig(gate_config);

    auto speech = frameAtDb(-18.0f);
    const auto speech_input_rms = frameRms(speech);
    const auto speech_metrics = gate.processFrame(speech);
    require(speech_metrics.open, "manual voice gate did not open for speech");
    require(
      frameRms(speech) > speech_input_rms * 0.85f,
      "manual voice gate attack removed too much speech onset"
    );

    gate_config.manual_threshold_db = -24.0f;
    gate.updateConfig(gate_config);
    auto automated_speech = frameAtDb(-18.0f);
    require(
      gate.processFrame(automated_speech).open &&
        frameRms(automated_speech) > speech_input_rms * 0.99f,
      "manual threshold automation reset the open gate envelope"
    );

    for (int index = 0; index < 20; ++index) {
      auto hysteresis_level = frameAtDb(-29.0f);
      require(
        gate.processFrame(hysteresis_level).open,
        "manual voice gate chattered inside the hysteresis band"
      );
    }

    for (int index = 0; index < 4; ++index) {
      auto pause = frameAtDb(-50.0f);
      const auto pause_metrics = gate.processFrame(pause);
      require(pause_metrics.open, "manual voice gate closed before hold elapsed");
      require(framePeak(pause) > 0.0f, "manual hold muted its output early");
    }

    auto release_start = frameAtDb(-50.0f);
    const auto release_metrics = gate.processFrame(release_start);
    require(!release_metrics.open, "manual voice gate did not enter release after hold");
    require(
      framePeak(release_start) > 0.0f && release_metrics.gain > 0.0f,
      "manual voice gate release hard-muted a frame"
    );

    for (int index = 0; index < 9; ++index) {
      auto release = frameAtDb(-50.0f);
      gate.processFrame(release);
    }
    auto closed = frameAtDb(-50.0f);
    const auto closed_metrics = gate.processFrame(closed);
    require(!closed_metrics.open, "manual voice gate reopened below threshold");
    require(closed_metrics.gain == 0.0f, "manual voice gate release never reached zero gain");
    require(isExactSilence(closed), "manual voice gate did not produce exact digital silence");
  }

  {
    syrnike::voice::VoiceGateProcessor gate(48'000);
    syrnike::voice::VoiceGateConfig gate_config;
    gate_config.enabled = true;
    gate_config.auto_threshold = true;
    gate_config.manual_threshold_db = -28.0f;
    gate_config.auto_margin_db = 8.0f;
    gate_config.hysteresis_db = 6.0f;
    gate_config.attack_ms = 4;
    gate_config.hold_ms = 50;
    gate_config.release_ms = 100;
    gate_config.lookahead_ms = 20;
    gate.updateConfig(gate_config);

    syrnike::voice::VoiceGateFrameMetrics background_metrics;
    std::vector<float> background;
    for (int index = 0; index < 500; ++index) {
      background = frameAtDb(-30.0f);
      background_metrics = gate.processFrame(background);
    }
    require(
      background_metrics.noise_floor_db > -33.0f,
      "auto voice gate did not adapt upward to sustained background"
    );
    require(
      background_metrics.threshold_db > -26.0f,
      "auto voice gate threshold did not converge above sustained background"
    );
    require(!background_metrics.open, "auto voice gate remained open on sustained background");
    require(isExactSilence(background), "auto voice gate did not silence learned background");

    const float floor_before_transient = background_metrics.noise_floor_db;
    auto transient = frameAtDb(-8.0f);
    gate.processFrame(transient);
    for (int index = 0; index < 10; ++index) {
      auto steady_background = frameAtDb(-30.0f);
      background_metrics = gate.processFrame(steady_background);
    }
    require(
      std::abs(background_metrics.noise_floor_db - floor_before_transient) < 0.5f,
      "auto voice gate learned a short loud transient as background"
    );

    const float floor_before_speech = background_metrics.noise_floor_db;
    for (int index = 0; index < 300; ++index) {
      auto quiet_speech = frameAtDb(-18.0f);
      background_metrics = gate.processFrame(quiet_speech);
      require(background_metrics.open, "auto voice gate closed during sustained speech");
    }
    require(
      std::abs(background_metrics.noise_floor_db - floor_before_speech) < 0.5f,
      "auto voice gate learned sustained speech as background"
    );
  }

  {
    syrnike::voice::VoiceGateProcessor gate(48'000);
    syrnike::voice::VoiceGateConfig gate_config;
    gate_config.enabled = true;
    gate_config.auto_threshold = true;
    gate_config.hold_ms = 50;
    gate_config.release_ms = 50;
    gate_config.lookahead_ms = 20;
    gate.updateConfig(gate_config);

    for (int index = 0; index < 30; ++index) {
      std::vector<float> silence(syrnike::voice::kSamplesPer10Ms, 0.0f);
      gate.processFrame(silence);
      require(isExactSilence(silence), "auto lookahead leaked during closed startup");
    }

    auto onset = frameAtDb(-18.0f);
    const auto onset_input_rms = frameRms(onset);
    require(gate.processFrame(onset).open, "auto voice gate did not detect speech onset");
    require(isExactSilence(onset), "auto lookahead emitted audio before its delay elapsed");
    auto speech_second = frameAtDb(-18.0f);
    gate.processFrame(speech_second);
    auto speech_third = frameAtDb(-18.0f);
    const auto speech_third_metrics = gate.processFrame(speech_third);
    require(speech_third_metrics.gain == 1.0f, "auto voice gate attack did not finish in pre-roll");
    require(
      frameRms(speech_third) > onset_input_rms * 0.99f,
      "auto lookahead did not preserve the first speech frame"
    );

    gate_config.auto_threshold = false;
    gate_config.lookahead_ms = 0;
    gate.updateConfig(gate_config);
    auto manual_quiet = frameAtDb(-50.0f);
    const auto manual_quiet_metrics = gate.processFrame(manual_quiet);
    require(!manual_quiet_metrics.open, "mode switch leaked an open manual gate");
    require(isExactSilence(manual_quiet), "mode switch leaked buffered auto audio");
    auto manual_speech = frameAtDb(-18.0f);
    require(gate.processFrame(manual_speech).open, "manual gate stayed closed after mode switch");
    require(framePeak(manual_speech) > 0.0f, "manual gate muted speech after mode switch");

    gate_config.auto_threshold = true;
    gate_config.lookahead_ms = 20;
    gate.updateConfig(gate_config);
    auto switched_onset = frameAtDb(-18.0f);
    require(gate.processFrame(switched_onset).open, "auto gate stayed closed after mode switch");
    require(isExactSilence(switched_onset), "auto mode switch bypassed fresh lookahead");
    for (int index = 0; index < 2; ++index) {
      auto switched_speech = frameAtDb(-18.0f);
      gate.processFrame(switched_speech);
      if (index == 1) {
        require(
          frameRms(switched_speech) > onset_input_rms * 0.99f,
          "auto gate lost onset after switching modes"
        );
      }
    }
  }
  {
    syrnike::voice::RuntimeConfig gate_agc_config;
    gate_agc_config.noise_suppression_enabled = false;
    gate_agc_config.echo_cancellation_enabled = false;
    gate_agc_config.voice_gate_enabled = true;
    gate_agc_config.voice_gate_auto_threshold = false;
    gate_agc_config.voice_gate_threshold_db = -20.0f;
    gate_agc_config.automatic_gain_control_enabled = true;

    syrnike::voice::MicrophoneAudioProcessor processor;
    auto processed = processor.processFrame(frameAtDb(-10.0f), gate_agc_config, nullptr);
    require(processed.gate_metrics.open, "gate did not open before the AGC silence test");

    for (int index = 0; index < 60; ++index) {
      processed = processor.processFrame(frameAtDb(-50.0f), gate_agc_config, nullptr);
    }
    require(!processed.gate_metrics.open, "gate stayed open below the manual threshold");
    require(processed.gate_metrics.gain == 0.0f, "gate did not finish its release");
    require(
      std::all_of(processed.pcm.begin(), processed.pcm.end(), [](std::int16_t sample) {
        return sample == 0;
      }),
      "final AGC resurrected a fully closed gate"
    );
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
