#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstdint>
#include <deque>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <livekit/livekit.h>
#include <livekit/audio_source.h>
#include <livekit/ffi_handle.h>
#include <livekit/local_audio_track.h>
#include <livekit/participant.h>
#include <livekit/room.h>
#include <livekit/room_delegate.h>
#include <livekit/track.h>
#include <livekit/video_frame.h>

#include "common/diagnostic_log.hpp"
#include "common/cleanup_supervisor.hpp"
#include "common/event_sink.hpp"
#include "media/livekit_voice_session.hpp"
#include "media/media_runtime.hpp"
#include "media/media_runtime_support.hpp"
#include "media/remote_audio_output.hpp"
#include "media/remote_video_bridge.hpp"
#include "media/renderer_texture_lease_registry.hpp"
#include "media/video_resource_admission.hpp"
#include "media_contention_handoff_table.hpp"
#include "media_contention_audio_recovery.hpp"
#include "media_contention_publication_teardown.hpp"
#include "windows_process_resource_snapshot.hpp"
#include "media_contention_protocol_writer.hpp"
#include "media_contention_resource_baseline.hpp"
#include "media_contention_terminal_resource.hpp"
#include "media_contention_viewer_track_filter.hpp"

namespace {

using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
using syrnike::desktop_native::media::RemoteAudioOutput;
using syrnike::desktop_native::media::RemoteAudioOutputPhase;
using syrnike::desktop_native::media::RemoteAudioOutputState;
using syrnike::desktop_native::media::RemoteAudioEndpointSubscription;
using syrnike::desktop_native::media::RemoteAudioOperationAttempt;
using syrnike::desktop_native::media::RemoteAudioRendererPlatformAdapter;
using syrnike::desktop_native::media::RemoteAudioRendererRequest;
using syrnike::desktop_native::media::createWindowsRemoteAudioRendererPlatformAdapter;
using syrnike::desktop_native::MediaCommand;
using syrnike::desktop_native::NativeCommandType;
using syrnike::desktop_native::media::RemoteVideoBridge;
using syrnike::desktop_native::media::RemoteVideoRendererFlowState;
using syrnike::desktop_native::media::RemoteVideoTextureCompletionPoll;
using syrnike::desktop_native::media::RendererTextureLeaseFence;
using syrnike::desktop_native::media::VideoResourceOwner;
using syrnike::desktop_native::media::VideoTextureFormat;
using syrnike::desktop_native::media::configuredVideoTextureBytes;
using syrnike::desktop_native::media::processVideoResourceAdmissionBudget;
using syrnike::desktop_native::media::releaseRendererTextureLease;
using syrnike::desktop_native::media::rendererTextureLeaseStats;
using syrnike::desktop_native::tests::BoundedProtocolWriter;
using syrnike::desktop_native::tests::ObservedVideoHandoffTable;
using syrnike::desktop_native::tests::ContentionAudioAgeLane;
using syrnike::desktop_native::tests::ContentionAudioRecoveryWindow;
using syrnike::desktop_native::tests::ContentionPublicationTeardownGate;
using syrnike::desktop_native::tests::ContentionTerminalResourceGate;
using syrnike::desktop_native::tests::ContentionTerminalResourceState;
using syrnike::desktop_native::tests::WindowsProcessResourceTypes;
using syrnike::desktop_native::tests::captureWindowsProcessResourceTypes;
using syrnike::desktop_native::tests::resourceTypeDelta;
using syrnike::desktop_native::tests::ExpectedPublisherTrackFilter;
using syrnike::desktop_native::tests::ContentionResourceBaselineGate;
using syrnike::desktop_native::tests::ProtocolRecordAdmission;
using syrnike::desktop_native::tests::ProtocolRecordPriority;

constexpr std::uint32_t kWidth = 3'840;
constexpr std::uint32_t kHeight = 2'160;
constexpr std::uint32_t kPublishedScreenWidth = 1'920;
constexpr std::uint32_t kPublishedScreenHeight = 1'080;
constexpr std::size_t kPoolCapacity = 5;
constexpr std::uint64_t kAudioIntervalUs = 10'000;
constexpr std::size_t kMaximumPostedCommands = 64;
constexpr std::uint32_t kProtocolVersion = 1;
constexpr std::string_view kRemoteTrackId = "contention-remote";
constexpr std::string_view kCameraPreviewTrackId =
    "contention-camera-preview";
constexpr std::string_view kRemoteResourceOwner = "remote:contention-remote";
constexpr std::string_view kCameraPreviewResourceOwner =
    "remote:contention-camera-preview";

class CollectingEventSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    {
      std::lock_guard lock(mutex_);
      events_.push_back(std::move(event));
    }
    changed_.notify_all();
    return true;
  }
  void close() override {}

  std::optional<syrnike::desktop_native::RuntimeEvent> waitReply(
      const std::string& request_id,
      std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, timeout, [&] {
          return std::any_of(events_.begin(), events_.end(), [&](const auto& event) {
            return event.type == syrnike::desktop_native::NativeEventType::Reply &&
                event.request_id == request_id;
          });
        })) {
      return std::nullopt;
    }
    const auto found = std::find_if(events_.begin(), events_.end(), [&](const auto& event) {
      return event.type == syrnike::desktop_native::NativeEventType::Reply &&
          event.request_id == request_id;
    });
    return found == events_.end() ? std::nullopt : std::optional(*found);
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

struct ViewerTrackState {
  std::mutex mutex;
  std::condition_variable changed;
  std::shared_ptr<livekit::Track> video_track;
  std::shared_ptr<livekit::Track> audio_track;
  std::string publication_sid;
  std::string publication_name;
  std::string publisher_identity;
  std::string audio_publication_sid;
  std::string audio_remote_track_sid;
  std::uint64_t rejected_tracks = 0;
  std::uint64_t snapshot_adoptions = 0;
  std::uint64_t subscribe_requests = 0;
};

class ViewerRoomDelegate final : public livekit::RoomDelegate {
 public:
  ViewerRoomDelegate(ViewerTrackState& state, std::string publisher_identity)
      : state_(state), publisher_filter_(std::move(publisher_identity)) {}

  void onTrackSubscribed(
      livekit::Room&,
      const livekit::TrackSubscribedEvent& event) override {
    if (!event.track || !event.participant || !event.publication) return;
    if (!publisher_filter_.accepts(
            event.participant->identity(),
            event.publication->sid(),
            event.track->sid())) {
      std::lock_guard lock(state_.mutex);
      ++state_.rejected_tracks;
      return;
    }
    {
      std::lock_guard lock(state_.mutex);
      if (event.track->kind() == livekit::TrackKind::KIND_AUDIO) {
        state_.audio_track = event.track;
        state_.audio_remote_track_sid = event.track->sid();
        if (event.publication) {
          state_.audio_publication_sid = event.publication->sid();
        }
        state_.changed.notify_all();
        return;
      }
      if (event.track->kind() != livekit::TrackKind::KIND_VIDEO) return;
      state_.video_track = event.track;
      if (event.publication) {
        state_.publication_sid = event.publication->sid();
        state_.publication_name = event.publication->name();
      }
      if (event.participant) {
        state_.publisher_identity = event.participant->identity();
      }
    }
    state_.changed.notify_all();
  }

 private:
  ViewerTrackState& state_;
  ExpectedPublisherTrackFilter publisher_filter_;
};

struct RemoteVideoSubscribeWatch {
  bool publisher_present = false;
  std::uint64_t video_publications = 0;
  std::uint64_t subscribed_publications = 0;
  bool video_track_present = false;
  std::uint64_t rejected_tracks = 0;
  std::uint64_t snapshot_adoptions = 0;
  std::uint64_t subscribe_requests = 0;
};

void adoptRemoteVideoFromRoom(
    livekit::Room& room,
    ViewerTrackState& tracks,
    const ExpectedPublisherTrackFilter& filter,
    const std::string& publisher_identity) {
  const auto participant = room.remoteParticipant(publisher_identity).lock();
  if (!participant) return;
  for (const auto& [sid, publication] : participant->trackPublications()) {
    if (!publication ||
        publication->kind() != livekit::TrackKind::KIND_VIDEO) {
      continue;
    }
    auto track = publication->track();
    if (!track) {
      bool request_subscribe = false;
      {
        std::lock_guard lock(tracks.mutex);
        request_subscribe =
            tracks.subscribe_requests == 0 && !publication->subscribed();
        if (request_subscribe) ++tracks.subscribe_requests;
      }
      if (request_subscribe) publication->setSubscribed(true);
      continue;
    }
    if (!filter.accepts(
            publisher_identity, publication->sid(), track->sid())) {
      std::lock_guard lock(tracks.mutex);
      ++tracks.rejected_tracks;
      continue;
    }
    std::lock_guard lock(tracks.mutex);
    if (tracks.video_track) return;
    tracks.video_track = std::move(track);
    tracks.publication_sid = publication->sid();
    tracks.publication_name = publication->name();
    tracks.publisher_identity = publisher_identity;
    ++tracks.snapshot_adoptions;
    tracks.changed.notify_all();
    return;
  }
}

RemoteVideoSubscribeWatch inspectRemoteVideoSubscribe(
    livekit::Room* room,
    ViewerTrackState& tracks,
    const std::string& publisher_identity) {
  RemoteVideoSubscribeWatch watch;
  {
    std::lock_guard lock(tracks.mutex);
    watch.video_track_present = tracks.video_track != nullptr;
    watch.rejected_tracks = tracks.rejected_tracks;
    watch.snapshot_adoptions = tracks.snapshot_adoptions;
    watch.subscribe_requests = tracks.subscribe_requests;
  }
  if (!room) return watch;
  const auto participant = room->remoteParticipant(publisher_identity).lock();
  if (!participant) return watch;
  watch.publisher_present = true;
  for (const auto& [sid, publication] : participant->trackPublications()) {
    if (!publication ||
        publication->kind() != livekit::TrackKind::KIND_VIDEO) {
      continue;
    }
    ++watch.video_publications;
    if (publication->subscribed() || publication->track()) {
      ++watch.subscribed_publications;
    }
  }
  return watch;
}

class DisconnectViewerBeforeRuntime final {
 public:
  DisconnectViewerBeforeRuntime(
      std::unique_ptr<livekit::Room>& room,
      ViewerTrackState& tracks)
      : room_(&room), tracks_(&tracks) {}

  ~DisconnectViewerBeforeRuntime() { disconnect(); }

  DisconnectViewerBeforeRuntime(const DisconnectViewerBeforeRuntime&) = delete;
  DisconnectViewerBeforeRuntime& operator=(
      const DisconnectViewerBeforeRuntime&) = delete;

  void disconnect() {
    auto* room = room_;
    room_ = nullptr;
    if (room && *room) {
      auto& diagnostic_log =
          syrnike::desktop_native::diagnostics::DiagnosticLog::instance();
      if (diagnostic_log.enabled()) {
        diagnostic_log.write("viewer_room_disconnect_start");
      }
      try {
        (*room)->setDelegate(nullptr);
        static_cast<void>(
            (*room)->disconnectUntil(Clock::now() + std::chrono::seconds(2)));
      } catch (...) {
      }
      room->reset();
      if (diagnostic_log.enabled()) {
        diagnostic_log.write("viewer_room_disconnect_ok");
      }
    }
    if (!tracks_) return;
    try {
      std::lock_guard lock(tracks_->mutex);
      tracks_->video_track.reset();
      tracks_->audio_track.reset();
    } catch (...) {
    }
    tracks_ = nullptr;
  }

 private:
  std::unique_ptr<livekit::Room>* room_ = nullptr;
  ViewerTrackState* tracks_ = nullptr;
};

class DiagnosticLogLifetime final {
 public:
  DiagnosticLogLifetime() {
    syrnike::desktop_native::diagnostics::DiagnosticLog::instance()
        .initializeForMediaProcess();
  }
  ~DiagnosticLogLifetime() {
    syrnike::desktop_native::diagnostics::DiagnosticLog::instance().shutdown();
  }
};

std::uint64_t steadyNowUs() noexcept {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(
          Clock::now().time_since_epoch())
          .count());
}

struct TimedFault {
  std::uint64_t at_ms = 0;
  std::uint64_t duration_ms = 0;
};

