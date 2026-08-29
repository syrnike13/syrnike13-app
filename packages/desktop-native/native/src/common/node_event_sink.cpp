#include "node_event_sink.hpp"

#include "addon_parsing.hpp"

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
  if (event.type == NativeEventType::ActiveSpeakers || !event.participant_identities.empty()) {
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
  stats.Set("videoGpuSlotTimeouts", jsNumber(env, event.video_gpu_slot_timeouts));
  stats.Set("videoGpuSlotsRecovered", jsNumber(env, event.video_gpu_slots_recovered));
  stats.Set(
      "videoGpuFramesDroppedStale",
      jsNumber(env, event.video_gpu_frames_dropped_stale));
  stats.Set("videoGpuPoolRollovers", jsNumber(env, event.video_gpu_pool_rollovers));
  stats.Set(
      "videoGpuRolloversBlocked",
      jsNumber(env, event.video_gpu_rollovers_blocked));
  stats.Set(
      "videoGpuRetiredGenerations",
      jsNumber(env, event.video_gpu_retired_generations));
  stats.Set(
      "videoGpuSlotsQuarantined",
      jsNumber(env, event.video_gpu_slots_quarantined));
  stats.Set(
      "videoPreviewBridgeSubmissions",
      jsNumber(env, event.video_preview_bridge_submissions));
  stats.Set(
      "videoPreviewBridgeAcquires",
      jsNumber(env, event.video_preview_bridge_acquires));
  stats.Set(
      "videoPreviewBridgeTimeouts",
      jsNumber(env, event.video_preview_bridge_timeouts));
  stats.Set(
      "videoPreviewBridgeSlotsRecovered",
      jsNumber(env, event.video_preview_bridge_slots_recovered));
  stats.Set(
      "videoPreviewGpuSubmissions",
      jsNumber(env, event.video_preview_gpu_submissions));
  stats.Set(
      "videoPreviewFramesCompleted",
      jsNumber(env, event.video_preview_frames_completed));
  stats.Set(
      "videoPreviewSlotTimeouts",
      jsNumber(env, event.video_preview_slot_timeouts));
  stats.Set(
      "videoPreviewFramesDroppedStale",
      jsNumber(env, event.video_preview_frames_dropped_stale));
  stats.Set(
      "videoPreviewDeviceResets",
      jsNumber(env, event.video_preview_device_resets));
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
    stats.Set(
        "audioBacklogPackets",
        jsNumber(env, event.audio_backlog_packets));
    stats.Set(
        "audioDiscontinuities",
        jsNumber(env, event.audio_discontinuities));
    stats.Set("audioPeakDb", event.audio_peak_db);
    stats.Set("audioRmsDb", event.audio_rms_db);
  }
  return stats;
}

