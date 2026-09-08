#include "video/frame_export_owner.hpp"

#include <algorithm>
#include <set>

namespace syrnike::windows_media::video {
namespace {
using namespace std::chrono_literals;
std::string streamKey(const ExportedFrame& frame) {
  return std::to_string(static_cast<int>(frame.kind)) + ":" + frame.publication_id;
}
}  // namespace
FrameExportOwner::FrameExportOwner(camera::CameraOwner& camera, screen::ScreenOwner& screen,
                                   RemoteVideoOwner& video)
    : camera_(camera), screen_(screen), video_(video), worker_([this] { run(); }) {}
FrameExportOwner::~FrameExportOwner() { stop(); }
void FrameExportOwner::apply(const EngineDesiredState& desired, bool room_connected) {
  std::lock_guard lock(mutex_);
  if (stopping_ || desired.revision < desired_.revision) return;
  desired_ = {desired.revision, desired.renderer_id,
      desired.room ? desired.room->participant_identity : "local",
      desired.camera.state == CameraIntentState::on && desired.camera.preview_renderer_id.has_value(),
      desired.screen.state == ScreenIntentState::on && desired.screen.preview_renderer_id.has_value(),
      desired.remote_video_demand};
  room_connected_ = room_connected;
  changed_.notify_one();
}
void FrameExportOwner::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  changed_.notify_one();
}
void FrameExportOwner::stop() {
  std::lock_guard join_lock(join_mutex_);
  std::unique_lock lock(mutex_);
  stopping_ = finishing_ = true;
  changed_.notify_one();
  if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  lock.unlock();
  if (worker_.joinable()) worker_.join();
}
bool FrameExportOwner::wanted(const ExportedFrame& frame) const {
  if (stopping_ || desired_.renderer_id != frame.renderer_id) return false;
  switch (frame.kind) {
    case ExportKind::camera_preview:
      return desired_.camera_preview;
    case ExportKind::screen_preview:
      return desired_.screen_preview;
    case ExportKind::remote:
      return room_connected_ && std::any_of(desired_.remote_video_demand.begin(), desired_.remote_video_demand.end(), [&](const auto& demand) {
        return demand.publication_id == frame.publication_id && demand.participant_identity == frame.participant_identity;
      });
  }
  return false;
}
std::vector<ExportedFrame> FrameExportOwner::take() {
  std::lock_guard lock(mutex_);
  std::vector<ExportedFrame> frames;
  frames.reserve(kBatchCapacity);
  for (auto& entry : entries_) {
    if (entry.delivered || entry.release_requested) continue;
    if (!wanted(entry.frame) || std::chrono::steady_clock::now() - entry.cached_at > 150ms) {
      entry.release_requested = true;
      changed_.notify_one();
      continue;
    }
    frames.push_back(entry.frame);
    entry.delivered = true;
    if (frames.size() == kBatchCapacity) break;
  }
  return frames;
}
bool FrameExportOwner::release(const ExportRelease& release) {
  std::lock_guard lock(mutex_);
  for (auto& entry : entries_)
    if (entry.frame.generation == release.generation && entry.frame.sequence == release.sequence &&
        entry.frame.slot == release.slot) {
      entry.release_requested = true;
      changed_.notify_one();
      break;
    }
  // A duplicate release is acknowledged without touching another generation.
  return true;
}
void FrameExportOwner::releaseNative(NativeLease& lease) {
  if (const auto remote = std::get_if<TextureLease>(&lease))
    (void)SharedTexturePool::processPool().release(remote->generation, remote->sequence, remote->slot);
  else if (const auto preview = std::get_if<screen::PreviewFrame>(&lease))
    (void)screen_.releasePreview(preview->generation, preview->sequence, preview->slot);
  // Replacing the camera variant runs its RAII release on this data lane.
  lease = TextureLease{};
}
void FrameExportOwner::run() noexcept {
  try {
    for (;;) {
      Demand desired;
      std::vector<Entry> retired;
      bool finishing;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, 8ms);
        finishing = finishing_;
        desired = desired_;
        std::erase_if(entries_, [&](Entry& entry) {
          const bool fresh = std::chrono::steady_clock::now() - entry.cached_at <= 150ms;
          if (!finishing && !entry.release_requested && (entry.delivered || (wanted(entry.frame) && fresh))) return false;
          retired.push_back(std::move(entry));
          return true;
        });
      }
      for (auto& entry : retired) releaseNative(entry.lease);
      if (finishing) break;
      if (!desired.renderer_id) continue;
      std::set<std::string> current_streams;
      const auto offer = [&](ExportedFrame metadata, auto take) {
        const auto key = streamKey(metadata);
        current_streams.insert(key);
        {
          std::lock_guard lock(mutex_);
          if (!wanted(metadata) || entries_.size() >= kCapacity) return;
          std::size_t count = 0;
          for (const auto& entry : entries_)
            if (streamKey(entry.frame) == key && entry.frame.renderer_id == metadata.renderer_id) {
              if (!entry.delivered) return;
              ++count;
            }
          if (count >= (metadata.kind == ExportKind::remote ? 4U : 2U)) return;
        }
        auto candidate = take();
        if (!candidate) return;
        NativeLease lease(std::move(*candidate));
        std::uint64_t native_generation = 0;
        if (const auto remote = std::get_if<TextureLease>(&lease)) {
          native_generation = remote->generation;
          metadata.sequence = remote->sequence;
          metadata.slot = remote->slot;
          metadata.width = remote->width;
          metadata.height = remote->height;
          metadata.timestamp_us = remote->timestamp_us;
          metadata.ingress_us = remote->ingress_us;
          metadata.handle = remote->handle;
        } else if (const auto screen = std::get_if<screen::PreviewFrame>(&lease)) {
          native_generation = screen->generation;
          metadata.sequence = screen->sequence;
          metadata.slot = screen->slot;
          metadata.width = screen->width;
          metadata.height = screen->height;
          metadata.timestamp_us = screen->timestamp_us;
          metadata.handle = screen->handle;
        } else {
          const auto& camera = std::get<camera::CameraPreviewLease>(lease);
          native_generation = camera.metadata().generation;
          metadata.sequence = camera.metadata().sequence;
          metadata.slot = camera.slot();
          metadata.width = camera.width;
          metadata.height = camera.height;
          metadata.timestamp_us = camera.metadata().captured_100ns / 10;
          metadata.handle = camera.handle();
        }
        bool accepted = false;
        {
          std::lock_guard lock(mutex_);
          if (wanted(metadata) && entries_.size() < kCapacity) {
            auto& generation = generations_[key];
            if (generation.native_generation != native_generation || generation.renderer != metadata.renderer_id) {
              generation = {native_generation, ++next_generation_, metadata.renderer_id};
            }
            metadata.generation = generation.exported_generation;
            entries_.push_back({std::move(metadata), std::move(lease)});
            accepted = true;
          }
        }
        if (!accepted) releaseNative(lease);
      };
      for (const auto& demand : desired.remote_video_demand) {
        ExportedFrame frame;
        frame.kind = ExportKind::remote;
        frame.renderer_id = *desired.renderer_id;
        frame.revision = desired.revision;
        frame.publication_id = demand.publication_id;
        frame.participant_identity = demand.participant_identity;
        offer(std::move(frame), [&] { return video_.takeFrame(demand.publication_id); });
      }
      const auto local_frame = [&](ExportKind kind, const char* id) {
        ExportedFrame frame;
        frame.kind = kind;
        frame.renderer_id = *desired.renderer_id;
        frame.revision = desired.revision;
        frame.publication_id = id;
        frame.participant_identity = desired.participant_identity;
        return frame;
      };
      if (desired.screen_preview)
        offer(local_frame(ExportKind::screen_preview, "local-screen"), [&] { return screen_.takePreview(*desired.renderer_id); });
      if (desired.camera_preview)
        offer(local_frame(ExportKind::camera_preview, "local-camera"), [&] { return camera_.takePreview(*desired.renderer_id); });
      std::erase_if(generations_, [&](const auto& entry) { return !current_streams.contains(entry.first); });
    }
  } catch (...) { std::terminate(); }
  {
    std::lock_guard lock(mutex_);
    done_ = true;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::video
