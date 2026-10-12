#pragma once

#include "audio/process_loopback.hpp"
#include "livekit/livekit_screen_publication_adapter.hpp"
#include "screen/production_screen_pipeline.hpp"
#include "sources/source_registry.hpp"
#include "capture/thumbnail_admission.hpp"

namespace syrnike::windows_media::screen {

struct SelectedScreenSource {
  std::string id;
  sources::SourceKind kind = sources::SourceKind::Monitor;
  // Native-only retained identity for the independent process-audio owner.
  std::shared_ptr<audio::AudioProcessIdentity> audio_target;
};
struct ScreenOwnerSnapshot {
  MediaPathSnapshot path, preview_path;
  ProductionScreenPipelineStats pipeline;
  std::optional<SelectedScreenSource> selected_source;
  // Resolve the requested source independently of video capture/publication.
  // Process audio can therefore run even when the video preset or encoder fails.
  std::optional<SelectedScreenSource> desired_source;
  std::optional<EngineFailure> audio_target_failure;
  bool publication_stopped = true;
  bool stopped = true;
};
struct ScreenSourcesSnapshot {
  std::uint64_t revision = 0;
  sources::SourceEnumeration enumeration;
};

// One screen actor owns source enumeration, capture, encoding and publication.
// Engine control only replaces intent or reads cached bounded values.
class ScreenOwner final {
 public:
  ScreenOwner(std::shared_ptr<LiveKitRoomTransport>, capture::ThumbnailAdmission&);
  ~ScreenOwner();
  void apply(std::uint64_t revision, const ScreenIntent&,
             std::optional<std::uint64_t> room_generation);
  void beginStop();
  void stop();
  ScreenOwnerSnapshot snapshot() const;
  // Replaceable query, serviced by the actor. IDs come from this one registry.
  void querySources(std::uint64_t revision, sources::EnumerationOptions = {});
  ScreenSourcesSnapshot sources() const;
  std::shared_ptr<sources::SourceRegistry> sourceRegistry() const;
  // Existing process preview API. These calls may enter its GPU mutex and
  // must stay on the renderer bridge, never Engine's control lane.
  std::optional<PreviewFrame> takePreview(const std::string& renderer_id);
  bool releasePreview(std::uint64_t generation, std::uint64_t sequence, std::uint32_t slot);
 private:
  struct Desired {
    std::uint64_t revision = 0, publication_epoch = 0;
    ScreenIntent intent;
    std::optional<std::uint64_t> room_generation;
  };
  void run() noexcept;
  std::shared_ptr<LiveKitRoomTransport> transport_;
  capture::ThumbnailAdmission& admission_;
  std::shared_ptr<sources::SourceRegistry> registry_;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable changed_;
  Desired desired_;
  ScreenOwnerSnapshot snapshot_;
  ScreenSourcesSnapshot sources_;
  std::uint64_t query_revision_ = 0;
  sources::EnumerationOptions query_options_;
  std::optional<std::string> active_preview_renderer_;
  std::shared_ptr<ProductionScreenPipeline> pipeline_;
  std::shared_ptr<LiveKitScreenPublicationAdapter> adapter_;
  bool stopping_ = false, done_ = false;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::screen