Napi::Object voiceRtcStreamToObject(
  Napi::Env env,
  const VoiceRtcStreamTelemetry& stream,
  bool outbound
) {
  auto result = Napi::Object::New(env);
  result.Set("id", stream.id);
  result.Set("pcRole", stream.pc_role);
  result.Set("kind", stream.kind);
  if (stream.ssrc > 0) result.Set("ssrc", stream.ssrc);
  setIfPresent(result, "mid", stream.mid);
  setIfPresent(result, "trackIdentifier", stream.track_identifier);
  setIfPresent(result, "codec", stream.codec);
  if (stream.target_bitrate > 0.0) {
    result.Set("targetBitrate", stream.target_bitrate);
  }
  result.Set("nackCount", stream.nack_count);
  result.Set("firCount", stream.fir_count);
  result.Set("pliCount", stream.pli_count);
  if (outbound) {
    result.Set("bytesSent", jsNumber(env, stream.bytes_sent));
    result.Set("packetsSent", jsNumber(env, stream.packets_sent));
    result.Set(
      "retransmittedPacketsSent",
      jsNumber(env, stream.retransmitted_packets_sent)
    );
    result.Set(
      "retransmittedBytesSent",
      jsNumber(env, stream.retransmitted_bytes_sent)
    );
    if (stream.has_remote_inbound) {
      result.Set("packetLossPercent", stream.packet_loss_percent);
      result.Set("roundTripTimeMs", stream.round_trip_time_ms);
    }
    if (stream.kind == "video") {
      result.Set("framesSent", stream.frames_sent);
      result.Set("framesEncoded", stream.frames_encoded);
      result.Set("framesPerSecond", stream.frames_per_second);
      result.Set("frameWidth", stream.frame_width);
      result.Set("frameHeight", stream.frame_height);
      setIfPresent(
        result,
        "qualityLimitationReason",
        stream.quality_limitation_reason
      );
      setIfPresent(
        result,
        "encoderImplementation",
        stream.encoder_implementation
      );
    }
    return result;
  }

  result.Set("bytesReceived", jsNumber(env, stream.bytes_received));
  result.Set("packetsReceived", jsNumber(env, stream.packets_received));
  result.Set("packetsLost", static_cast<double>(stream.packets_lost));
  result.Set("jitter", stream.jitter);
  result.Set(
    "retransmittedPacketsReceived",
    jsNumber(env, stream.retransmitted_packets_received)
  );
  result.Set(
    "retransmittedBytesReceived",
    jsNumber(env, stream.retransmitted_bytes_received)
  );
  result.Set("packetsDiscarded", jsNumber(env, stream.packets_discarded));
  if (stream.kind == "video") {
    result.Set("framesReceived", jsNumber(env, stream.frames_received));
    result.Set("framesRendered", stream.frames_rendered);
    result.Set("framesDecoded", stream.frames_decoded);
    result.Set("framesDropped", stream.frames_dropped);
    result.Set("framesPerSecond", stream.frames_per_second);
    result.Set("frameWidth", stream.frame_width);
    result.Set("frameHeight", stream.frame_height);
    result.Set("freezeCount", stream.freeze_count);
    result.Set("totalFreezesDuration", stream.total_freeze_duration);
    result.Set("pauseCount", stream.pause_count);
    result.Set("totalPauseDuration", stream.total_pause_duration);
    setIfPresent(
      result,
      "decoderImplementation",
      stream.decoder_implementation
    );
  } else {
    result.Set("audioLevel", stream.audio_level);
    result.Set("totalAudioEnergy", stream.total_audio_energy);
    result.Set("totalSamplesDuration", stream.total_samples_duration);
    result.Set(
      "totalSamplesReceived",
      jsNumber(env, stream.total_samples_received)
    );
    result.Set("concealedSamples", jsNumber(env, stream.concealed_samples));
    result.Set(
      "silentConcealedSamples",
      jsNumber(env, stream.silent_concealed_samples)
    );
    result.Set(
      "concealmentEvents",
      jsNumber(env, stream.concealment_events)
    );
    result.Set("jitterBufferDelay", stream.jitter_buffer_delay);
    result.Set(
      "jitterBufferTargetDelay",
      stream.jitter_buffer_target_delay
    );
    result.Set(
      "jitterBufferEmittedCount",
      jsNumber(env, stream.jitter_buffer_emitted_count)
    );
  }
  return result;
}

Napi::Array deviceEventsToArray(
  Napi::Env env,
  const std::vector<DeviceInfo>& devices
) {
  auto result = Napi::Array::New(env, devices.size());
  for (std::size_t index = 0; index < devices.size(); ++index) {
    const auto& device = devices[index];
    auto value = Napi::Object::New(env);
    value.Set("deviceId", device.device_id);
    value.Set("label", device.label);
    value.Set("kind", device.kind);
    result.Set(static_cast<std::uint32_t>(index), value);
  }
  return result;
}

Napi::Array displaySourceEventsToArray(
  Napi::Env env,
  const std::vector<DisplaySourceInfo>& sources
) {
  auto result = Napi::Array::New(env, sources.size());
  for (std::size_t index = 0; index < sources.size(); ++index) {
    const auto& source = sources[index];
    auto value = Napi::Object::New(env);
    value.Set("id", source.id);
    value.Set("name", source.name);
    value.Set("type", source.source_type);
    result.Set(static_cast<std::uint32_t>(index), value);
  }
  return result;
}

