#include <napi.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

#include "../src/common/addon_parsing.hpp"
#include "../src/common/node_event_sink.hpp"

namespace syrnike::desktop_native {
namespace {

template <typename T>
Napi::Object numberMapToObject(
  Napi::Env env,
  const std::unordered_map<std::string, T>& values
) {
  auto result = Napi::Object::New(env);
  for (const auto& [key, value] : values) result.Set(key, value);
  return result;
}

Napi::Object projectParsedCommand(Napi::Env env, const MediaCommand& command) {
  auto result = Napi::Object::New(env);
  result.Set("type", std::string(nativeCommandName(command.type)));
  result.Set("sessionId", command.session_id);
  result.Set("generation", static_cast<double>(command.generation));
  result.Set("revision", static_cast<double>(command.revision));
  result.Set("deviceId", command.device_id);
  result.Set("kind", command.device_kind);
  result.Set("sourceId", command.source_id);
  result.Set("action", command.display_source_action);
  result.Set("enumerationId", command.display_enumeration_id);
  result.Set("page", static_cast<double>(command.display_page));
  result.Set("selfWindowHwnd", std::to_string(command.self_window_handle));
  result.Set("excludeProcessId", command.exclude_process_id);
  result.Set("electronMainPid", command.electron_main_pid);
  result.Set("muted", command.muted);
  result.Set("deafened", command.deafened);
  result.Set("force", command.force);
  result.Set("demanded", command.demanded);
  result.Set("terminal", command.terminal);
  result.Set("reason", command.internal_message);
  result.Set("trackId", command.track_id);
  result.Set("sequence", static_cast<double>(command.frame_sequence));
  result.Set("volume", command.output_volume);

  auto processing = Napi::Object::New(env);
  processing.Set("deviceId", command.device_id);
  processing.Set("noiseSuppression", command.noise_suppression);
  processing.Set("echoCancellation", command.echo_cancellation);
  processing.Set(
    "bypassSystemAudioInputProcessing",
    command.bypass_system_audio_input_processing
  );
  processing.Set("automaticGainControl", command.automatic_gain_control);
  processing.Set("inputVolume", command.input_volume);
  processing.Set("voiceGateEnabled", command.voice_gate_enabled);
  processing.Set("voiceGateThresholdDb", command.voice_gate_threshold_db);
  processing.Set("voiceGateAutoThreshold", command.voice_gate_auto_threshold);
  result.Set("config", processing);

  auto options = Napi::Object::New(env);
  options.Set("participantIdentity", command.participant_identity);
  options.Set("requestId", command.request_id);
  options.Set("audioBitrate", command.audio_bitrate);
  options.Set("muted", command.muted);
  options.Set("deviceId", command.device_id);
  options.Set("sourceId", command.source_id);
  options.Set("width", command.width);
  options.Set("height", command.height);
  options.Set("fps", command.fps);
  options.Set("bitrate", command.bitrate);
  if (command.type == NativeCommandType::ConnectMicrophone) {
    options.Set("kind", "microphone");
  } else if (command.type == NativeCommandType::StartScreenCapture) {
    options.Set("kind", "screen");
  }
  auto audio = Napi::Object::New(env);
  audio.Set("requested", command.audio_requested);
  options.Set("audio", audio);
  auto livekit = Napi::Object::New(env);
  livekit.Set("url", command.livekit_url);
  livekit.Set("token", command.livekit_token);
  livekit.Set("participantIdentity", command.participant_identity);
  options.Set("livekit", livekit);
  result.Set("options", options);

  auto settings = Napi::Object::New(env);
  settings.Set("revision", static_cast<double>(command.revision));
  settings.Set("userVolumes", numberMapToObject(env, command.user_volumes));
  settings.Set("userMutes", numberMapToObject(env, command.user_mutes));
  settings.Set("streamVolumes", numberMapToObject(env, command.stream_volumes));
  settings.Set("streamMutes", numberMapToObject(env, command.stream_mutes));
  result.Set("settings", settings);
  return result;
}

RuntimeEvent fullyPopulatedEvent(NativeEventType type) {
  RuntimeEvent event;
  event.type = type;
  event.sequence = 101;
  event.request_id = "request-event";
  event.session_id = "session-event";
  event.generation = 103;
  event.revision = 107;
  event.kind = "screen";
  event.status = "running";
  event.state = "connected";
  event.detail = "event-message";
  event.ok = false;
  event.error = NativeError{
    "event_error", "event-message", "event-stage", true,
    "session-event", 103, 109
  };
  event.devices.push_back(DeviceInfo{
    "device-event", "Device Event", "audioinput", true
  });
  DisplaySourceInfo source;
  source.id = "source-event";
  source.name = "Source Event";
  source.source_type = "screen";
  event.sources.push_back(std::move(source));
  event.participant_identities = {"participant-event"};
  event.voice_rtc_transport = VoiceRtcTransportTelemetry{
    .available = true,
    .available_outgoing_bitrate = 401'000.0,
    .available_incoming_bitrate = 402'000.0,
    .ping_ms = 40.3,
    .local_address = "127.0.0.1:4001",
    .remote_address = "203.0.113.2:4002",
    .bytes_sent = 403,
    .bytes_received = 409,
    .packets_sent = 419,
    .packets_received = 421,
    .selected_candidate_pair_id = "candidate-pair-event",
  };
  VoiceRtcStreamTelemetry outbound_video;
  outbound_video.id = "outbound-video-event";
  outbound_video.pc_role = "publisher";
  outbound_video.kind = "video";
  outbound_video.ssrc = 431;
  outbound_video.mid = "0";
  outbound_video.track_identifier = "outbound-track-event";
  outbound_video.codec = "video/VP9";
  outbound_video.target_bitrate = 433'000.0;
  outbound_video.bytes_sent = 439;
  outbound_video.packets_sent = 443;
  outbound_video.has_remote_inbound = true;
  outbound_video.packet_loss_percent = 4.49;
  outbound_video.round_trip_time_ms = 45.7;
  outbound_video.retransmitted_packets_sent = 461;
  outbound_video.retransmitted_bytes_sent = 463;
  outbound_video.nack_count = 467;
  outbound_video.fir_count = 479;
  outbound_video.pli_count = 487;
  outbound_video.frames_sent = 491;
  outbound_video.frames_encoded = 499;
  outbound_video.frames_per_second = 30.0;
  outbound_video.frame_width = 1280;
  outbound_video.frame_height = 720;
  outbound_video.quality_limitation_reason = "bandwidth";
  outbound_video.encoder_implementation = "encoder-voice-event";
  event.voice_rtc_outbound.push_back(std::move(outbound_video));

  VoiceRtcStreamTelemetry inbound_video;
  inbound_video.id = "inbound-video-event";
  inbound_video.pc_role = "subscriber";
  inbound_video.kind = "video";
  inbound_video.ssrc = 503;
  inbound_video.mid = "1";
  inbound_video.track_identifier = "inbound-video-track-event";
  inbound_video.codec = "video/AV1";
  inbound_video.bytes_received = 509;
  inbound_video.packets_received = 521;
  inbound_video.packets_lost = 2;
  inbound_video.jitter = 0.23;
  inbound_video.retransmitted_packets_received = 523;
  inbound_video.retransmitted_bytes_received = 541;
  inbound_video.packets_discarded = 547;
  inbound_video.nack_count = 557;
  inbound_video.fir_count = 563;
  inbound_video.pli_count = 569;
  inbound_video.frames_received = 571;
  inbound_video.frames_rendered = 577;
  inbound_video.frames_decoded = 587;
  inbound_video.frames_dropped = 593;
  inbound_video.frames_per_second = 29.0;
  inbound_video.frame_width = 1920;
  inbound_video.frame_height = 1080;
  inbound_video.freeze_count = 599;
  inbound_video.total_freeze_duration = 6.01;
  inbound_video.pause_count = 607;
  inbound_video.total_pause_duration = 6.13;
  inbound_video.decoder_implementation = "decoder-video-event";
  event.voice_rtc_inbound.push_back(std::move(inbound_video));

  VoiceRtcStreamTelemetry inbound_audio;
  inbound_audio.id = "inbound-audio-event";
  inbound_audio.pc_role = "subscriber";
  inbound_audio.kind = "audio";
  inbound_audio.ssrc = 617;
  inbound_audio.mid = "2";
  inbound_audio.track_identifier = "inbound-audio-track-event";
  inbound_audio.codec = "audio/opus";
  inbound_audio.bytes_received = 619;
  inbound_audio.packets_received = 631;
  inbound_audio.packets_lost = 3;
  inbound_audio.jitter = 0.37;
  inbound_audio.audio_level = 0.41;
  inbound_audio.total_audio_energy = 6.41;
  inbound_audio.total_samples_duration = 6.43;
  inbound_audio.total_samples_received = 647;
  inbound_audio.concealed_samples = 653;
  inbound_audio.silent_concealed_samples = 659;
  inbound_audio.concealment_events = 661;
  inbound_audio.jitter_buffer_delay = 6.73;
  inbound_audio.jitter_buffer_target_delay = 6.77;
  inbound_audio.jitter_buffer_emitted_count = 683;
  event.voice_rtc_inbound.push_back(std::move(inbound_audio));
  event.input = InputEvent{
    "inputDown", "keyboard", "KeyA", "A", {"KeyA"}
  };
  event.foreground_window = ForegroundWindow{
    113, "process-event", std::string("C:/process-event.exe"),
    "Window Event", "WindowClass", true, true, {1, 2, 640, 480}
  };
  event.input_db = -12.5;
  event.threshold_db = -28.5;
  event.gate_open = true;
  event.frames = 127;
  event.packets = 131;
  event.audio_frames = 137;
  event.audio_packets = 139;
  event.audio_backlog_packets = 149;
  event.audio_discontinuities = 151;
  event.audio_peak_db = -3.5;
  event.audio_rms_db = -9.5;
  event.device_id = "device-event";
  event.width = 1280;
  event.height = 720;
  event.fps = 30;
  event.bitrate = 2'000'000;
  event.native_participant_identity = "native-participant-event";
  event.capture_method = "wgc_gpu";
  event.reason = "switch_backend";
  event.error_code = "backend_error";
  event.hresult = 157;
  event.audio_mode = "process";
  event.loopback_mode = "exclude_target_process_tree";
  event.audio_target_process_id = 163;
  event.noise_suppression = "software";
  event.echo_cancellation = "software";
  event.method_wgc_gpu = 167;
  event.method_dxgi_gpu = 173;
  event.video_recoverable_lost_count = 179;
  event.video_gpu_pool_slots_available = 181;
  event.video_gpu_pool_slots_total = 191;
  event.video_dxgi_duplication_hold_us_max = 193;
  event.video_source_updates = 197;
  event.video_gpu_submissions = 199;
  event.video_idle_refreshes = 211;
  event.video_coalesced_source_updates = 223;
  event.video_encoder_backpressure_ticks = 227;
  event.video_superseded_ready_frames = 229;
  event.video_gpu_slot_timeouts = 233;
  event.video_gpu_slots_recovered = 239;
  event.video_gpu_frames_dropped_stale = 241;
  event.video_gpu_pool_rollovers = 251;
  event.video_gpu_rollovers_blocked = 257;
  event.video_gpu_retired_generations = 263;
  event.video_gpu_slots_quarantined = 269;
  event.video_preview_bridge_submissions = 271;
  event.video_preview_bridge_acquires = 277;
  event.video_preview_bridge_timeouts = 281;
  event.video_preview_bridge_slots_recovered = 283;
  event.video_preview_gpu_submissions = 293;
  event.video_preview_frames_completed = 307;
  event.video_preview_slot_timeouts = 311;
  event.video_preview_frames_dropped_stale = 313;
  event.video_preview_device_resets = 317;
  event.video_gpu_completion_p50_us = 331;
  event.video_gpu_completion_p95_us = 337;
  event.video_gpu_completion_max_us = 347;
  event.rtp_stats_available = true;
  event.rtp_packets_sent = 349;
  event.rtp_bytes_sent = 353;
  event.rtp_frames_sent = 359;
  event.rtp_frames_encoded = 367;
  event.encoder_implementation = "encoder-event";
  event.track_id = "track-event";
  event.participant_identity = "participant-event";
  event.video_source = "screen";
  event.frame_sequence = 373;
  event.timestamp_us = 379;
  event.nt_handle = 383;

  switch (type) {
    case NativeEventType::LocalScreenPreviewFailed:
      event.error->code = "LOCAL_SCREEN_PREVIEW_FAILED";
      break;
    case NativeEventType::LocalCameraPreviewFailed:
      event.error->code = "LOCAL_CAMERA_PREVIEW_FAILED";
      break;
    case NativeEventType::LocalCameraPreviewFrame:
    case NativeEventType::LocalCameraPreviewTrackRemoved:
      event.video_source = "camera";
      break;
    case NativeEventType::RemoteVideoFailed:
      event.reason = "local";
      break;
    case NativeEventType::ScreenCaptureEnded:
      event.reason = "capture-ended";
      break;
    default:
      break;
  }
  return event;
}

Napi::Value contracts(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  auto result = Napi::Array::New(env);
  std::uint32_t index = 0;
  for (const auto& policy : kNativeCommandPolicies) {
    if (policy.visibility != NativeMessageVisibility::External) continue;
    const auto* shape = nativeExternalFieldShape(policy.schema);
    if (!shape) throw std::invalid_argument("external command has no shape");
    auto row = Napi::Object::New(env);
    row.Set("direction", "command");
    row.Set("wireName", std::string(policy.wire_name));
    row.Set("shape", std::string(shape->shape));
    row.Set(
      "lane",
      policy.destination == NativeMessageDestination::Hooks
        ? "hooks"
        : std::string(mediaRuntimeTransportLane(policy))
    );
    result.Set(index++, row);
  }
  for (const auto& policy : kNativeEventPolicies) {
    if (policy.visibility != NativeMessageVisibility::External) continue;
    const auto* shape = nativeExternalFieldShape(policy.schema);
    if (!shape) throw std::invalid_argument("external event has no shape");
    auto row = Napi::Object::New(env);
    row.Set("direction", "event");
    row.Set("wireName", std::string(policy.wire_name));
    row.Set("shape", std::string(shape->shape));
    result.Set(index++, row);
  }
  return result;
}

Napi::Value parseCommandBoundary(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsObject()) {
    throw std::invalid_argument("parseCommand requires one command object");
  }
  const auto object = info[0].As<Napi::Object>();
  const auto type = parseNativeCommandType(stringField(object, "type"));
  if (!type) throw std::invalid_argument("unknown command type");
  const auto& policy = nativeCommandPolicy(*type);
  if (policy.destination == NativeMessageDestination::Hooks) {
    const auto parsed = parseHooksCommand(object);
    auto result = Napi::Object::New(info.Env());
    result.Set("type", std::string(nativeCommandName(parsed.type)));
    return result;
  }
  return projectParsedCommand(info.Env(), parseMediaCommand(object));
}

Napi::Value parseCommand(const Napi::CallbackInfo& info) {
  try {
    return parseCommandBoundary(info);
  } catch (const Napi::Error&) {
    throw;
  } catch (const std::exception& error) {
    throw Napi::TypeError::New(info.Env(), error.what());
  }
}

Napi::Value serializeEvents(const Napi::CallbackInfo& info) {
  auto result = Napi::Array::New(info.Env());
  std::uint32_t index = 0;
  for (const auto& policy : kNativeEventPolicies) {
    if (policy.visibility != NativeMessageVisibility::External) continue;
    result.Set(
      index++,
      serializeRuntimeEventForContractTest(
        info.Env(), fullyPopulatedEvent(policy.type)
      )
    );
  }
  return result;
}

Napi::Value serializeReplyVariants(const Napi::CallbackInfo& info) {
  auto result = Napi::Array::New(info.Env(), 2);
  auto failure = fullyPopulatedEvent(NativeEventType::Reply);
  failure.ok = false;
  result.Set(
    static_cast<std::uint32_t>(0),
    serializeRuntimeEventForContractTest(info.Env(), failure)
  );
  auto success = fullyPopulatedEvent(NativeEventType::Reply);
  success.ok = true;
  success.error.reset();
  success.kind = "devices";
  result.Set(
    static_cast<std::uint32_t>(1),
    serializeRuntimeEventForContractTest(info.Env(), success)
  );
  return result;
}

Napi::Value validateEventBoundary(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsObject()) {
    throw std::invalid_argument("validateEvent requires one event object");
  }
  const auto object = info[0].As<Napi::Object>();
  const auto type = parseNativeEventType(stringField(object, "type"));
  if (!type) throw std::invalid_argument("unknown event type");
  const auto& policy = nativeEventPolicy(*type);
  if (policy.visibility != NativeMessageVisibility::External) {
    throw std::invalid_argument("event type is not external");
  }
  requireNativeContractShape(object, policy.schema, false);
  return info.Env().Undefined();
}

Napi::Value validateEvent(const Napi::CallbackInfo& info) {
  try {
    return validateEventBoundary(info);
  } catch (const Napi::Error&) {
    throw;
  } catch (const std::exception& error) {
    throw Napi::TypeError::New(info.Env(), error.what());
  }
}

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("contracts", Napi::Function::New(env, contracts));
  exports.Set("parseCommand", Napi::Function::New(env, parseCommand));
  exports.Set("serializeEvents", Napi::Function::New(env, serializeEvents));
  exports.Set(
    "serializeReplyVariants",
    Napi::Function::New(env, serializeReplyVariants)
  );
  exports.Set("validateEvent", Napi::Function::New(env, validateEvent));
  return exports;
}

}  // namespace
}  // namespace syrnike::desktop_native

Napi::Object initializeNativeMessageContractAddon(
  Napi::Env env,
  Napi::Object exports
) {
  return syrnike::desktop_native::init(env, exports);
}

NODE_API_MODULE(
  syrnike_native_message_contract,
  initializeNativeMessageContractAddon
)
