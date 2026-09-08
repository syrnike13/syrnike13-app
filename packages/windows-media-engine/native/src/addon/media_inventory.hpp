#pragma once

#include <napi.h>
#include "core/windows_media_runtime.hpp"

namespace syrnike::windows_media::addon {
inline Napi::Object mediaInventory(Napi::Env env, const WindowsMediaRuntime& runtime) {
  auto inventory = Napi::Object::New(env);
  const auto microphone = runtime.microphone();
  auto meter = Napi::Object::New(env);
  meter.Set("revision", static_cast<double>(microphone.path.revision));
  meter.Set("inputLevel", microphone.pipeline.meter.input_level);
  meter.Set("gateThreshold", microphone.pipeline.meter.gate_threshold);
  meter.Set("gateOpen", microphone.pipeline.meter.gate_open);
  inventory.Set("microphoneMeter", meter);
  const auto audio = runtime.audioDevices();
  auto audio_catalog = Napi::Object::New(env);
  audio_catalog.Set("revision", static_cast<double>(audio.revision));
  audio_catalog.Set("status", audio.status == audio::AudioRegistryStatus::ready ? "ready" :
      audio.status == audio::AudioRegistryStatus::capacity_exceeded ? "capacity_exceeded" : "enumeration_failed");
  auto audio_devices = Napi::Array::New(env, audio.devices.size());
  for (std::size_t index = 0; index < audio.devices.size(); ++index) {
    const auto& device = audio.devices[index];
    auto value = Napi::Object::New(env);
    value.Set("id", std::to_string(device.id));
    value.Set("label", device.label.substr(0, 512));
    value.Set("direction", device.direction == audio::AudioDirection::input ? "input" : "output");
    value.Set("isDefault", device.is_default);
    audio_devices.Set(static_cast<std::uint32_t>(index), value);
  }
  audio_catalog.Set("devices", audio_devices);
  inventory.Set("audio", audio_catalog);

  const auto cameras = runtime.cameraDevices();
  auto camera_catalog = Napi::Object::New(env);
  camera_catalog.Set("revision", static_cast<double>(cameras.revision));
  camera_catalog.Set("status", cameras.status == camera::CameraRegistryStatus::ready ? "ready" :
      cameras.status == camera::CameraRegistryStatus::capacity_exceeded ? "capacity_exceeded" : "enumeration_failed");
  auto camera_devices = Napi::Array::New(env, cameras.devices.size());
  for (std::size_t index = 0; index < cameras.devices.size(); ++index) {
    const auto& device = cameras.devices[index];
    auto value = Napi::Object::New(env);
    value.Set("id", std::to_string(device.id));
    value.Set("label", device.label.substr(0, 512));
    value.Set("available", device.available);
    value.Set("isDefault", device.is_default);
    camera_devices.Set(static_cast<std::uint32_t>(index), value);
  }
  camera_catalog.Set("devices", camera_devices);
  inventory.Set("cameras", camera_catalog);

  const auto sources = runtime.screenSources();
  auto source_catalog = Napi::Object::New(env);
  source_catalog.Set("revision", static_cast<double>(sources.revision));
  source_catalog.Set("complete", sources.enumeration.complete);
  source_catalog.Set("ok", sources.enumeration.ok);
  source_catalog.Set("truncated", sources.enumeration.monitors_truncated || sources.enumeration.windows_truncated);
  auto source_entries = Napi::Array::New(env, sources.enumeration.sources.size());
  for (std::size_t index = 0; index < sources.enumeration.sources.size(); ++index) {
    const auto& source = sources.enumeration.sources[index];
    auto value = Napi::Object::New(env);
    value.Set("id", source.id);
    value.Set("kind", source.kind == sources::SourceKind::Monitor ? "monitor" : "window");
    value.Set("title", source.title);
    value.Set("label", source.label);
    value.Set("available", source.availability == sources::SourceAvailability::Available);
    value.Set("audioAvailable", audio::processLoopbackSupported());
    value.Set("minimized", source.flags.minimized);
    value.Set("primary", source.flags.primary);
    source_entries.Set(static_cast<std::uint32_t>(index), value);
  }
  source_catalog.Set("entries", source_entries);
  inventory.Set("sources", source_catalog);

  const auto video = runtime.remoteVideo();
  auto video_catalog = Napi::Object::New(env);
  video_catalog.Set("revision", static_cast<double>(video.inventory_revision));
  auto publications = Napi::Array::New(env, video.publications.size());
  for (std::size_t index = 0; index < video.publications.size(); ++index) {
    const auto& publication = video.publications[index];
    auto value = Napi::Object::New(env);
    value.Set("participantIdentity", publication.participant_identity);
    value.Set("publicationId", publication.publication_id);
    value.Set("source", publication.screen ? "screen" : "camera");
    publications.Set(static_cast<std::uint32_t>(index), value);
  }
  video_catalog.Set("publications", publications);
  inventory.Set("video", video_catalog);
  return inventory;
}
}  // namespace syrnike::windows_media::addon