Napi::Object voiceRtcStatsToObject(Napi::Env env, const RuntimeEvent& event) {
  auto stats = Napi::Object::New(env);
  auto transport = Napi::Object::New(env);
  if (event.voice_rtc_transport.available) {
    transport.Set(
      "availableOutgoingBitrate",
      event.voice_rtc_transport.available_outgoing_bitrate
    );
    transport.Set(
      "availableIncomingBitrate",
      event.voice_rtc_transport.available_incoming_bitrate
    );
    transport.Set("pingMs", event.voice_rtc_transport.ping_ms);
    transport.Set(
      "bytesSent",
      jsNumber(env, event.voice_rtc_transport.bytes_sent)
    );
    transport.Set(
      "bytesReceived",
      jsNumber(env, event.voice_rtc_transport.bytes_received)
    );
    transport.Set(
      "packetsSent",
      jsNumber(env, event.voice_rtc_transport.packets_sent)
    );
    transport.Set(
      "packetsReceived",
      jsNumber(env, event.voice_rtc_transport.packets_received)
    );
    setIfPresent(
      transport,
      "localAddress",
      event.voice_rtc_transport.local_address
    );
    setIfPresent(
      transport,
      "remoteAddress",
      event.voice_rtc_transport.remote_address
    );
    setIfPresent(
      transport,
      "selectedCandidatePairId",
      event.voice_rtc_transport.selected_candidate_pair_id
    );
  }
  stats.Set("transport", transport);

  auto outbound = Napi::Array::New(env, event.voice_rtc_outbound.size());
  for (std::size_t index = 0; index < event.voice_rtc_outbound.size(); ++index) {
    outbound.Set(
      static_cast<std::uint32_t>(index),
      voiceRtcStreamToObject(env, event.voice_rtc_outbound[index], true)
    );
  }
  stats.Set("outbound", outbound);

  auto inbound = Napi::Array::New(env, event.voice_rtc_inbound.size());
  for (std::size_t index = 0; index < event.voice_rtc_inbound.size(); ++index) {
    inbound.Set(
      static_cast<std::uint32_t>(index),
      voiceRtcStreamToObject(env, event.voice_rtc_inbound[index], false)
    );
  }
  stats.Set("inbound", inbound);
  return stats;
}

Napi::Object eventToObject(Napi::Env env, const RuntimeEvent& event) {
  if (!isValidNativeEventType(event.type)) {
    throw std::invalid_argument(
      "runtime event is absent from the typed serialization policy"
    );
  }
  const auto& policy = nativeEventPolicy(event.type);
  const auto* codec = nativeEventCodecBinding(event.type);
  if (!codec || codec->schema != policy.schema ||
      codec->action != policy.action || codec->payload != policy.payload) {
    throw std::invalid_argument(
      "runtime event has no concrete schema or codec binding"
    );
  }
  const auto serialization_profile = codec->payload;
  auto result = Napi::Object::New(env);
  result.Set("type", std::string(policy.wire_name));
  if (nativeExternalHasTopLevelField(
        policy.schema, NativeExternalTopLevelField::Sequence
      )) {
    result.Set("sequence", jsNumber(env, event.sequence));
  }
  if (nativeExternalHasTopLevelField(
        policy.schema, NativeExternalTopLevelField::RequestId
      )) {
    setIfPresent(result, "requestId", event.request_id);
  }
  if (nativeExternalHasTopLevelField(
        policy.schema, NativeExternalTopLevelField::Kind
      )) {
    setIfPresent(result, "kind", event.kind);
  }
  if (nativeExternalHasTopLevelField(
        policy.schema, NativeExternalTopLevelField::TrackId
      )) {
    setIfPresent(result, "trackId", event.track_id);
  }

  if (serialization_profile == NativePayloadProfile::Reply) {
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
      } else if (event.kind == "voiceControlProbe") {
        auto probe = Napi::Object::New(env);
        probe.Set("state", event.voice_control_worker_state);
        probe.Set("hostEpoch", jsNumber(env, event.voice_control_host_epoch));
        probe.Set(
          "queueDepth",
          jsNumber(env, event.voice_control_queue_depth)
        );
        probe.Set(
          "queueCapacity",
          jsNumber(env, event.voice_control_queue_capacity)
        );
        probe.Set(
          "oldestQueueWaitMs",
          jsNumber(env, event.voice_control_oldest_queue_wait_ms)
        );
        probe.Set(
          "lastQueueWaitMs",
          jsNumber(env, event.voice_control_last_queue_wait_ms)
        );
        if (event.voice_control_current_operation.empty()) {
          probe.Set("currentOperation", env.Null());
        } else {
          probe.Set(
            "currentOperation",
            event.voice_control_current_operation
          );
        }
        probe.Set(
          "currentOperationAgeMs",
          jsNumber(env, event.voice_control_current_operation_age_ms)
        );
        probe.Set("retirementState", event.voice_control_retirement_state);
        probe.Set(
          "outstandingRendererLeases",
          jsNumber(env, event.voice_control_outstanding_renderer_leases)
        );
        probe.Set(
          "outstandingRendererGenerations",
          jsNumber(env, event.voice_control_outstanding_renderer_generations)
        );
        probe.Set(
          "duplicateCommands",
          jsNumber(env, event.voice_control_duplicate_commands)
        );
        probe.Set(
          "rejectedCommands",
          jsNumber(env, event.voice_control_rejected_commands)
        );
        probe.Set("workerOwner", event.voice_control_worker_owner);
        probe.Set("retirementOwner", event.voice_control_retirement_owner);
        result.Set("result", probe);
      }
    } else if (event.error) {
      result.Set("error", errorToObject(env, *event.error));
    }