struct Config {
  std::uint32_t electron_pid = 0;
  std::uint64_t duration_ms = 12'000;
  TimedFault gpu{1'000, 550};
  TimedFault livekit{1'500, 300};
  std::uint64_t screen_start_ms = 0;
  bool livekit_fault_enabled = true;
  bool camera_preview_enabled = true;
  std::vector<TimedFault> audio{
      {750, 100}, {3'000, 100}, {6'000, 100}, {9'000, 100}};
  std::size_t audio_index_base = 0;
  std::string livekit_url;
  std::string publisher_token;
  std::string viewer_token;
  std::string publisher_identity;
  std::string viewer_identity;
  std::string room_name;
};

struct CompletionFaultState {
  static constexpr std::uint64_t kMaximumForcedSequences = 4;

  std::atomic_bool active{false};
  std::atomic<std::uint64_t> target_sequence{0};
  std::atomic<std::uint64_t> target_pool_reservation_id{0};
  std::atomic<std::uint64_t> last_observed_pool_reservation_id{0};
  std::atomic<std::uint64_t> last_observed_sequence{0};
  std::atomic<std::uint64_t> arm_after_sequence{0};
  std::atomic<std::uint64_t> observed_elapsed_us{0};
  std::atomic<std::uint32_t> timed_out_mask{0};
  std::atomic<std::uint64_t> forced_timeout_count{0};

  bool shouldWithhold(
      const RemoteVideoTextureCompletionPoll& observation) noexcept {
    const auto observed_pool =
        last_observed_pool_reservation_id.load(std::memory_order_relaxed);
    if (observed_pool != observation.pool_reservation_id) {
      last_observed_pool_reservation_id.store(
          observation.pool_reservation_id, std::memory_order_release);
      last_observed_sequence.store(
          observation.submission_sequence, std::memory_order_release);
    } else {
      auto observed = last_observed_sequence.load(std::memory_order_relaxed);
      while (observed < observation.submission_sequence &&
             !last_observed_sequence.compare_exchange_weak(
                 observed,
                 observation.submission_sequence,
                 std::memory_order_release,
                 std::memory_order_relaxed)) {}
    }
    if (!active.load(std::memory_order_acquire)) return false;
    const auto first_target =
        arm_after_sequence.load(std::memory_order_acquire) + 1;
    if (observation.submission_sequence < first_target ||
        observation.submission_sequence - first_target >=
            kMaximumForcedSequences) {
      return false;
    }
    auto target_pool = target_pool_reservation_id.load(
        std::memory_order_acquire);
    if (target_pool == 0) {
      target_pool_reservation_id.compare_exchange_strong(
          target_pool,
          observation.pool_reservation_id,
          std::memory_order_acq_rel,
          std::memory_order_acquire);
      target_pool = target_pool_reservation_id.load(std::memory_order_acquire);
    }
    if (target_pool != observation.pool_reservation_id) {
      active.store(false, std::memory_order_release);
      return false;
    }
    target_sequence.store(first_target, std::memory_order_release);
    auto elapsed = observed_elapsed_us.load(std::memory_order_relaxed);
    while (elapsed < observation.elapsed_us &&
           !observed_elapsed_us.compare_exchange_weak(
               elapsed,
               observation.elapsed_us,
               std::memory_order_release,
               std::memory_order_relaxed)) {}
    if (observation.elapsed_us >= observation.timeout_us) {
      const auto offset = static_cast<std::uint32_t>(
          observation.submission_sequence - first_target);
      const auto bit = std::uint32_t{1} << offset;
      const auto previous = timed_out_mask.fetch_or(
          bit, std::memory_order_acq_rel);
      if ((previous & bit) == 0) {
        forced_timeout_count.fetch_add(1, std::memory_order_relaxed);
      }
    }
    return true;
  }
};

class FakeVideoTrack final : public livekit::Track {
 public:
  FakeVideoTrack()
      : livekit::Track(
            livekit::FfiHandle{},
            std::string(kRemoteTrackId),
            std::string(kRemoteTrackId),
            livekit::TrackKind::KIND_VIDEO,
            livekit::StreamState::STATE_ACTIVE,
            false,
            true) {
    setPublicationFields(
        livekit::TrackSource::SOURCE_SCREENSHARE,
        false,
        static_cast<int>(kWidth),
        static_cast<int>(kHeight),
        std::string("video/test"));
  }
};

struct ScriptedReaderState {
  std::atomic_uint64_t frames{0};
  std::atomic_uint64_t factories{0};
  std::atomic_uint64_t closes{0};
  std::atomic_uint64_t linked_frame_sequence{0};
  std::atomic_uint64_t linked_timestamp_us{0};
  std::atomic_bool linked_frame_delivered{false};
  std::chrono::milliseconds cadence{250};
};

class ScriptedVideoReader final : public RemoteVideoBridge::StreamReader {
 public:
  explicit ScriptedVideoReader(std::shared_ptr<ScriptedReaderState> state)
      : state_(std::move(state)), next_frame_at_(Clock::now()) {}

  bool read(livekit::VideoFrameEvent& event) override {
    {
      std::unique_lock lock(mutex_);
      if (changed_.wait_until(lock, next_frame_at_, [&] { return closed_; })) {
        return false;
      }
      if (closed_) return false;
      next_frame_at_ = Clock::now() + state_->cadence;
    }
    const auto index = state_->frames.fetch_add(1, std::memory_order_relaxed) + 1;
    const auto linked_timestamp =
        state_->linked_timestamp_us.load(std::memory_order_acquire);
    const bool linked = linked_timestamp != 0 &&
        !state_->linked_frame_delivered.exchange(true, std::memory_order_acq_rel);
    const auto width = index == 2 ? 3'584U : kWidth;
    const auto height = index == 2 ? 2'016U : kHeight;
    event.frame = livekit::VideoFrame::create(
        static_cast<int>(width),
        static_cast<int>(height),
        livekit::VideoBufferType::BGRA);
    if (event.frame.dataSize() >= 4) {
      event.frame.data()[0] = static_cast<std::uint8_t>(index & 0xff);
      event.frame.data()[1] = static_cast<std::uint8_t>((index >> 8) & 0xff);
      event.frame.data()[3] = 0xff;
    }
    event.timestamp_us = static_cast<std::int64_t>(
        linked ? linked_timestamp : steadyNowUs());
    event.rotation = livekit::VideoRotation::VIDEO_ROTATION_0;
    return true;
  }

  void close() override {
    {
      std::lock_guard lock(mutex_);
      if (closed_) return;
      closed_ = true;
      state_->closes.fetch_add(1, std::memory_order_relaxed);
    }
    changed_.notify_all();
  }

 private:
  std::shared_ptr<ScriptedReaderState> state_;
  std::mutex mutex_;
  std::condition_variable changed_;
  Clock::time_point next_frame_at_;
  bool closed_ = false;
};

class BoundedPostedCommands final {
 public:
  bool push(MediaCommand command) {
    std::lock_guard lock(mutex_);
    if (closed_ || commands_.size() >= kMaximumPostedCommands) return false;
    commands_.push_back(std::move(command));
    return true;
  }

  std::vector<MediaCommand> drain() {
    std::vector<MediaCommand> result;
    std::lock_guard lock(mutex_);
    result.reserve(commands_.size());
    while (!commands_.empty()) {
      result.push_back(std::move(commands_.front()));
      commands_.pop_front();
    }
    return result;
  }

  std::size_t size() const {
    std::lock_guard lock(mutex_);
    return commands_.size();
  }

  void close() {
    std::lock_guard lock(mutex_);
    closed_ = true;
    commands_.clear();
  }

 private:
  mutable std::mutex mutex_;
  std::deque<MediaCommand> commands_;
  bool closed_ = false;
};

// Keeps the production WASAPI adapter and RemoteAudioOutput fill callback in
// the path while making scheduler gaps deterministic for the contention run.
class FaultInjectingWasapiAdapter final
    : public RemoteAudioRendererPlatformAdapter {
 public:
  void injectGap(std::uint64_t duration_ms) noexcept {
    pending_gap_ms_.store(duration_ms, std::memory_order_release);
  }

  std::uint64_t injectedGaps() const noexcept {
    return injected_gaps_.load(std::memory_order_acquire);
  }

  std::uint64_t completedGapFills() const noexcept {
    return completed_gap_fills_.load(std::memory_order_acquire);
  }

  void runRenderer(
      RemoteAudioOperationAttempt::Context& context,
      RemoteAudioRendererRequest request) override {
    auto fill = std::move(request.fill);
    request.fill = [this, fill = std::move(fill)](auto buffer) {
      const auto gap_ms = pending_gap_ms_.exchange(0, std::memory_order_acq_rel);
      if (gap_ms != 0) {
        injected_gaps_.fetch_add(1, std::memory_order_relaxed);
        std::this_thread::sleep_for(std::chrono::milliseconds(gap_ms));
      }
      auto result = fill(buffer);
      if (gap_ms != 0) {
        completed_gap_fills_.fetch_add(1, std::memory_order_release);
      }
      return result;
    };
    inner_->runRenderer(context, std::move(request));
  }

  std::unique_ptr<RemoteAudioEndpointSubscription> monitorEndpoints(
      std::function<void(
          const syrnike::desktop_native::media::AudioEndpointChange&)> handler)
      override {
    return inner_->monitorEndpoints(std::move(handler));
  }

 private:
  std::shared_ptr<RemoteAudioRendererPlatformAdapter> inner_ =
      createWindowsRemoteAudioRendererPlatformAdapter();
  std::atomic<std::uint64_t> pending_gap_ms_{0};
  std::atomic<std::uint64_t> injected_gaps_{0};
  std::atomic<std::uint64_t> completed_gap_fills_{0};
};

class PipeCommandReader final {
 public:
  std::vector<std::string> readAvailable() {
    std::vector<std::string> commands;
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (!input || input == INVALID_HANDLE_VALUE) return commands;
    for (;;) {
      DWORD available = 0;
      if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr) ||
          available == 0) {
        break;
      }
      std::array<char, 1'024> buffer{};
      DWORD read = 0;
      if (!ReadFile(
              input,
              buffer.data(),
              std::min<DWORD>(available, static_cast<DWORD>(buffer.size())),
              &read,
              nullptr) ||
          read == 0) {
        break;
      }
      pending_.append(buffer.data(), read);
    }
    for (;;) {
      const auto newline = pending_.find('\n');
      if (newline == std::string::npos) break;
      auto command = pending_.substr(0, newline);
      pending_.erase(0, newline + 1);
      if (!command.empty() && command.back() == '\r') command.pop_back();
      commands.push_back(std::move(command));
    }
    return commands;
  }

 private:
  std::string pending_;
};

std::string jsonEscape(std::string_view input) {
  std::string result;
  result.reserve(input.size());
  for (const char character : input) {
    switch (character) {
      case '\\': result += "\\\\"; break;
      case '"': result += "\\\""; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default: result += character; break;
    }
  }
  return result;
}

bool writeStdoutRecord(std::string_view record) noexcept {
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!output || output == INVALID_HANDLE_VALUE) return false;
  std::string line(record);
  line.push_back('\n');
  std::size_t offset = 0;
  while (offset < line.size()) {
    DWORD written = 0;
    const auto remaining = static_cast<DWORD>((std::min<std::size_t>)(
        line.size() - offset,
        static_cast<std::size_t>((std::numeric_limits<DWORD>::max)())));
    if (!WriteFile(
            output, line.data() + offset, remaining, &written, nullptr) ||
        written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

void emitControl(BoundedProtocolWriter& writer, std::string record) {
  const auto admission =
      writer.enqueue(std::move(record), ProtocolRecordPriority::Control);
  if (admission == ProtocolRecordAdmission::Accepted ||
      admission == ProtocolRecordAdmission::Closed) {
    return;
  }
  throw std::runtime_error(
      "contention protocol control/anomaly queue saturated");
}

void emitCapability(
    BoundedProtocolWriter& writer,
    std::string_view name,
    bool available,
    std::string_view reason = {}) {
  std::ostringstream record;
  record << "CAPABILITY {\"name\":\"" << jsonEscape(name)
         << "\",\"available\":" << (available ? "true" : "false");
  if (!reason.empty()) {
    record << ",\"reason\":\"" << jsonEscape(reason) << '"';
  }
  record << '}';
  emitControl(writer, record.str());
}

std::size_t processThreadCount() noexcept {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  std::size_t count = 0;
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID == GetCurrentProcessId()) ++count;
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return count;
}

std::size_t processHandleCount() noexcept {
  DWORD count = 0;
  return GetProcessHandleCount(GetCurrentProcess(), &count)
      ? static_cast<std::size_t>(count)
      : 0;
}

std::uint64_t parseUnsigned(std::string_view value, std::string_view name) {
  std::size_t parsed = 0;
  const auto number = std::stoull(std::string(value), &parsed);
  if (parsed != value.size()) {
    throw std::invalid_argument(std::string(name) + " must be an integer");
  }
  return number;
}

std::uint64_t sortedPercentile(
    const std::vector<std::uint64_t>& samples,
    std::size_t percentile) noexcept {
  if (samples.empty()) return 0;
  const auto index =
      ((samples.size() - 1) * std::min<std::size_t>(percentile, 100)) / 100;
  return samples[index];
}

TimedFault parseFault(std::string_view value, std::string_view name) {
  const auto separator = value.find(':');
  if (separator == std::string_view::npos) {
    throw std::invalid_argument(
        std::string(name) + " must use at_ms:duration_ms");
  }
  return {
      parseUnsigned(value.substr(0, separator), name),
      parseUnsigned(value.substr(separator + 1), name),
  };
}

Config parseConfig(int argc, char** argv) {
  Config config;
  bool custom_audio = false;
  for (int index = 1; index < argc; ++index) {
    const std::string_view option(argv[index]);
    if (index + 1 >= argc) {
      throw std::invalid_argument("missing value for " + std::string(option));
    }
    const std::string_view value(argv[++index]);
    if (option == "--electron-pid") {
      config.electron_pid =
          static_cast<std::uint32_t>(parseUnsigned(value, option));
    } else if (option == "--duration-ms") {
      config.duration_ms = parseUnsigned(value, option);
    } else if (option == "--gpu-fault") {
      config.gpu = parseFault(value, option);
    } else if (option == "--livekit-fault") {
      config.livekit = parseFault(value, option);
    } else if (option == "--screen-start-ms") {
      config.screen_start_ms = parseUnsigned(value, option);
    } else if (option == "--livekit-fault-enabled") {
      if (value != "0" && value != "1") {
        throw std::invalid_argument(
            "--livekit-fault-enabled must be 0 or 1");
      }
      config.livekit_fault_enabled = value == "1";
    } else if (option == "--camera-preview-enabled") {
      if (value != "0" && value != "1") {
        throw std::invalid_argument(
            "--camera-preview-enabled must be 0 or 1");
      }
      config.camera_preview_enabled = value == "1";
    } else if (option == "--audio-gap") {
      if (!custom_audio) {
        config.audio.clear();
        custom_audio = true;
      }
      config.audio.push_back(parseFault(value, option));
    } else if (option == "--audio-index-base") {
      config.audio_index_base = static_cast<std::size_t>(
          parseUnsigned(value, option));
    } else if (option == "--livekit-url") {
      config.livekit_url = value;
    } else if (option == "--publisher-identity") {
      config.publisher_identity = value;
    } else if (option == "--viewer-identity") {
      config.viewer_identity = value;
    } else if (option == "--room-name") {
      config.room_name = value;
    } else {
      throw std::invalid_argument("unknown option: " + std::string(option));
    }
  }
  if (config.electron_pid == 0) {
    throw std::invalid_argument("--electron-pid is required");
  }
  if (config.duration_ms == 0) {
    throw std::invalid_argument("--duration-ms must be positive");
  }
  if (config.screen_start_ms == 0) {
    config.screen_start_ms = config.livekit.at_ms;
  }
  const auto read_environment = [](const char* name) {
    char* value = nullptr;
    std::size_t size = 0;
    if (_dupenv_s(&value, &size, name) != 0 || value == nullptr) {
      return std::string{};
    }
    std::string result(value);
    std::free(value);
    return result;
  };
  config.publisher_token =
      read_environment("SYRNIKE_CONTENTION_PUBLISHER_TOKEN");
  config.viewer_token =
      read_environment("SYRNIKE_CONTENTION_VIEWER_TOKEN");
  static_cast<void>(_putenv_s("SYRNIKE_CONTENTION_PUBLISHER_TOKEN", ""));
  static_cast<void>(_putenv_s("SYRNIKE_CONTENTION_VIEWER_TOKEN", ""));
  if (config.livekit_url.empty() || config.publisher_token.empty() ||
      config.viewer_token.empty() || config.publisher_identity.empty() ||
      config.viewer_identity.empty() || config.room_name.empty()) {
    throw std::invalid_argument(
        "local LiveKit URL, tokens, identities, and room name are required");
  }
  return config;
}

}  // namespace

int main(int argc, char** argv) try {
  const auto config = parseConfig(argc, argv);
  DiagnosticLogLifetime diagnostic_log_lifetime;
  BoundedProtocolWriter protocol_writer(&writeStdoutRecord);
#define EMIT_CONTROL_STREAM(expression)                                        \
  do {                                                                         \
    std::ostringstream protocol_record;                                        \
    protocol_record << expression;                                             \
    emitControl(protocol_writer, protocol_record.str());                       \
  } while (false)
  auto livekit_lifetime = std::make_shared<
      syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
  const auto livekit_shutdown_transition_before =
      syrnike::desktop_native::media::LiveKitLease::shutdownTransitionCount();
  livekit_lifetime->initialize();
  {

  const auto renderer_baseline = rendererTextureLeaseStats();
  const auto admission_baseline = processVideoResourceAdmissionBudget().usageFor(
      VideoResourceOwner::RemoteVideo, kRemoteResourceOwner);
  const auto camera_admission_baseline =
      processVideoResourceAdmissionBudget().usageFor(
          VideoResourceOwner::RemoteVideo, kCameraPreviewResourceOwner);
  const auto configured_four_k_pool_bytes = configuredVideoTextureBytes({
      .width = kWidth,
      .height = kHeight,
      .count = kPoolCapacity,
      .format = VideoTextureFormat::Bgra8,
  });
  const auto completion_fault = std::make_shared<CompletionFaultState>();
  const auto reader_state = std::make_shared<ScriptedReaderState>();
  const auto camera_preview_reader_state =
      std::make_shared<ScriptedReaderState>();
  const auto posted_commands = std::make_shared<BoundedPostedCommands>();
  ViewerTrackState viewer_track_state;
  ViewerRoomDelegate viewer_delegate(
      viewer_track_state, config.publisher_identity);
  auto viewer_room = std::make_unique<livekit::Room>();
  std::unique_ptr<RemoteVideoBridge> video_bridge;
  std::unique_ptr<RemoteVideoBridge> camera_preview_bridge;
  try {
    viewer_room->setDelegate(&viewer_delegate);
    livekit::RoomOptions options;
    options.auto_subscribe = true;
    options.single_peer_connection = true;
    auto& diagnostic_log =
        syrnike::desktop_native::diagnostics::DiagnosticLog::instance();
    if (diagnostic_log.enabled()) {
      diagnostic_log.write("viewer_room_connect_start");
    }
    if (!viewer_room->connect(
            config.livekit_url, config.viewer_token, options)) {
      if (diagnostic_log.enabled()) {
        diagnostic_log.write(
            "viewer_room_connect_failed",
            {{"reason", "connect returned false"}});
      }
      throw std::runtime_error("viewer Room connect returned false");
    }
    if (diagnostic_log.enabled()) {
      diagnostic_log.write("viewer_room_connect_ok");
    }
    emitCapability(protocol_writer, "remoteViewer", true);
    EMIT_CONTROL_STREAM(
        "RUNTIME_READY {\"protocolVersion\":" << kProtocolVersion << '}');
  } catch (const std::exception& error) {
    emitCapability(protocol_writer, "remoteViewer", false, error.what());
    viewer_room.reset();
  }

  std::mutex audio_state_mutex;
  RemoteAudioOutputState audio_state;
  bool received_audio_state = false;
  std::atomic_uint64_t audio_track_failures{0};
  auto audio_adapter = std::make_shared<FaultInjectingWasapiAdapter>();
  auto audio_source = std::make_shared<livekit::AudioSource>(48'000, 2);
  auto audio_track = livekit::LocalAudioTrack::createLocalAudioTrack(
      "contention-audio", audio_source);
  std::unique_ptr<RemoteAudioOutput> audio_output;
  try {
    audio_output = std::make_unique<RemoteAudioOutput>(
        [&](RemoteAudioOutputState next) {
          std::lock_guard lock(audio_state_mutex);
          audio_state = std::move(next);
          received_audio_state = true;
        },
        [&](auto, auto, auto) {
          audio_track_failures.fetch_add(1, std::memory_order_relaxed);
        },
        RemoteAudioOutput::SpeakingActivityHandler{},
        syrnike::desktop_native::CleanupStartProbe{},
        audio_adapter);
    static_cast<void>(audio_output->setOutputDevice("default"));
  } catch (const std::exception& error) {
    emitCapability(protocol_writer, "audioOutput", false, error.what());
    audio_output.reset();
  }

  auto audio_frame = livekit::AudioFrame::create(48'000, 2, 480);

  auto runtime_sink = std::make_shared<CollectingEventSink>();
  auto real_livekit =
      syrnike::desktop_native::media::createRealLiveKitVoiceSession(
          livekit_lifetime);
  std::atomic_bool livekit_finished{false};
  std::atomic_bool video_publication_acknowledged{false};
  ContentionPublicationTeardownGate publication_teardown_gate;
  ObservedVideoHandoffTable<512> observed_video_handoffs;
  bool livekit_started = false;
  bool screen_start_acknowledged = false;
  std::atomic_uint64_t livekit_fault_hits{0};
  auto screen_runtime = std::make_unique<
      syrnike::desktop_native::media::MediaRuntime>(
      runtime_sink,
      real_livekit,
      syrnike::desktop_native::media::MediaRuntime::SteadyNow{},
      syrnike::desktop_native::media::MediaRuntime::BeforeMicrophoneOperation{},
      syrnike::desktop_native::media::MediaRuntime::BeforeVoiceShutdown{},
      livekit_lifetime,
      syrnike::desktop_native::CleanupStartProbe{},
      syrnike::desktop_native::media::MediaRuntime::AfterSubsystemCleanup{},
      syrnike::desktop_native::media::MicrophoneCaptureAdapter{},
      syrnike::desktop_native::media::MicrophoneIdleCaptureTiming{},
      [&video_publication_acknowledged,
       &observed_video_handoffs](
          const std::string&,
          std::uint64_t,
          std::uint64_t frame_sequence,
          std::uint64_t timestamp_us) {
        if (!video_publication_acknowledged.load(std::memory_order_acquire)) {
          return;
        }
        observed_video_handoffs.observe(frame_sequence, timestamp_us);
      },
      [&protocol_writer,
       &config,
       &livekit_fault_hits,
       &video_publication_acknowledged](
          const MediaCommand&,
          const std::string& publication_sid) {
        video_publication_acknowledged.store(true, std::memory_order_release);
        if (!config.livekit_fault_enabled) return;
        // Hold only the configured duration. Sleeping livekit.at_ms here made
        // the attempt exceed kNativeOperationDeadline (18s) on production
        // epoch-2, so isCurrent() failed after the hold and teardown aborted.
        EMIT_CONTROL_STREAM(
            "FAULT {\"name\":\"liveKitCallbackHold\",\"phase\":\"entered\""
            << ",\"publicationSid\":\""
            << jsonEscape(publication_sid) << "\"}");
        std::this_thread::sleep_for(
            std::chrono::milliseconds(config.livekit.duration_ms));
        livekit_fault_hits.fetch_add(1, std::memory_order_relaxed);
        EMIT_CONTROL_STREAM(
            "FAULT {\"name\":\"liveKitCallbackHold\",\"phase\":\"released\",\"durationMs\":"
            << config.livekit.duration_ms << '}');
      },
      [&protocol_writer, &publication_teardown_gate](
          const MediaCommand& command,
          syrnike::desktop_native::media::ScreenVideoPublicationPhase phase) {
        using Phase =
            syrnike::desktop_native::media::ScreenVideoPublicationPhase;
        if (phase == Phase::Started) {
          publication_teardown_gate.beginPublication();
        } else {
          publication_teardown_gate.finishPublication();
        }
        const char* phase_name = phase == Phase::Started
            ? "started"
            : phase == Phase::Published ? "published" : "failed";
        EMIT_CONTROL_STREAM(
            "PUBLICATION_LIFECYCLE {\"protocolVersion\":"
            << kProtocolVersion << ",\"phase\":\"" << phase_name
            << "\",\"sessionId\":\"" << jsonEscape(command.session_id)
            << "\",\"generation\":" << command.generation << '}');
      });
  screen_runtime->waitUntilReady();
  DisconnectViewerBeforeRuntime disconnect_viewer_before_runtime(
      viewer_room, viewer_track_state);

  MediaCommand connect_voice;
  connect_voice.type = NativeCommandType::ConnectVoice;
  connect_voice.request_id = "contention-livekit-connect";
  connect_voice.session_id = "contention-session";
  connect_voice.generation = 7;
  connect_voice.livekit_url = config.livekit_url;
  connect_voice.livekit_token = config.publisher_token;
  connect_voice.participant_identity = config.publisher_identity;
  if (!screen_runtime->dispatch(std::move(connect_voice))) {
    throw std::runtime_error("contention publisher Room connect was rejected");
  }
  const auto connect_reply = runtime_sink->waitReply(
      "contention-livekit-connect", 10s);
  if (!connect_reply || !connect_reply->ok) {
    throw std::runtime_error("contention publisher Room connect failed");
  }

  if (!audio_output || !viewer_room) {
    emitCapability(
        protocol_writer, "audioOutput", false,
        "real publisher/viewer audio path was not initialized");
  } else {
    const auto owner_call =
        syrnike::desktop_native::media::requireSessionPortValue(
            real_livekit->bindCurrentOwner("contention-session", 7));
    livekit::TrackPublishOptions audio_publish_options;
    audio_publish_options.source = livekit::TrackSource::SOURCE_MICROPHONE;
    audio_publish_options.dtx = false;
    const auto audio_publication_sid =
        syrnike::desktop_native::media::requireSessionPortValue(
            real_livekit->publication().publishAudioTrack(
                owner_call, audio_track, audio_publish_options));
    std::shared_ptr<livekit::Track> remote_audio_track;
    std::string remote_audio_publication_sid;
    {
      std::unique_lock lock(viewer_track_state.mutex);
      viewer_track_state.changed.wait_for(lock, 10s, [&] {
        return viewer_track_state.audio_track != nullptr;
      });
      remote_audio_track = viewer_track_state.audio_track;
      remote_audio_publication_sid =
          viewer_track_state.audio_publication_sid;
    }
    if (!remote_audio_track) {
      throw std::runtime_error(
          "viewer Room did not subscribe to the published audio track");
    }
    audio_output->addTrack(
        "contention-audio",
        config.publisher_identity,
        false,
        remote_audio_track);
    const auto audio_deadline = Clock::now() + 2s;
    bool running = false;
    while (Clock::now() < audio_deadline) {
      {
        std::lock_guard lock(audio_state_mutex);
        running = received_audio_state &&
            audio_state.phase == RemoteAudioOutputPhase::Running;
        if (running ||
            (received_audio_state &&
             audio_state.phase == RemoteAudioOutputPhase::Failed)) {
          break;
        }
      }
      std::this_thread::sleep_for(5ms);
    }
    std::string audio_reason;
    {
      std::lock_guard lock(audio_state_mutex);
      running = received_audio_state &&
          audio_state.phase == RemoteAudioOutputPhase::Running;
      if (!running) audio_reason = audio_state.detail;
    }
    emitCapability(
        protocol_writer,
        "audioOutput",
        running,
        running ? std::string_view{} : std::string_view(audio_reason));
    const auto local_audio_publication = audio_track->publication();
    const auto local_audio_publication_sid = local_audio_publication
        ? local_audio_publication->sid()
        : std::string{};
    EMIT_CONTROL_STREAM(
        "AUDIO_PIPELINE {\"protocolVersion\":" << kProtocolVersion
        << ",\"publisherIdentity\":\""
        << jsonEscape(config.publisher_identity)
        << "\",\"viewerIdentity\":\""
        << jsonEscape(config.viewer_identity)
        << "\",\"publishReturnSid\":\""
        << jsonEscape(audio_publication_sid)
        << "\",\"localPublicationSid\":\""
        << jsonEscape(local_audio_publication_sid)
        << "\",\"remotePublicationSid\":\""
        << jsonEscape(remote_audio_publication_sid)
        << "\",\"remoteTrackSid\":\""
        << jsonEscape(remote_audio_track->sid()) << "\"}");
  }

  PipeCommandReader commands;
  std::unordered_map<std::uint64_t, std::uint64_t> outstanding_sequences;
  std::unordered_map<std::uint64_t, std::uint64_t>
      camera_preview_outstanding_sequences;
  std::unordered_map<std::uint64_t, std::uint64_t> outstanding_timestamps;
  std::unordered_map<std::uint64_t, std::uint64_t> outstanding_handles;
  std::uint64_t submitted_frames = 0;
  std::uint64_t published_frames = 0;
  std::uint64_t dropped_frames = 0;
  std::uint64_t release_acks = 0;
  std::uint64_t camera_preview_release_acks = 0;
  std::uint64_t premature_reuse = 0;
  std::uint64_t reset_count = 0;
  std::uint64_t maximum_quarantined = 0;
  std::uint64_t maximum_pending = 0;
  std::uint64_t maximum_remote_gpu_bytes = admission_baseline.texture_backing_bytes;
  std::uint64_t maximum_remote_gpu_generations = admission_baseline.gpu_generations;
  std::uint64_t maximum_renderer_leases = renderer_baseline.outstanding_leases;
  std::uint64_t maximum_renderer_generations =
      renderer_baseline.outstanding_generations;
  std::uint64_t maximum_video_stream_generations = 0;
  std::uint64_t renderer_fence_blocked_transitions = 0;
  std::uint64_t renderer_blocked_timed_wakeups = 0;
  std::uint64_t remote_video_pool_rollovers = 0;
  std::uint64_t demand_removals = 0;
  bool renderer_fence_blocked = false;
  bool blocked_quiescence_sampled = false;
  std::uint64_t blocked_wakeups = 0;
  std::uint64_t blocked_reads = 0;
  Clock::time_point blocked_sample_at{};
  std::uint64_t gpu_fault_hits = 0;
  bool gpu_fault_active = false;
  bool gpu_fault_complete = false;
  std::optional<std::uint64_t> gpu_arm_request_id;
  bool gpu_fault_armed_after_held = false;
  bool rollover_while_held_reported = false;
  std::uint64_t normal_audio_age_max_us = 0;
  std::uint64_t last_sampled_audio_fill = 0;
  std::vector<std::uint64_t> normal_audio_age_samples;
  normal_audio_age_samples.reserve(static_cast<std::size_t>(
      std::min<std::uint64_t>(config.duration_ms / 10 + 2, 100'000)));
  std::uint64_t post_recovery_audio_age_max_us = 0;
  std::uint64_t audio_gap_hits = 0;
  std::uint64_t completed_audio_gap_fills = 0;
  std::size_t next_audio_gap = 0;
  bool audio_gap_active = false;
  std::uint64_t audio_gap_freshness_baseline = 0;
  std::uint64_t audio_gap_rendered_baseline = 0;
  ContentionAudioRecoveryWindow<80'000> audio_recovery_window;
  std::optional<Clock::time_point> audio_armed_at;
  bool finish_requested = false;
  std::optional<Clock::time_point> finish_drain_deadline;
  std::optional<std::size_t> last_teardown_pending;

  auto baseline_threads = processThreadCount();
  auto baseline_handles = processHandleCount();
  bool resource_baseline_captured = false;
  std::optional<WindowsProcessResourceTypes> resource_type_baseline;
  bool resource_attribution_emitted = false;
  ContentionResourceBaselineGate<10> resource_baseline_gate;
  std::size_t maximum_threads = baseline_threads;
  std::size_t maximum_handles = baseline_handles;
  std::uint64_t resource_baseline_elapsed_ms = 0;
  std::uint64_t thread_peak_elapsed_ms = 0;
  std::uint64_t handle_peak_elapsed_ms = 0;
  std::string thread_peak_phase = "pre-baseline";
  std::string handle_peak_phase = "pre-baseline";
  const auto started_at = Clock::now();
  const auto deadline = started_at +
      std::chrono::milliseconds(config.duration_ms);
  auto publicationFinishDrain = [&] {
    auto drain = 2000ms;
    if (!config.livekit_fault_enabled) return drain;
    const auto hold_until = Clock::now() +
        std::chrono::milliseconds(config.livekit.duration_ms + 2'000);
    return std::max(drain, std::chrono::duration_cast<
        std::chrono::milliseconds>(hold_until - Clock::now()));
  };
  auto next_audio_at = started_at;
  auto next_resource_sample_at = started_at;
  auto next_audio_evidence_at = started_at + 250ms;
  std::uint64_t audio_evidence_sequence = 0;

  auto emitAudioEvidence = [&] {
    auto sorted_audio_age_samples = normal_audio_age_samples;
    std::sort(
        sorted_audio_age_samples.begin(), sorted_audio_age_samples.end());
    const auto snapshot = audio_output
        ? audio_output->playoutSnapshot("contention-audio")
        : std::nullopt;
    EMIT_CONTROL_STREAM(
        "AUDIO_PLAYOUT {\"protocolVersion\":" << kProtocolVersion
        << ",\"evidenceSequence\":" << ++audio_evidence_sequence
        << ",\"audioTrackId\":\"contention-audio\""
        << ",\"audioIngressFrames\":"
        << (snapshot ? snapshot->ingress_frames : 0)
        << ",\"audioRendererFillCallbacks\":"
        << (snapshot ? snapshot->renderer_fill_callbacks : 0)
        << ",\"audioRenderedTrackFrames\":"
        << (snapshot ? snapshot->rendered_track_frames : 0)
        << ",\"audioRendererFramesWritten\":"
        << (snapshot ? snapshot->renderer_frames_written : 0)
        << ",\"audioInjectedWakeGaps\":"
        << audio_adapter->injectedGaps()
        << ",\"audioRecoveredWakeGaps\":" << audio_gap_hits
        << ",\"audioRecoverySettledCount\":"
        << audio_recovery_window.settledRecoveries()
        << ",\"audioRecoveryPending\":"
        << (audio_recovery_window.recoveryPending() ? 1 : 0)
        << ",\"audioTrackFailures\":"
        << audio_track_failures.load(std::memory_order_relaxed)
        << ",\"normalAudioAgeSampleCount\":"
        << sorted_audio_age_samples.size()
        << ",\"normalAudioAgeP95Us\":"
        << sortedPercentile(sorted_audio_age_samples, 95)
        << ",\"normalAudioAgeP99Us\":"
        << sortedPercentile(sorted_audio_age_samples, 99)
        << ",\"normalAudioAgeMaxUs\":" << normal_audio_age_max_us
        << ",\"postRecoveryAudioAgeMaxUs\":"
        << post_recovery_audio_age_max_us
        << ",\"injectedAudioScheduledAgeMaxUs\":"
        << (snapshot ? snapshot->maximum_scheduled_playout_age_us : 0)
        << '}');
  };

  auto handleCommands = [&] {
    for (const auto& command : commands.readAvailable()) {
      std::istringstream input(command);
      std::string version;
      std::string type;
      std::uint64_t sequence = 0;
      std::uint64_t request_id = 0;
      input >> version >> type;
      if (version != "V1") continue;
      if (type == "FINISH") {
        input >> request_id;
        EMIT_CONTROL_STREAM(
            "FINISH_ACK {\"protocolVersion\":" << kProtocolVersion
            << ",\"requestId\":" << request_id << '}');
        finish_requested = true;
        finish_drain_deadline = Clock::now() + publicationFinishDrain();
        continue;
      }
      if (type == "REMOVE_DEMAND") {
        input >> request_id;
        if (video_bridge) {
          video_bridge->removeTrack(std::string(kRemoteTrackId), false);
          ++demand_removals;
        }
        EMIT_CONTROL_STREAM(
            "DEMAND_REMOVED {\"protocolVersion\":" << kProtocolVersion
            << ",\"requestId\":" << request_id << '}');
        continue;
      }
      if (type == "ARM_GPU_AFTER_HELD") {
        input >> request_id;
        if (!gpu_fault_complete && !gpu_fault_active &&
            !gpu_arm_request_id) {
          gpu_arm_request_id = request_id;
        }
        continue;
      }
      if (type == "ARM_AUDIO_RECOVERY") {
        input >> request_id;
        if (!audio_armed_at) audio_armed_at = Clock::now();
        EMIT_CONTROL_STREAM(
            "AUDIO_RECOVERY_ARMED {\"protocolVersion\":" << kProtocolVersion
            << ",\"requestId\":" << request_id << '}');
        continue;
      }
      input >> sequence >> request_id;
      if (type != "RELEASE_REMOTE" && type != "RELEASE_CAMERA") continue;
      const bool camera_preview = type == "RELEASE_CAMERA";
      const bool released = releaseRendererTextureLease(
          RendererTextureLeaseFence{
              camera_preview
                  ? NativeCommandType::LocalCameraPreviewFrame
                  : NativeCommandType::RemoteVideoFrame,
              "contention-session",
              7,
              std::string(camera_preview
                      ? kCameraPreviewTrackId
                      : kRemoteTrackId),
          },
          sequence);
      if (released) {
        auto& sequences = camera_preview
            ? camera_preview_outstanding_sequences
            : outstanding_sequences;
        const auto found = sequences.find(sequence);
        if (found != sequences.end()) {
          outstanding_handles.erase(found->second);
          sequences.erase(found);
        }
        if (camera_preview) {
          ++camera_preview_release_acks;
        } else {
          outstanding_timestamps.erase(sequence);
          ++release_acks;
        }
      }
      EMIT_CONTROL_STREAM(
          (camera_preview ? "CAMERA_RELEASE_ACK {\"protocolVersion\":"
                          : "RELEASE_ACK {\"protocolVersion\":")
          << kProtocolVersion
          << ",\"sequence\":" << sequence
          << ",\"requestId\":" << request_id
          << ",\"released\":" << (released ? "true" : "false") << '}');
    }
  };

  auto handlePostedCommands = [&] {
    for (auto& command : posted_commands->drain()) {
      if (command.type != NativeCommandType::RemoteVideoFrame &&
          command.type != NativeCommandType::LocalCameraPreviewFrame) {
        if (command.on_drop) command.on_drop();
        continue;
      }
      const bool camera_preview =
          command.type == NativeCommandType::LocalCameraPreviewFrame;
      if (outstanding_handles.contains(command.nt_handle)) {
        ++premature_reuse;
      }
      outstanding_handles[command.nt_handle] = command.frame_sequence;
      auto& sequences = camera_preview
          ? camera_preview_outstanding_sequences
          : outstanding_sequences;
      sequences[command.frame_sequence] = command.nt_handle;
      if (!camera_preview) {
        outstanding_timestamps[command.frame_sequence] = command.timestamp_us;
        ++published_frames;
      }
      if (!camera_preview && observed_video_handoffs.claim(
              command.source_frame_id, command.source_timestamp_us)) {
        reader_state->linked_frame_sequence.store(
            command.source_frame_id, std::memory_order_release);
        reader_state->linked_timestamp_us.store(
            command.source_timestamp_us, std::memory_order_release);
        livekit_finished.store(true, std::memory_order_release);
        EMIT_CONTROL_STREAM(
            "VIDEO_HANDOFF {\"protocolVersion\":" << kProtocolVersion
            << ",\"captureFrameId\":\"" << command.source_frame_id
            << "\",\"encodedFrameId\":\"" << command.source_frame_id
            << "\",\"publicationFrameId\":\"" << command.source_frame_id
            << "\",\"captureTimestampUs\":"
            << command.source_timestamp_us
            << ",\"source\":\"ScreenActor/D3D11H264VideoSource\"}");
      }
      std::ostringstream frame_record;
      frame_record << (camera_preview
                           ? "CAMERA_FRAME {\"protocolVersion\":"
                           : "REMOTE_FRAME {\"protocolVersion\":")
                   << kProtocolVersion
                   << ",\"ntHandle\":" << command.nt_handle
                   << ",\"sequence\":" << command.frame_sequence
                   << ",\"timestampUs\":" << command.timestamp_us
                   << ",\"width\":" << command.width
                   << ",\"height\":" << command.height
                   << ",\"sessionId\":\"contention-session\""
                   << ",\"generation\":7"
                   << ",\"trackId\":\""
                   << (camera_preview
                           ? kCameraPreviewTrackId
                           : kRemoteTrackId)
                   << "\""
                   << ",\"participantIdentity\":\""
                   << jsonEscape(config.publisher_identity) << "\""
                   << ",\"source\":\""
                   << (camera_preview ? "camera" : "screen") << "\"";
      const auto linked_timestamp =
          reader_state->linked_timestamp_us.load(std::memory_order_acquire);
      const auto linked_sequence = reader_state->linked_frame_sequence.load(
          std::memory_order_acquire);
      if (!camera_preview && linked_timestamp != 0 && linked_sequence != 0 &&
          command.source_timestamp_us == linked_timestamp &&
          command.source_frame_id == linked_sequence) {
        frame_record << ",\"pipelineFrameId\":\"" << linked_sequence
                     << "\",\"sourceTimestampUs\":"
                     << command.source_timestamp_us;
      }
      frame_record << '}';
      const auto admission = protocol_writer.enqueue(
          frame_record.str(), ProtocolRecordPriority::Frame);
      if (admission != ProtocolRecordAdmission::Accepted) {
        const bool released = releaseRendererTextureLease(
            RendererTextureLeaseFence{
                command.type,
                command.session_id,
                command.generation,
                command.track_id,
            },
            command.frame_sequence);
        outstanding_handles.erase(command.nt_handle);
        sequences.erase(command.frame_sequence);
        if (!camera_preview) {
          outstanding_timestamps.erase(command.frame_sequence);
        }
        ++dropped_frames;
        if (!released ||
            admission == ProtocolRecordAdmission::ControlSaturated) {
          throw std::runtime_error(
              "contention frame protocol drop could not exact-release");
        }
      }
      command.on_drop = {};
    }
  };

  auto releaseOutstandingRendererLeases = [&] {
    const auto release_all = [&](NativeCommandType type,
                                 std::string_view track_id,
                                 auto& sequences) {
      const RendererTextureLeaseFence fence{
          type,
          "contention-session",
          7,
          std::string(track_id),
      };
      for (const auto& [sequence, _] : sequences) {
        static_cast<void>(releaseRendererTextureLease(fence, sequence));
      }
      sequences.clear();
    };
    release_all(
        NativeCommandType::RemoteVideoFrame,
        kRemoteTrackId,
        outstanding_sequences);
    release_all(
        NativeCommandType::LocalCameraPreviewFrame,
        kCameraPreviewTrackId,
        camera_preview_outstanding_sequences);
    outstanding_timestamps.clear();
    outstanding_handles.clear();
  };

  while (Clock::now() < deadline) {
    const auto now = Clock::now();
    const auto elapsed_ms = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            now - started_at)
            .count());
    const auto elapsed_us = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            now - started_at)
            .count());
    handleCommands();
    handlePostedCommands();
    if (finish_requested) {
      const auto pending_publication =
          publication_teardown_gate.pending(screen_start_acknowledged);
      if (!last_teardown_pending ||
          *last_teardown_pending != pending_publication) {
        last_teardown_pending = pending_publication;
        EMIT_CONTROL_STREAM(
            "PUBLICATION_TEARDOWN {\"protocolVersion\":" << kProtocolVersion
            << ",\"phase\":\""
            << (pending_publication == 0 ? "ready" : "waiting")
            << "\",\"pendingPublication\":" << pending_publication
            << ",\"screenStartAcknowledged\":"
            << (screen_start_acknowledged ? 1 : 0) << '}');
      }
      if (pending_publication == 0) break;
      if (finish_drain_deadline && now >= *finish_drain_deadline) {
        EMIT_CONTROL_STREAM(
            "PUBLICATION_TEARDOWN {\"protocolVersion\":" << kProtocolVersion
            << ",\"phase\":\"timeout\",\"pendingPublication\":"
            << pending_publication << '}');
        throw std::runtime_error(
            "contention publication teardown exceeded the bounded drain");
      }
    }
    if (!video_bridge && viewer_room) {
      if (video_publication_acknowledged.load(std::memory_order_acquire)) {
        adoptRemoteVideoFromRoom(
            *viewer_room,
            viewer_track_state,
            ExpectedPublisherTrackFilter(config.publisher_identity),
            config.publisher_identity);
      }
      std::shared_ptr<livekit::Track> subscribed_track;
      std::string publication_sid;
      std::string publication_name;
      std::string publisher_identity;
      {
        std::lock_guard lock(viewer_track_state.mutex);
        subscribed_track = viewer_track_state.video_track;
        publication_sid = viewer_track_state.publication_sid;
        publication_name = viewer_track_state.publication_name;
        publisher_identity = viewer_track_state.publisher_identity;
      }
      if (subscribed_track) {
        video_bridge = std::make_unique<RemoteVideoBridge>(
            config.electron_pid,
            [posted_commands](MediaCommand command) {
              return posted_commands->push(std::move(command));
            },
            RemoteVideoBridge::OnEnded{},
            RemoteVideoBridge::OnHealthy{},
            syrnike::desktop_native::media::VideoBridgeEventTypes{},
            RemoteVideoBridge::StreamFactory{},
            syrnike::desktop_native::CleanupStartProbe{},
            &processVideoResourceAdmissionBudget(),
            [completion_fault](
                const RemoteVideoTextureCompletionPoll& observation) noexcept {
              return completion_fault->shouldWithhold(observation);
            });
        video_bridge->updateIdentity("contention-session", 7);
        video_bridge->addTrack(
            subscribed_track,
            publisher_identity,
            livekit::TrackSource::SOURCE_SCREENSHARE,
            std::string(kRemoteTrackId));
        if (config.camera_preview_enabled) {
          camera_preview_bridge = std::make_unique<RemoteVideoBridge>(
              config.electron_pid,
              [posted_commands](MediaCommand command) {
                return posted_commands->push(std::move(command));
              },
              RemoteVideoBridge::OnEnded{},
              RemoteVideoBridge::OnHealthy{},
              syrnike::desktop_native::media::VideoBridgeEventTypes{
                  .frame = NativeCommandType::LocalCameraPreviewFrame,
                  .track_removed =
                      NativeCommandType::LocalCameraPreviewTrackRemoved,
                  .failed = NativeCommandType::LocalCameraPreviewFailed,
                  .stream_label = "Contention camera preview",
              },
              [camera_preview_reader_state](
                  const std::shared_ptr<livekit::Track>&) {
                camera_preview_reader_state->factories.fetch_add(
                    1, std::memory_order_relaxed);
                return std::make_shared<ScriptedVideoReader>(
                    camera_preview_reader_state);
              },
              syrnike::desktop_native::CleanupStartProbe{},
              &processVideoResourceAdmissionBudget());
          camera_preview_bridge->updateIdentity("contention-session", 7);
          camera_preview_bridge->addTrack(
              subscribed_track,
              publisher_identity,
              livekit::TrackSource::SOURCE_CAMERA,
              std::string(kCameraPreviewTrackId));
        }
        EMIT_CONTROL_STREAM(
            "LIVEKIT_PIPELINE {\"protocolVersion\":" << kProtocolVersion
            << ",\"roomName\":\"" << jsonEscape(config.room_name)
            << "\",\"publisherIdentity\":\""
            << jsonEscape(publisher_identity)
            << "\",\"viewerIdentity\":\""
            << jsonEscape(config.viewer_identity)
            << "\",\"publicationSid\":\""
            << jsonEscape(publication_sid)
            << "\",\"publicationName\":\""
            << jsonEscape(publication_name)
            << "\",\"remoteTrackSid\":\""
            << jsonEscape(subscribed_track->sid())
            << "\",\"publicationWidth\":" << kPublishedScreenWidth
            << ",\"publicationHeight\":" << kPublishedScreenHeight
            << '}');
      }
    }
    if (protocol_writer.snapshot().write_failed) {
      auto& diagnostic_log =
          syrnike::desktop_native::diagnostics::DiagnosticLog::instance();
      if (diagnostic_log.enabled()) {
        diagnostic_log.write("probe_protocol_write_failed");
      }
      // A closed parent pipe is the recycle/shutdown signal. Throwing here
      // destroys MediaRuntime while a LiveKit FFI callback may still be on
      // the stack and abort the process with 0xC0000409.
      if (!finish_requested) {
        finish_requested = true;
        finish_drain_deadline = Clock::now() + publicationFinishDrain();
      }
    }

    if (gpu_arm_request_id && !outstanding_sequences.empty() && video_bridge) {
      const auto renderer = rendererTextureLeaseStats();
      const auto renderer_leases = renderer.outstanding_leases >=
              renderer_baseline.outstanding_leases
          ? renderer.outstanding_leases - renderer_baseline.outstanding_leases
          : 0;
      if (renderer_leases > 0) {
        const auto frame_sequence = outstanding_sequences.begin()->first;
        completion_fault->target_sequence.store(0, std::memory_order_release);
        completion_fault->target_pool_reservation_id.store(
            0, std::memory_order_release);
        completion_fault->arm_after_sequence.store(
            completion_fault->last_observed_sequence.load(
                std::memory_order_acquire),
            std::memory_order_release);
        completion_fault->observed_elapsed_us.store(
            0, std::memory_order_release);
        completion_fault->timed_out_mask.store(0, std::memory_order_release);
        completion_fault->forced_timeout_count.store(
            0, std::memory_order_release);
        completion_fault->active.store(true, std::memory_order_release);
        gpu_fault_active = true;
        gpu_fault_armed_after_held = true;
        EMIT_CONTROL_STREAM(
            "GPU_FAULT_ARMED {\"protocolVersion\":" << kProtocolVersion
            << ",\"requestId\":" << *gpu_arm_request_id
            << ",\"rendererLeases\":" << renderer_leases
            << ",\"frameSequence\":" << frame_sequence << '}');
        EMIT_CONTROL_STREAM(
            "FAULT {\"name\":\"gpuCompletionDelay\",\"phase\":\"entered\"}");
        gpu_arm_request_id.reset();
      }
    }

    if (!livekit_started && elapsed_ms >= config.screen_start_ms) {
      livekit_started = true;
      MediaCommand start_screen;
      start_screen.type = NativeCommandType::StartScreenCapture;
      start_screen.request_id = "contention-screen-start";
      start_screen.session_id = "contention-session";
      start_screen.generation = 7;
      start_screen.participant_identity = config.publisher_identity;
      start_screen.source_id = "screen:1";
      start_screen.width = kPublishedScreenWidth;
      start_screen.height = kPublishedScreenHeight;
      start_screen.fps = 30;
      start_screen.bitrate = 8'000'000;
      start_screen.audio_requested = false;
      if (!screen_runtime->dispatch(std::move(start_screen))) {
        throw std::runtime_error(
            "contention ScreenActor rejected capture start");
      }
    }
    if (livekit_started && !screen_start_acknowledged) {
      const auto start_reply = runtime_sink->waitReply(
          "contention-screen-start", 0ms);
      if (start_reply) {
        if (!start_reply->ok) {
          throw std::runtime_error(
              "contention ScreenActor capture start failed");
        }
        screen_start_acknowledged = true;
      }
    }

    const auto audio_elapsed_ms = audio_armed_at
        ? static_cast<std::uint64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(
                  now - *audio_armed_at)
                  .count())
        : 0;
    if (audio_armed_at && next_audio_gap < config.audio.size() &&
        !audio_gap_active &&
        audio_elapsed_ms >= config.audio[next_audio_gap].at_ms) {
      audio_gap_active = true;
      audio_recovery_window.enterInjectedGap();
      if (audio_output) {
        const auto snapshot =
            audio_output->playoutSnapshot("contention-audio");
        audio_gap_freshness_baseline =
            snapshot ? snapshot->freshness_recoveries : 0;
        audio_gap_rendered_baseline =
            snapshot ? snapshot->rendered_track_frames : 0;
      }
      audio_adapter->injectGap(config.audio[next_audio_gap].duration_ms);
      EMIT_CONTROL_STREAM(
          "FAULT {\"name\":\"audioSchedulingGap\",\"phase\":\"entered\",\"index\":"
          << (config.audio_index_base + next_audio_gap) << '}');
    }
    if (audio_gap_active &&
        audio_adapter->completedGapFills() > completed_audio_gap_fills) {
      const auto snapshot = audio_output
          ? audio_output->playoutSnapshot("contention-audio")
          : std::nullopt;
      const auto recovered_playout_age_us = snapshot
          ? snapshot->last_scheduled_playout_age_us
          : 0;
      const bool recovered_sample = snapshot &&
          snapshot->freshness_recoveries > audio_gap_freshness_baseline &&
          snapshot->rendered_track_frames > audio_gap_rendered_baseline;
      if (recovered_sample) {
        post_recovery_audio_age_max_us = std::max(
            post_recovery_audio_age_max_us,
            recovered_playout_age_us);
        ++audio_gap_hits;
        audio_recovery_window.markRendererRecovered();
      }
      EMIT_CONTROL_STREAM(
          "FAULT {\"name\":\"audioSchedulingGap\",\"phase\":\""
          << (recovered_sample ? "recovered" : "missed")
          << "\",\"index\":" << (config.audio_index_base + next_audio_gap)
          << ",\"scheduledPlayoutAgeUs\":" << recovered_playout_age_us
          << ",\"injectedScheduledPlayoutAgeUs\":"
          << (snapshot ? snapshot->maximum_scheduled_playout_age_us : 0)
          << ",\"rendererFillCallbacks\":"
          << (snapshot ? snapshot->renderer_fill_callbacks : 0)
          << ",\"renderedTrackFrames\":"
          << (snapshot ? snapshot->rendered_track_frames : 0) << '}');
      ++next_audio_gap;
      completed_audio_gap_fills = audio_adapter->completedGapFills();
      audio_gap_active = false;
      emitAudioEvidence();
    }

    while (now >= next_audio_at) {
      std::fill(audio_frame.data().begin(), audio_frame.data().end(),
          static_cast<std::int16_t>(
          1 + (elapsed_us / kAudioIntervalUs) % 30'000));
      audio_source->captureFrame(audio_frame);
      const auto snapshot = audio_output
          ? audio_output->playoutSnapshot("contention-audio")
          : std::nullopt;
      if (snapshot &&
          snapshot->rendered_track_frames > 0 &&
          snapshot->renderer_fill_callbacks > last_sampled_audio_fill) {
        const auto observation = audio_recovery_window.observe(
            snapshot->last_scheduled_playout_age_us);
        last_sampled_audio_fill = snapshot->renderer_fill_callbacks;
        if (observation.lane == ContentionAudioAgeLane::Normal) {
          normal_audio_age_max_us = std::max(
              normal_audio_age_max_us,
              snapshot->last_scheduled_playout_age_us);
          normal_audio_age_samples.push_back(
              snapshot->last_scheduled_playout_age_us);
        } else {
          post_recovery_audio_age_max_us = std::max(
              post_recovery_audio_age_max_us,
              snapshot->last_scheduled_playout_age_us);
        }
        if (observation.settled && next_audio_gap > 0) {
          EMIT_CONTROL_STREAM(
              "FAULT {\"name\":\"audioSchedulingGap\",\"phase\":\"settled\",\"index\":"
              << (config.audio_index_base + next_audio_gap - 1)
              << ",\"scheduledPlayoutAgeUs\":"
              << snapshot->last_scheduled_playout_age_us << '}');
        }
      }
      next_audio_at += std::chrono::microseconds(kAudioIntervalUs);
    }

    if (now >= next_audio_evidence_at) {
      emitAudioEvidence();
      next_audio_evidence_at = now + 250ms;
    }

    const auto observed_gpu_delay_us =
        completion_fault->observed_elapsed_us.load(std::memory_order_acquire);
    if (gpu_fault_hits == 0 &&
        completion_fault->forced_timeout_count.load(
            std::memory_order_acquire) > 0 &&
        observed_gpu_delay_us >= 500'000) {
      ++gpu_fault_hits;
      const auto frame_sequence = outstanding_timestamps.empty()
          ? 0
          : outstanding_timestamps.begin()->first;
      const auto capture_timestamp_us = frame_sequence == 0
          ? steadyNowUs()
          : outstanding_timestamps.at(frame_sequence);
      EMIT_CONTROL_STREAM(
          "FAULT {\"name\":\"gpuCompletionDelay\",\"phase\":\"observed\",\"durationUs\":"
          << observed_gpu_delay_us << '}');
      EMIT_CONTROL_STREAM(
          "TIMELINE {\"event\":\"media_timeline\",\"stage\":\"gpu_completion_timeout\",\"sessionId\":\"contention-session\",\"generation\":7,\"trackId\":\""
          << kRemoteTrackId << "\",\"frameSequence\":" << frame_sequence
          << ",\"nativeCaptureTimestampUs\":" << capture_timestamp_us
          << ",\"runtimeEpoch\":1,\"anomaly\":true,\"reason\":\"gpu-completion-timeout\",\"durationUs\":"
          << observed_gpu_delay_us << '}');
    }

    if (video_bridge) {
      const auto snapshot = video_bridge->trackSnapshot(std::string(kRemoteTrackId));
      if (snapshot) {
        submitted_frames = std::max(submitted_frames, snapshot->frames_submitted);
        published_frames = std::max(published_frames, snapshot->frames_published);
        remote_video_pool_rollovers = std::max(
            remote_video_pool_rollovers, snapshot->gpu_pool_rollovers);
        maximum_video_stream_generations = std::max(
            maximum_video_stream_generations,
            snapshot->stream_generations);
        if (gpu_fault_armed_after_held && !rollover_while_held_reported &&
            snapshot->gpu_pool_rollovers > 0 &&
            !outstanding_sequences.empty()) {
          const auto rollover_usage =
              processVideoResourceAdmissionBudget().usageFor(
                  VideoResourceOwner::RemoteVideo, kRemoteResourceOwner);
          const auto rollover_renderer = rendererTextureLeaseStats();
          const auto renderer_leases =
              rollover_renderer.outstanding_leases >=
                      renderer_baseline.outstanding_leases
                  ? rollover_renderer.outstanding_leases -
                        renderer_baseline.outstanding_leases
                  : 0;
          const auto gpu_generations =
              rollover_usage.gpu_generations >= admission_baseline.gpu_generations
                  ? rollover_usage.gpu_generations -
                        admission_baseline.gpu_generations
                  : 0;
          if (renderer_leases > 0 && gpu_generations >= 2) {
            rollover_while_held_reported = true;
            gpu_fault_active = false;
            gpu_fault_complete = true;
            completion_fault->active.store(false, std::memory_order_release);
            EMIT_CONTROL_STREAM(
                "ROLLOVER_WHILE_HELD {\"protocolVersion\":"
                << kProtocolVersion << ",\"rendererLeases\":"
                << renderer_leases << ",\"remoteGpuGenerations\":"
                << gpu_generations << ",\"gpuPoolRollovers\":"
                << snapshot->gpu_pool_rollovers << ",\"forcedTimeouts\":"
                << completion_fault->forced_timeout_count.load(
                       std::memory_order_acquire)
                << '}');
          }
        }
        if (snapshot->renderer_flow ==
                RemoteVideoRendererFlowState::FenceBlocked &&
            !renderer_fence_blocked) {
          const auto blocked_usage =
              processVideoResourceAdmissionBudget().usageFor(
                  VideoResourceOwner::RemoteVideo, kRemoteResourceOwner);
          const auto blocked_renderer = rendererTextureLeaseStats();
          renderer_fence_blocked = true;
          blocked_quiescence_sampled = false;
          ++renderer_fence_blocked_transitions;
          blocked_sample_at = {};
          EMIT_CONTROL_STREAM(
              "BRIDGE_STATUS {\"protocolVersion\":" << kProtocolVersion
              << ",\"state\":\"fence-blocked\",\"framesRead\":"
              << snapshot->frames_read << ",\"framesPublished\":"
               << snapshot->frames_published << ",\"gpuPoolRollovers\":"
               << snapshot->gpu_pool_rollovers
               << ",\"configuredRemoteGpuBytes\":"
               << blocked_usage.texture_backing_bytes
               << ",\"remoteGpuGenerations\":"
               << blocked_usage.gpu_generations
               << ",\"rendererLeases\":"
               << blocked_renderer.outstanding_leases
               << ",\"rendererGenerations\":"
               << blocked_renderer.outstanding_generations << '}');
        }
        if (renderer_fence_blocked && !blocked_quiescence_sampled &&
            snapshot->gpu_pump_quiescent) {
          if (blocked_sample_at == Clock::time_point{}) {
            blocked_wakeups = snapshot->gpu_pump_wakeups;
            blocked_reads = snapshot->frames_read;
            blocked_sample_at = now + 100ms;
          } else if (now >= blocked_sample_at) {
            blocked_quiescence_sampled = true;
            renderer_blocked_timed_wakeups +=
                snapshot->gpu_pump_wakeups >= blocked_wakeups
                    ? snapshot->gpu_pump_wakeups - blocked_wakeups
                    : 0;
            EMIT_CONTROL_STREAM(
                "BRIDGE_STATUS {\"protocolVersion\":" << kProtocolVersion
                << ",\"state\":\"fence-quiescent\",\"gpuPumpQuiescent\":true"
                << ",\"readDelta\":"
                << (snapshot->frames_read >= blocked_reads
                        ? snapshot->frames_read - blocked_reads
                        : 0)
                << ",\"wakeDelta\":"
                << (snapshot->gpu_pump_wakeups >= blocked_wakeups
                        ? snapshot->gpu_pump_wakeups - blocked_wakeups
                        : 0)
                << '}');
          }
        }
        if (snapshot->renderer_flow !=
            RemoteVideoRendererFlowState::FenceBlocked) {
          renderer_fence_blocked = false;
          blocked_sample_at = {};
        }
      }
    }

    maximum_pending = std::max<std::uint64_t>(
        maximum_pending,
        outstanding_sequences.size() +
            camera_preview_outstanding_sequences.size() +
            posted_commands->size());
    if (now >= next_resource_sample_at) {
      const auto renderer_stats = rendererTextureLeaseStats();
      maximum_renderer_leases = std::max<std::uint64_t>(
          maximum_renderer_leases, renderer_stats.outstanding_leases);
      maximum_renderer_generations = std::max<std::uint64_t>(
          maximum_renderer_generations, renderer_stats.outstanding_generations);
      const auto usage = processVideoResourceAdmissionBudget().usageFor(
          VideoResourceOwner::RemoteVideo, kRemoteResourceOwner);
      maximum_remote_gpu_bytes = std::max(
          maximum_remote_gpu_bytes, usage.texture_backing_bytes);
      maximum_remote_gpu_generations = std::max(
          maximum_remote_gpu_generations, usage.gpu_generations);
      maximum_quarantined = std::max<std::uint64_t>(
          maximum_quarantined,
          usage.gpu_generations > 0 ? usage.gpu_generations - 1 : 0);
      const auto baseline_audio = audio_output
          ? audio_output->playoutSnapshot("contention-audio")
          : std::nullopt;
      const auto linked_video_delivered =
          livekit_finished.load(std::memory_order_acquire);
      const auto pending_startup_operations =
          static_cast<std::size_t>(!screen_start_acknowledged) +
          static_cast<std::size_t>(
              !video_publication_acknowledged.load(std::memory_order_acquire));
      const auto audio_ingress_frames =
          baseline_audio ? baseline_audio->ingress_frames : 0;
      const auto audio_renderer_fills =
          baseline_audio ? baseline_audio->renderer_fill_callbacks : 0;
      const auto baseline_ready = !resource_baseline_captured &&
          resource_baseline_gate.observe(
              linked_video_delivered,
              audio_ingress_frames,
              audio_renderer_fills,
              pending_startup_operations);
      if (!resource_baseline_captured) {
        const char* reset_reason = "ready";
        if (!linked_video_delivered) reset_reason = "linked-video";
        else if (audio_ingress_frames == 0) reset_reason = "audio-ingress";
        else if (audio_renderer_fills == 0) reset_reason = "audio-fill";
        else if (pending_startup_operations != 0) {
          reset_reason = "pending-startup";
        }
        const auto video_watch = inspectRemoteVideoSubscribe(
            viewer_room.get(),
            viewer_track_state,
            config.publisher_identity);
        EMIT_CONTROL_STREAM(
            "RESOURCE_BASELINE_SAMPLE {\"protocolVersion\":"
            << kProtocolVersion
            << ",\"linkedVideoDelivered\":"
            << (linked_video_delivered ? 1 : 0)
            << ",\"audioIngressFrames\":" << audio_ingress_frames
            << ",\"audioRendererFills\":" << audio_renderer_fills
            << ",\"pendingStartup\":" << pending_startup_operations
            << ",\"stableSamples\":"
            << resource_baseline_gate.stableSamples()
            << ",\"resetReason\":\"" << reset_reason << "\""
            << ",\"videoTrackPresent\":"
            << (video_watch.video_track_present ? 1 : 0)
            << ",\"remotePublisherPresent\":"
            << (video_watch.publisher_present ? 1 : 0)
            << ",\"remoteVideoPublications\":"
            << video_watch.video_publications
            << ",\"remoteVideoSubscribed\":"
            << video_watch.subscribed_publications
            << ",\"rejectedTracks\":" << video_watch.rejected_tracks
            << ",\"snapshotAdoptions\":" << video_watch.snapshot_adoptions
            << ",\"subscribeRequests\":"
            << video_watch.subscribe_requests << '}');
      }
      if (baseline_ready) {
        baseline_threads = processThreadCount();
        baseline_handles = processHandleCount();
        maximum_threads = baseline_threads;
        maximum_handles = baseline_handles;
        resource_type_baseline = captureWindowsProcessResourceTypes();
        resource_baseline_elapsed_ms = elapsed_ms;
        thread_peak_elapsed_ms = elapsed_ms;
        handle_peak_elapsed_ms = elapsed_ms;
        thread_peak_phase = "stable-media";
        handle_peak_phase = "stable-media";
        resource_baseline_captured = true;
      } else if (resource_baseline_captured) {
        const auto sampled_threads = processThreadCount();
        const auto sampled_handles = processHandleCount();
        if (!resource_attribution_emitted && resource_type_baseline &&
            (sampled_threads > baseline_threads + 16 ||
             sampled_handles > baseline_handles + 64)) {
          const auto observed_types = captureWindowsProcessResourceTypes();
          const auto thread_delta = resourceTypeDelta(
              resource_type_baseline->threads, observed_types.threads, 64);
          const auto handle_delta = resourceTypeDelta(
              resource_type_baseline->handles, observed_types.handles, 64);
          const auto write_types = [](std::ostringstream& record,
                                      const auto& values) {
            record << '[';
            for (std::size_t index = 0; index < values.size(); ++index) {
              if (index != 0) record << ',';
              record << "{\"category\":\""
                     << jsonEscape(values[index].category)
                     << "\",\"count\":" << values[index].count << '}';
            }
            record << ']';
          };
          std::ostringstream attribution;
          attribution
              << "RESOURCE_ATTRIBUTION {\"protocolVersion\":"
              << kProtocolVersion << ",\"elapsedMs\":" << elapsed_ms
              << ",\"phase\":\"steady-media\",\"threadBaseline\":"
              << baseline_threads << ",\"threadObserved\":"
              << sampled_threads << ",\"handleBaseline\":"
              << baseline_handles << ",\"handleObserved\":"
              << sampled_handles << ",\"threadTypes\":";
          write_types(attribution, thread_delta);
          attribution << ",\"handleTypes\":";
          write_types(attribution, handle_delta);
          attribution << '}';
          emitControl(protocol_writer, attribution.str());
          resource_attribution_emitted = true;
        }
        if (sampled_threads > maximum_threads) {
          maximum_threads = sampled_threads;
          thread_peak_elapsed_ms = elapsed_ms;
          thread_peak_phase = "steady-media";
        }
        if (sampled_handles > maximum_handles) {
          maximum_handles = sampled_handles;
          handle_peak_elapsed_ms = elapsed_ms;
          handle_peak_phase = "steady-media";
        }
      }
      const auto current_renderer_leases =
          renderer_stats.outstanding_leases >=
                  renderer_baseline.outstanding_leases
              ? renderer_stats.outstanding_leases -
                    renderer_baseline.outstanding_leases
              : 0;
      const auto current_gpu_generations =
          usage.gpu_generations >= admission_baseline.gpu_generations
              ? usage.gpu_generations - admission_baseline.gpu_generations
              : 0;
      EMIT_CONTROL_STREAM(
          "LIFECYCLE_STATUS {\"protocolVersion\":" << kProtocolVersion
          << ",\"screenStartAcknowledged\":"
          << (screen_start_acknowledged ? 1 : 0)
          << ",\"videoPublicationAcknowledged\":"
          << (video_publication_acknowledged.load(std::memory_order_acquire)
                  ? 1
                  : 0)
          << ",\"pendingStartup\":" << pending_startup_operations
          << ",\"pendingReleaseOperations\":"
          << (outstanding_sequences.size() +
              camera_preview_outstanding_sequences.size() +
              posted_commands->size())
          << ",\"rendererLeases\":" << current_renderer_leases
          << ",\"remoteGpuGenerations\":" << current_gpu_generations
          << ",\"resourceBaselineCaptured\":"
          << (resource_baseline_captured ? 1 : 0) << '}');
      next_resource_sample_at = now + 100ms;
    }
    std::this_thread::sleep_for(1ms);
  }

  if (video_bridge &&
      video_bridge->trackSnapshot(std::string(kRemoteTrackId))) {
    video_bridge->removeTrack(std::string(kRemoteTrackId), false);
    ++demand_removals;
  }
  if (camera_preview_bridge && camera_preview_bridge->trackSnapshot(
          std::string(kCameraPreviewTrackId))) {
    camera_preview_bridge->removeTrack(
        std::string(kCameraPreviewTrackId), false);
  }
  const auto drain_deadline = Clock::now() + 2s;
  while ((!outstanding_sequences.empty() ||
          !camera_preview_outstanding_sequences.empty()) &&
         Clock::now() < drain_deadline) {
    handleCommands();
    handlePostedCommands();
    std::this_thread::sleep_for(1ms);
  }
  if (video_bridge) {
    video_bridge->stop();
    video_bridge.reset();
  }
  if (camera_preview_bridge) {
    camera_preview_bridge->stop();
    camera_preview_bridge.reset();
  }
  handlePostedCommands();
  // Electron skips RELEASE_REMOTE for frames from a retired probe epoch, and
  // an injected renderer-fence delay can outlive the 6s CI churn window.
  // Force-drop leftover leases after the bounded wait so terminal drain
  // measures native leaks rather than a renderer that will never ack.
  releaseOutstandingRendererLeases();
  const auto resource_cleanup_deadline = Clock::now() + 2s;
  while (Clock::now() < resource_cleanup_deadline) {
    const auto renderer = rendererTextureLeaseStats();
    const auto usage = processVideoResourceAdmissionBudget().usageFor(
        VideoResourceOwner::RemoteVideo, kRemoteResourceOwner);
    const auto camera_usage = processVideoResourceAdmissionBudget().usageFor(
        VideoResourceOwner::RemoteVideo, kCameraPreviewResourceOwner);
    if (renderer.outstanding_leases <= renderer_baseline.outstanding_leases &&
        usage.texture_backing_bytes <= admission_baseline.texture_backing_bytes &&
        usage.gpu_generations <= admission_baseline.gpu_generations &&
        camera_usage.texture_backing_bytes <=
            camera_admission_baseline.texture_backing_bytes &&
        camera_usage.gpu_generations <=
            camera_admission_baseline.gpu_generations) {
      break;
    }
    handlePostedCommands();
    std::this_thread::sleep_for(1ms);
  }
  posted_commands->close();
  const auto audio_playout = audio_output
      ? audio_output->playoutSnapshot("contention-audio")
      : std::nullopt;
  emitAudioEvidence();
  disconnect_viewer_before_runtime.disconnect();
  if (audio_output) {
    audio_output->stop();
    audio_output.reset();
  }
  screen_runtime->requestShutdown();
  screen_runtime->shutdownAndWait();
  screen_runtime.reset();
  audio_track.reset();
  audio_source.reset();
  real_livekit.reset();

  ContentionTerminalResourceGate terminal_resource_gate;
  ContentionTerminalResourceState terminal_resource_state;
  const auto terminal_resource_deadline =
      Clock::now() + syrnike::desktop_native::media::kNativeShutdownBudget;
  while (true) {
    handleCommands();
    handlePostedCommands();

    if (livekit_lifetime && livekit_lifetime.use_count() == 1) {
      livekit_lifetime.reset();
    }
    const auto cleanup =
        syrnike::desktop_native::CleanupSupervisor::instance().snapshot();
    const auto renderer = rendererTextureLeaseStats();
    const auto usage = processVideoResourceAdmissionBudget().usageFor(
        VideoResourceOwner::RemoteVideo, kRemoteResourceOwner);
    const auto camera_usage = processVideoResourceAdmissionBudget().usageFor(
        VideoResourceOwner::RemoteVideo, kCameraPreviewResourceOwner);
    const auto livekit_shutdown_complete =
        !livekit_lifetime &&
        syrnike::desktop_native::media::LiveKitLease::activeCount() == 0 &&
        syrnike::desktop_native::media::LiveKitLease::shutdownTransitionCount() ==
            livekit_shutdown_transition_before + 1;
    terminal_resource_state = {
        .native_pending = outstanding_sequences.size() +
            camera_preview_outstanding_sequences.size() +
            posted_commands->size() +
            publication_teardown_gate.pending(screen_start_acknowledged),
        .held_leases = outstanding_sequences.size() +
            camera_preview_outstanding_sequences.size(),
        .renderer_leases = renderer.outstanding_leases >=
                renderer_baseline.outstanding_leases
            ? renderer.outstanding_leases -
                  renderer_baseline.outstanding_leases
            : 0,
        .gpu_generations =
            (usage.gpu_generations >= admission_baseline.gpu_generations
                 ? usage.gpu_generations - admission_baseline.gpu_generations
                 : 0) +
            (camera_usage.gpu_generations >=
                     camera_admission_baseline.gpu_generations
                 ? camera_usage.gpu_generations -
                       camera_admission_baseline.gpu_generations
                 : 0),
        .cleanup_owned = cleanup.owned_jobs,
        .cleanup_active = cleanup.active_jobs,
        .cleanup_backlog = cleanup.backlog_jobs,
        .livekit_shutdown_complete = livekit_shutdown_complete,
    };
    if (terminal_resource_gate.ready(terminal_resource_state)) break;
    if (Clock::now() >= terminal_resource_deadline) {
      throw std::runtime_error(
          "contention terminal resource drain exceeded: " +
          std::string(terminal_resource_gate.blocker(terminal_resource_state)) +
          " nativePending=" +
          std::to_string(terminal_resource_state.native_pending) +
          " posted=" + std::to_string(posted_commands->size()) +
          " teardown=" +
          std::to_string(publication_teardown_gate.pending(
              screen_start_acknowledged)) +
          " held=" + std::to_string(terminal_resource_state.held_leases) +
          " renderer=" +
          std::to_string(terminal_resource_state.renderer_leases) +
          " gpu=" + std::to_string(terminal_resource_state.gpu_generations) +
          " cleanup=" +
          std::to_string(terminal_resource_state.cleanup_owned) + "/" +
          std::to_string(terminal_resource_state.cleanup_active) + "/" +
          std::to_string(terminal_resource_state.cleanup_backlog) +
          " accepted=" + std::to_string(cleanup.accepted_jobs) +
          " completed=" + std::to_string(cleanup.completed_jobs) +
          " livekitLifetime=" +
          std::to_string(livekit_lifetime.use_count()) +
          " livekit=" +
          (terminal_resource_state.livekit_shutdown_complete ? "1" : "0"));
    }
    std::this_thread::sleep_for(1ms);
  }

  const auto final_threads = processThreadCount();
  const auto final_handles = processHandleCount();
  const auto final_elapsed_ms = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          Clock::now() - started_at)
          .count());
  if (final_threads > maximum_threads) {
    maximum_threads = final_threads;
    thread_peak_elapsed_ms = final_elapsed_ms;
    thread_peak_phase = "teardown";
  }
  if (final_handles > maximum_handles) {
    maximum_handles = final_handles;
    handle_peak_elapsed_ms = final_elapsed_ms;
    handle_peak_phase = "teardown";
  }
  const auto final_renderer = rendererTextureLeaseStats();
  const auto final_remote_usage =
      processVideoResourceAdmissionBudget().usageFor(
          VideoResourceOwner::RemoteVideo, kRemoteResourceOwner);
  const auto final_camera_preview_usage =
      processVideoResourceAdmissionBudget().usageFor(
          VideoResourceOwner::RemoteVideo, kCameraPreviewResourceOwner);
  const auto final_renderer_leases =
      final_renderer.outstanding_leases >= renderer_baseline.outstanding_leases
          ? final_renderer.outstanding_leases -
                renderer_baseline.outstanding_leases
          : 0;
  const auto final_pending = outstanding_sequences.size() +
      camera_preview_outstanding_sequences.size();
  const auto final_thread_delta = final_threads >= baseline_threads
      ? final_threads - baseline_threads
      : 0;
  std::sort(
      normal_audio_age_samples.begin(), normal_audio_age_samples.end());
  const auto normal_audio_age_p95_us =
      sortedPercentile(normal_audio_age_samples, 95);
  const auto normal_audio_age_p99_us =
      sortedPercentile(normal_audio_age_samples, 99);

  std::ostringstream summary_record;
  summary_record << "SUMMARY {"
            << "\"protocolVersion\":" << kProtocolVersion
            << ",\"elapsedMs\":" << config.duration_ms
            << ",\"submittedFrames\":" << submitted_frames
            << ",\"publishedFrames\":" << published_frames
            << ",\"droppedFrames\":" << dropped_frames
            << ",\"releaseAcks\":" << release_acks
             << ",\"gpuFaultHits\":" << gpu_fault_hits
            << ",\"gpuFaultArmedAfterHeld\":"
            << (gpu_fault_armed_after_held ? 1 : 0)
             << ",\"rolloverWhileHeldProofs\":"
            << (rollover_while_held_reported ? 1 : 0)
            << ",\"gpuFaultForcedTimeouts\":"
            << completion_fault->forced_timeout_count.load(
                   std::memory_order_acquire)
            << ",\"liveKitFaultHits\":"
            << livekit_fault_hits.load(std::memory_order_relaxed)
            << ",\"audioGapHits\":" << audio_gap_hits
            << ",\"audioRecoverySettledCount\":"
            << audio_recovery_window.settledRecoveries()
            << ",\"audioRecoveryPending\":"
            << (audio_recovery_window.recoveryPending() ? 1 : 0)
            << ",\"normalAudioAgeSampleCount\":"
            << normal_audio_age_samples.size()
            << ",\"normalAudioAgeP95Us\":" << normal_audio_age_p95_us
            << ",\"normalAudioAgeP99Us\":" << normal_audio_age_p99_us
            << ",\"normalAudioAgeMaxUs\":" << normal_audio_age_max_us
            << ",\"postRecoveryAudioAgeMaxUs\":"
            << post_recovery_audio_age_max_us
            << ",\"audioFreshnessRecoveries\":"
            << (audio_playout ? audio_playout->freshness_recoveries : 0)
            << ",\"injectedAudioScheduledAgeMaxUs\":"
            << (audio_playout
                    ? audio_playout->maximum_scheduled_playout_age_us
                    : 0)
            << ",\"audioTrackId\":\"contention-audio\""
            << ",\"audioIngressFrames\":"
            << (audio_playout ? audio_playout->ingress_frames : 0)
            << ",\"audioRendererFillCallbacks\":"
            << (audio_playout ? audio_playout->renderer_fill_callbacks : 0)
            << ",\"audioRenderedTrackFrames\":"
            << (audio_playout ? audio_playout->rendered_track_frames : 0)
            << ",\"audioRendererFramesWritten\":"
            << (audio_playout ? audio_playout->renderer_frames_written : 0)
            << ",\"audioInjectedWakeGaps\":"
            << audio_adapter->injectedGaps()
            << ",\"audioRecoveredWakeGaps\":" << audio_gap_hits
            << ",\"audioTrackFailures\":"
            << audio_track_failures.load(std::memory_order_relaxed)
            << ",\"threadDeltaMax\":"
            << (maximum_threads >= baseline_threads
                    ? maximum_threads - baseline_threads
                    : 0)
            << ",\"threadDeltaFinal\":" << final_thread_delta
            << ",\"threadBaseline\":" << baseline_threads
            << ",\"threadPeak\":" << maximum_threads
            << ",\"threadPeakElapsedMs\":" << thread_peak_elapsed_ms
            << ",\"threadPeakPhase\":\"" << thread_peak_phase << "\""
            << ",\"threadFinal\":" << final_threads
            << ",\"resourceBaselineCaptured\":"
            << (resource_baseline_captured ? 1 : 0)
            << ",\"resourceBaselineElapsedMs\":"
            << resource_baseline_elapsed_ms
            << ",\"handleDeltaMax\":"
            << (maximum_handles >= baseline_handles
                    ? maximum_handles - baseline_handles
                    : 0)
            << ",\"handleBaseline\":" << baseline_handles
            << ",\"handlePeak\":" << maximum_handles
            << ",\"handlePeakElapsedMs\":" << handle_peak_elapsed_ms
            << ",\"handlePeakPhase\":\"" << handle_peak_phase << "\""
            << ",\"handleFinal\":" << final_handles
            << ",\"pendingOperationsMax\":" << maximum_pending
            << ",\"finalPendingOperations\":" << final_pending
            << ",\"maximumActiveGenerations\":"
            << maximum_remote_gpu_generations
            << ",\"maximumQuarantinedGenerations\":"
            << maximum_quarantined
            << ",\"maximumActiveBackends\":1"
            << ",\"maximumQuarantinedBackends\":0"
            << ",\"approximateGpuBytesMax\":" << maximum_remote_gpu_bytes
            << ",\"configuredRemoteFourKPoolBytes\":"
            << configured_four_k_pool_bytes
            << ",\"configuredRemoteGpuBytesMax\":"
            << maximum_remote_gpu_bytes
            << ",\"maximumRemoteGpuGenerations\":"
            << maximum_remote_gpu_generations
            << ",\"maximumRemoteRendererLeases\":"
            << (maximum_renderer_leases >= renderer_baseline.outstanding_leases
                    ? maximum_renderer_leases -
                          renderer_baseline.outstanding_leases
                    : 0)
            << ",\"maximumRemoteRendererGenerations\":"
            << (maximum_renderer_generations >=
                    renderer_baseline.outstanding_generations
                    ? maximum_renderer_generations -
                          renderer_baseline.outstanding_generations
                    : 0)
            << ",\"rendererFenceBlockedTransitions\":"
            << renderer_fence_blocked_transitions
            << ",\"rendererBlockedTimedWakeups\":"
            << renderer_blocked_timed_wakeups
            << ",\"remoteVideoPoolRollovers\":"
            << remote_video_pool_rollovers
            << ",\"videoStreamGenerations\":"
            << maximum_video_stream_generations
            << ",\"demandRemovals\":" << demand_removals
            << ",\"finalRemoteRendererLeases\":"
            << final_renderer_leases
            << ",\"finalRemoteUsageBytes\":"
            << (final_remote_usage.texture_backing_bytes >=
                    admission_baseline.texture_backing_bytes
                    ? final_remote_usage.texture_backing_bytes -
                          admission_baseline.texture_backing_bytes
                    : 0)
            << ",\"finalRemoteUsageGenerations\":"
            << (final_remote_usage.gpu_generations >=
                    admission_baseline.gpu_generations
                    ? final_remote_usage.gpu_generations -
                          admission_baseline.gpu_generations
                    : 0)
            << ",\"finalCameraPreviewUsageBytes\":"
            << (final_camera_preview_usage.texture_backing_bytes >=
                    camera_admission_baseline.texture_backing_bytes
                    ? final_camera_preview_usage.texture_backing_bytes -
                          camera_admission_baseline.texture_backing_bytes
                    : 0)
            << ",\"finalCameraPreviewUsageGenerations\":"
            << (final_camera_preview_usage.gpu_generations >=
                    camera_admission_baseline.gpu_generations
                    ? final_camera_preview_usage.gpu_generations -
                          camera_admission_baseline.gpu_generations
                    : 0)
            << ",\"finalCleanupOwned\":"
            << terminal_resource_state.cleanup_owned
            << ",\"finalCleanupActive\":"
            << terminal_resource_state.cleanup_active
            << ",\"finalCleanupBacklog\":"
            << terminal_resource_state.cleanup_backlog
            << ",\"liveKitShutdownComplete\":"
            << (terminal_resource_state.livekit_shutdown_complete ? 1 : 0)
            << ",\"prematureTextureReuse\":" << premature_reuse
            << ",\"cameraPreviewReleaseAcks\":"
            << camera_preview_release_acks
            << ",\"finalCameraPreviewFrames\":"
            << camera_preview_outstanding_sequences.size()
            << ",\"resetCount\":" << reset_count
            << ",\"republishCount\":"
            << (livekit_finished.load(std::memory_order_acquire) ? 1 : 0)
            << ",\"finalHeldLeases\":"
            << (outstanding_sequences.size() +
                camera_preview_outstanding_sequences.size())
            << '}';
  emitControl(protocol_writer, summary_record.str());
  if (!protocol_writer.closeUntil(Clock::now() + 1s)) {
    std::cerr << "contention protocol writer could not be cancelled" << std::endl;
    std::quick_exit(EXIT_FAILURE);
  }

#undef EMIT_CONTROL_STREAM

  }
  if (livekit_lifetime ||
      syrnike::desktop_native::media::LiveKitLease::activeCount() != 0) {
    throw std::runtime_error(
        "contention summary preceded LiveKit terminal shutdown");
  }

  return 0;
} catch (const std::exception& error) {
  std::cerr << "media contention probe failed: " << error.what() << '\n';
  return 1;
}
