#pragma once

#include <napi.h>
#include "video/frame_export_owner.hpp"
#include "addon/media_codecs.generated.hpp"

namespace syrnike::windows_media::addon {
inline std::vector<video::ExportRelease> readReleases(Napi::Env env, const Napi::Value& value) {
  return media_codec::readArray<video::ExportRelease>(env, value, video::FrameExportOwner::kCapacity,
      [](Napi::Env env, const Napi::Value& value) {
        const auto object = media_codec::readObject(env, value);
        return video::ExportRelease{
            static_cast<std::uint64_t>(media_codec::readNumber(env, object.Get("generation"), 1, 9007199254740991.0, true)),
            static_cast<std::uint64_t>(media_codec::readNumber(env, object.Get("sequence"), 1, 9007199254740991.0, true)),
            static_cast<std::uint32_t>(media_codec::readNumber(env, object.Get("slot"), 0, 3, true))};
      });
}
inline Napi::Array exportedFrames(Napi::Env env, const std::vector<video::ExportedFrame>& frames) {
  auto array = Napi::Array::New(env, frames.size());
  for (std::size_t index = 0; index < frames.size(); ++index) {
    const auto& frame = frames[index];
    auto object = Napi::Object::New(env);
    object.Set("kind", frame.kind == video::ExportKind::remote ? "remote" :
        frame.kind == video::ExportKind::screen_preview ? "screen_preview" : "camera_preview");
    object.Set("generation", static_cast<double>(frame.generation));
    object.Set("sequence", static_cast<double>(frame.sequence));
    object.Set("revision", static_cast<double>(frame.revision));
    object.Set("slot", frame.slot);
    object.Set("width", frame.width);
    object.Set("height", frame.height);
    object.Set("timestamp", static_cast<double>((std::max)(std::int64_t{0}, frame.timestamp_us)));
    object.Set("ingressUs", static_cast<double>((std::max)(std::int64_t{0}, frame.ingress_us)));
    object.Set("handle", static_cast<double>(frame.handle));
    object.Set("rendererId", frame.renderer_id);
    object.Set("publicationId", frame.publication_id);
    object.Set("participantIdentity", frame.participant_identity);
    array.Set(static_cast<std::uint32_t>(index), object);
  }
  return array;
}
}  // namespace syrnike::windows_media::addon