#if defined(SYRNIKE_NATIVE_CONTRACT_RUNTIME_VALIDATION)
    requireNativeContractShape(result, policy.schema, false);
#endif
    return result;
  }

  if (nativeExternalHasTopLevelField(
        policy.schema, NativeExternalTopLevelField::SessionId
      )) {
    setIfPresent(result, "sessionId", event.session_id);
  }
  if (nativeExternalHasTopLevelField(
        policy.schema, NativeExternalTopLevelField::Generation
      ) &&
      !event.session_id.empty()) {
    result.Set("generation", jsNumber(env, event.generation));
  }
  if (nativeExternalHasTopLevelField(
        policy.schema, NativeExternalTopLevelField::Error
      ) && event.error) {
    result.Set("error", errorToObject(env, *event.error));
  }
  switch (serialization_profile) {
    case NativePayloadProfile::SessionLifecycle:
      result.Set("state", lifecycleStateToObject(env, event));
      break;
    case NativePayloadProfile::SessionStarted:
      result.Set("session", sessionToObject(env, event));
      break;
    case NativePayloadProfile::SessionStopped:
      setIfPresent(result, "reason", event.reason);
      break;
    case NativePayloadProfile::VoiceConnectionState:
      result.Set("state", event.state);
      break;
    case NativePayloadProfile::ScreenStatistics:
      result.Set("stats", statsToObject(env, event));
      break;
    case NativePayloadProfile::VoiceStatistics:
      result.Set("stats", voiceRtcStatsToObject(env, event));
      break;
    case NativePayloadProfile::ScreenBackendRestart:
      result.Set("backend", event.capture_method);
      result.Set("reason", event.reason);
      result.Set("count", jsNumber(env, event.video_recoverable_lost_count));
      setIfPresent(result, "errorCode", event.error_code);
      if (event.hresult) {
        result.Set("hresult", Napi::Number::New(
            env, static_cast<double>(*event.hresult)));
      }
      break;
    case NativePayloadProfile::MicrophoneMetrics: {
      auto metrics = Napi::Object::New(env);
      metrics.Set("revision", static_cast<double>(event.revision.value_or(0)));
      metrics.Set("inputDb", event.input_db);
      metrics.Set("thresholdDb", event.threshold_db);
      metrics.Set("open", event.gate_open);
      result.Set("metrics", metrics);
      break;
    }
    case NativePayloadProfile::MicrophonePreviewStarted: {
      auto preview = Napi::Object::New(env);
      preview.Set("sessionId", event.session_id);
      result.Set("preview", preview);
      break;
    }
    case NativePayloadProfile::Input:
      if (event.input) result.Set("input", inputToObject(env, *event.input));
      break;
    case NativePayloadProfile::ForegroundWindow:
      if (event.foreground_window) {
        result.Set("window", foregroundWindowToObject(env, *event.foreground_window));
      }
      break;
    case NativePayloadProfile::VideoFrame: {
      result.Set("participantIdentity", event.participant_identity);
      result.Set("source", event.video_source);
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
      break;
    }
    case NativePayloadProfile::RemoteVideoPublication:
      result.Set("participantIdentity", event.participant_identity);
      result.Set("source", event.video_source);
      break;
    case NativePayloadProfile::LocalVideoTrackRemoved:
      result.Set("source", event.video_source);
      break;
    case NativePayloadProfile::RemoteVideoFailed:
      result.Set("source", event.video_source);
      setIfPresent(result, "reason", event.reason);
      break;
    case NativePayloadProfile::ActiveSpeakers: {
      auto participants = Napi::Array::New(env, event.participant_identities.size());
      for (std::size_t index = 0; index < event.participant_identities.size(); ++index) {
        participants.Set(
          static_cast<std::uint32_t>(index),
          event.participant_identities[index]
        );
      }
      result.Set("participantIdentities", participants);
      break;
    }
    case NativePayloadProfile::ScreenCaptureEnded:
      result.Set("reason", event.reason);
      setIfPresent(result, "message", event.detail);
      break;
    case NativePayloadProfile::Devices:
      result.Set("devices", deviceEventsToArray(env, event.devices));
      break;
    case NativePayloadProfile::DisplaySources:
      result.Set("sources", displaySourceEventsToArray(env, event.sources));
      break;
    case NativePayloadProfile::Generic:
    case NativePayloadProfile::Lifecycle:
    case NativePayloadProfile::Session:
    case NativePayloadProfile::VideoPublication:
    case NativePayloadProfile::Statistics:
    case NativePayloadProfile::Configuration:
    case NativePayloadProfile::RemoteVideoTrackRemoved:
    case NativePayloadProfile::Reply:
      break;
  }
#if defined(SYRNIKE_NATIVE_CONTRACT_RUNTIME_VALIDATION)
  requireNativeContractShape(result, policy.schema, false);
#endif
  return result;
}

}  // namespace

Napi::Object serializeRuntimeEventForContractTest(
  Napi::Env env,
  const RuntimeEvent& event
) {
  return eventToObject(env, event);
}

namespace {

void logJsListenerFailure(
  const RuntimeEvent& event,
  const std::string& message
) noexcept {
  try {
    diagnostics::DiagnosticLog::instance().write(
      "native_event_listener_exception",
      {
        {"eventType", std::string(nativeEventName(event.type))},
        {"message", diagnostics::redactForDiagnostics(message)}
      }
    );
  } catch (...) {
  }
}

void raiseLosslessDeliveryFailure(
  Napi::Env env,
  const RuntimeEvent& event,
  const std::string& message
) noexcept {
  if (env == nullptr) return;
  try {
    if (env.IsExceptionPending()) {
      static_cast<void>(env.GetAndClearPendingException());
    }
    auto error = Napi::Error::New(
      env,
      "Native lossless event delivery failed: " +
        std::string(nativeEventName(event.type)) + ": " + message
    );
    error.Value().Set("code", "native_control_delivery_lost");
    error.Value().Set("stage", "nativeEventDelivery");
    error.ThrowAsJavaScriptException();
  } catch (...) {
    // Leaving the utility host without a replacement exception is still
    // observable through diagnostics and its liveness watchdog.
  }
}

bool deliverEventToJs(
  Napi::Env env,
  Napi::Function callback,
  RuntimeEvent& event
) {
  const bool lossless = eventLane(event) == EventLane::control;
  if (env == nullptr || callback.IsEmpty()) {
    discardEvent(event);
    logJsListenerFailure(event, "native event callback is unavailable");
    if (lossless) {
      raiseLosslessDeliveryFailure(
        env,
        event,
        "native event callback is unavailable"
      );
    }
    return false;
  }
  Napi::Object value;
  try {
    value = eventToObject(env, event);
  } catch (const std::exception& error) {
    discardEvent(event);
    logJsListenerFailure(event, error.what());
    if (lossless) raiseLosslessDeliveryFailure(env, event, error.what());
    return false;
  } catch (...) {
    discardEvent(event);
    logJsListenerFailure(event, "native event serialization failed");
    if (lossless) {
      raiseLosslessDeliveryFailure(
        env,
        event,
        "native event serialization failed"
      );
    }
    return false;
  }
  try {
    callback.Call({value});
  } catch (const Napi::Error& error) {
    discardEvent(event);
    logJsListenerFailure(event, error.Message());
    if (lossless) {
      raiseLosslessDeliveryFailure(env, event, error.Message());
      return false;
    }
    if (env.IsExceptionPending()) {
      static_cast<void>(env.GetAndClearPendingException());
    }
    return true;
  } catch (const std::exception& error) {
    discardEvent(event);
    logJsListenerFailure(event, error.what());
    if (lossless) {
      raiseLosslessDeliveryFailure(env, event, error.what());
      return false;
    }
    if (env.IsExceptionPending()) {
      static_cast<void>(env.GetAndClearPendingException());
    }
    return true;
  } catch (...) {
    discardEvent(event);
    logJsListenerFailure(event, "unknown JS listener exception");
    if (lossless) {
      raiseLosslessDeliveryFailure(
        env,
        event,
        "unknown JS listener exception"
      );
      return false;
    }
    if (env.IsExceptionPending()) {
      static_cast<void>(env.GetAndClearPendingException());
    }
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
        {"eventType", std::string(nativeEventName(event.type))},
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
  for (std::size_t index = 0; index < events.size(); ++index) {
    auto& event = events[index];
    if (!event) continue;
    if (deliverEventToJs(env, callback, *event)) continue;
    discardEventBatch(events, index + 1);
    break;
  }
}

}  // namespace

NodeEventSink::NodeEventSink(
  Napi::Env env,
  Napi::Function callback,
  const char* resource_name
) : fatal_payload_(std::make_unique<RuntimeEvent>()),
    control_callback_(Napi::ThreadSafeFunction::New(
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
    realtime_callback_(Napi::ThreadSafeFunction::New(
      env,
      callback,
      std::string(resource_name) + "-realtime",
      1,
      1
    )),
    fatal_callback_(Napi::ThreadSafeFunction::New(
      env,
      callback,
      std::string(resource_name) + "-fatal",
      1,
      1
    )),
    control_lane_(std::make_shared<ControlEventLane>(controlLaneCapacity())),
    media_lane_(std::make_shared<CoalescingEventLane>()),
    realtime_lane_(std::make_shared<CoalescingEventLane>()) {
  // Runtime-loss escalation is the last line of defence after a control event
  // has already been accepted. Allocate its payload while the sink is being
  // constructed so memory pressure cannot silently suppress that escalation.
  fatal_payload_->type = NativeEventType::RuntimeError;
  fatal_payload_->error = NativeError{
    "native_control_delivery_lost",
    "A lossless native control event could not be delivered",
    "nativeEventDelivery",
    true,
  };
}

NodeEventSink::~NodeEventSink() {
  try {
    close();
  } catch (...) {
  }
}

void NodeEventSink::scheduleRuntimeLoss(
  std::uint64_t sequence,
  const char* reason
) noexcept {
  RuntimeEvent* payload = nullptr;
  try {
    std::lock_guard lock(fatal_mutex_);
    if (fatal_scheduled_ || !fatal_payload_) return;
    fatal_scheduled_ = true;
    fatal_payload_->sequence = sequence;
    payload = fatal_payload_.release();
  } catch (...) {
    // The payload and its strings are preallocated. Reaching this branch means
    // even the non-allocating escalation path is unusable, so the utility host
    // must fail closed instead of continuing with a lost control transition.
  }
  if (!payload) {
    if (!closed_.load(std::memory_order_acquire)) {
      napi_fatal_error(
        "NodeEventSink::scheduleRuntimeLoss",
        NAPI_AUTO_LENGTH,
        "Native lossless event escalation failed",
        NAPI_AUTO_LENGTH
      );
    }
    return;
  }
  try {
    diagnostics::DiagnosticLog::instance().write(
      "native_event_runtime_loss_scheduled",
      {{"reason", reason ? reason : "unknown"}, {"sequence", sequence}}
    );
  } catch (...) {
  }
  napi_status status = napi_generic_failure;
  try {
    status = fatal_callback_.NonBlockingCall(payload, callEventCallback);
  } catch (...) {
  }
  if (status == napi_ok) return;
  delete payload;
  if (!closed_.load(std::memory_order_acquire)) {
    napi_fatal_error(
      "NodeEventSink::scheduleRuntimeLoss",
      NAPI_AUTO_LENGTH,
      "Native lossless event escalation could not reach JavaScript",
      NAPI_AUTO_LENGTH
    );
  }
}

bool NodeEventSink::emit(RuntimeEvent event) {
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
      if (!closed_.load(std::memory_order_acquire)) {
        scheduleRuntimeLoss(
          event_sequence,
          "Lossless native event staging allocation failed"
        );
      }
      return false;
    } catch (...) {
      logJsListenerFailure(event, "control event staging failed");
      if (!closed_.load(std::memory_order_acquire)) {
        scheduleRuntimeLoss(
          event_sequence,
          "Lossless native event staging failed"
        );
      }
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
      if (pushed.timed_out) {
        std::lock_guard lifecycle_lock(lifecycle_mutex_);
        if (!closed_.load(std::memory_order_acquire)) {
          scheduleRuntimeLoss(
            event_sequence,
            "Lossless native event exceeded its bounded staging deadline"
          );
        }
      }
      return false;
    }
    if (!pushed.schedule_callback) return true;
    std::lock_guard lifecycle_lock(lifecycle_mutex_);
    if (closed_.load(std::memory_order_acquire)) {
      control_lane_->rejectScheduledCallbackAndDiscard(event_sequence);
      return false;
    }
    auto* lane_payload = new (std::nothrow)
      std::shared_ptr<ControlEventLane>(control_lane_);
    if (!lane_payload) {
      control_lane_->rejectScheduledCallbackAndDiscard(event_sequence);
      scheduleRuntimeLoss(
        event_sequence,
        "Lossless native event callback allocation failed"
      );
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
    scheduleRuntimeLoss(
      event_sequence,
      "Lossless native event callback could not be scheduled"
    );
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
  if (lane == EventLane::media || lane == EventLane::realtime) {
    auto event_lane = lane == EventLane::media ? media_lane_ : realtime_lane_;
    auto* callback = lane == EventLane::media
      ? &media_callback_
      : &realtime_callback_;
    CoalescingEventLane::PushResult pushed;
    try {
      pushed = event_lane->push(std::move(event));
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
    std::lock_guard lifecycle_lock(lifecycle_mutex_);
    if (closed_.load(std::memory_order_acquire)) {
      event_lane->cancelScheduledCallbackAndDiscard();
      return true;
    }
    std::shared_ptr<CoalescingEventLane>* lane_payload = nullptr;
    napi_status status = napi_generic_failure;
    try {
      lane_payload = new std::shared_ptr<CoalescingEventLane>(event_lane);
      status = callback->NonBlockingCall(
        lane_payload, callMediaEventCallback
      );
    } catch (...) {
      status = napi_generic_failure;
    }
    if (status == napi_ok) return true;
    delete lane_payload;
    event_lane->cancelScheduledCallbackAndDiscard();
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
  std::lock_guard lifecycle_lock(lifecycle_mutex_);
  if (closed_.load(std::memory_order_acquire)) {
    discardEvent(*payload);
    delete payload;
    return true;
  }
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
      case EventLane::realtime:
        status = napi_generic_failure;
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
  realtime_lane_->closeAndDiscard();
  if (!media_lane_->waitForInFlightCallbacks(std::chrono::seconds(5))) {
    try {
      diagnostics::DiagnosticLog::instance().write(
        "native_event_media_callback_shutdown_timeout"
      );
    } catch (...) {
    }
  }
  if (!realtime_lane_->waitForInFlightCallbacks(std::chrono::seconds(5))) {
    try {
      diagnostics::DiagnosticLog::instance().write(
        "native_event_realtime_callback_shutdown_timeout"
      );
    } catch (...) {
    }
  }
  try { realtime_callback_.Release(); } catch (...) {}
  try { fatal_callback_.Release(); } catch (...) {}
  try { metrics_callback_.Release(); } catch (...) {}
  try { media_callback_.Release(); } catch (...) {}
  try { control_callback_.Release(); } catch (...) {}
}

}  // namespace syrnike::desktop_native
