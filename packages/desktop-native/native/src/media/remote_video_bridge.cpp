#include "remote_video_bridge.hpp"

#include <livekit/video_stream.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <exception>
#include <future>
#include <latch>
#include <memory>
#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

#include "../common/diagnostic_log.hpp"
#include "remote_video_texture_pool.hpp"

namespace syrnike::desktop_native::media {
namespace {
constexpr std::size_t max_in_flight = 3;
constexpr std::size_t max_retired_gpu_generations = 2;
constexpr std::size_t max_process_gpu_retirements = 4;

#ifdef _WIN32
class RemoteVideoGpuRetirementQueue final {
 public:
  static RemoteVideoGpuRetirementQueue& instance() {
    static RemoteVideoGpuRetirementQueue queue;
    return queue;
  }

  ~RemoteVideoGpuRetirementQueue() {
    worker_.request_stop();
    changed_.notify_all();
  }

  [[nodiscard]] bool acceptsNewGeneration() const {
    std::lock_guard lock(mutex_);
    return pools_.size() < max_process_gpu_retirements;
  }

  void retire(std::unique_ptr<RemoteVideoTexturePool> pool) noexcept {
    try {
      if (!pool || pool->retirementSafe()) return;
      {
        std::lock_guard lock(mutex_);
        pools_.push_back(std::move(pool));
      }
      changed_.notify_one();
    } catch (...) {
      // Teardown must stay non-blocking and noexcept. In the exceptional
      // out-of-memory path, intentionally retain the pending D3D resources
      // until process exit instead of releasing them on the media thread.
      static_cast<void>(pool.release());
    }
  }

 private:
  RemoteVideoGpuRetirementQueue()
      : worker_([this](std::stop_token stop) { reap(stop); }) {}

  void reap(std::stop_token stop) noexcept {
    try {
      std::unique_lock lock(mutex_);
      while (!stop.stop_requested()) {
        changed_.wait_for(lock, std::chrono::milliseconds(50));
        for (auto iterator = pools_.begin(); iterator != pools_.end();) {
          const auto result = (*iterator)->poll();
          if (result.reset_required || (*iterator)->retirementSafe()) {
            iterator = pools_.erase(iterator);
          } else {
            ++iterator;
          }
        }
      }
    } catch (...) {
      // Retained resources remain owned by the queue. A reaper failure must
      // never terminate the media utility or move teardown onto a track thread.
    }
  }

  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<std::unique_ptr<RemoteVideoTexturePool>> pools_;
  std::jthread worker_;
};

std::unique_ptr<RemoteVideoTexturePool> createRemoteVideoTexturePool(
    std::uint32_t electron_main_pid) {
  if (!RemoteVideoGpuRetirementQueue::instance().acceptsNewGeneration()) {
    throw std::runtime_error(
      "remote video GPU retirement capacity is temporarily exhausted");
  }
  return std::make_unique<RemoteVideoTexturePool>(electron_main_pid);
}

struct RemoteVideoGpuPoolSet final {
  std::unique_ptr<RemoteVideoTexturePool> active;
  std::vector<std::unique_ptr<RemoteVideoTexturePool>> retired;

  ~RemoteVideoGpuPoolSet() {
    auto& queue = RemoteVideoGpuRetirementQueue::instance();
    queue.retire(std::move(active));
    for (auto& pool : retired) queue.retire(std::move(pool));
  }
};
#endif

void logRemoteVideoFailure(
  const std::string& track_id,
  const std::string& source,
  std::string message
) {
  diagnostics::DiagnosticLog::instance().write(
    "remote_video_bridge_failed",
    {
      {"trackId", track_id},
      {"videoSource", source},
      {"message", std::move(message)}
    }
  );
}

class LiveKitVideoStreamReader final : public RemoteVideoBridge::StreamReader {
 public:
  explicit LiveKitVideoStreamReader(
    const std::shared_ptr<livekit::Track>& track
  ) {
    livekit::VideoStream::Options options;
    options.capacity = 1;
    options.format = livekit::VideoBufferType::BGRA;
    stream_ = livekit::VideoStream::fromTrack(track, options);
  }

  bool read(livekit::VideoFrameEvent& event) override {
    return stream_->read(event);
  }

  void close() override {
    stream_->close();
  }

 private:
  std::shared_ptr<livekit::VideoStream> stream_;
};
}  // namespace

struct RemoteVideoBridge::TrackWorker {
  std::shared_ptr<livekit::Track> track;
  std::shared_ptr<StreamReader> stream;
  std::thread thread;
  std::thread first_frame_watchdog;
  std::atomic_bool stopped{false};
  std::latch committed{1};
  std::atomic<FirstFrameState> first_frame_state{FirstFrameState::Pending};
  std::mutex frames_mutex;
#ifdef _WIN32
  std::unordered_map<std::uint64_t, std::shared_ptr<void>> frames;
#endif
};

RemoteVideoBridge::RemoteVideoBridge(
  std::uint32_t electron_main_pid,
  Post post,
  OnEnded on_ended,
  OnHealthy on_healthy,
  VideoBridgeEventTypes event_types,
  StreamFactory stream_factory,
  AsyncCleanupLauncher cleanup_launcher
) : cleanup_dispatcher_(&AsyncCleanupDispatcher::instance()),
    cleanup_node_(std::make_shared<AsyncCleanupNode>(
      std::move(cleanup_launcher)
    )),
    electron_main_pid_(electron_main_pid),
    post_(std::move(post)),
    on_ended_(std::move(on_ended)),
    on_healthy_(std::move(on_healthy)),
    event_types_(std::move(event_types)),
    stream_factory_(
      stream_factory
        ? std::move(stream_factory)
        : StreamFactory([](const std::shared_ptr<livekit::Track>& track) {
            return std::make_shared<LiveKitVideoStreamReader>(track);
          })
    ),
    release_router_(std::make_shared<LifetimeSafeFrameRelease>(
      [this](const std::string& track_id, std::uint64_t sequence) {
        release(track_id, sequence);
      }
    )) {}

RemoteVideoBridge::~RemoteVideoBridge() {
  stop();
  release_router_->detach();
}

std::string remoteVideoSourceLabel(
  std::optional<livekit::TrackSource> publication_source,
  std::optional<livekit::TrackSource> track_source
) {
  const auto source = publication_source &&
      *publication_source != livekit::TrackSource::SOURCE_UNKNOWN
    ? publication_source
    : track_source;
  return source == livekit::TrackSource::SOURCE_SCREENSHARE
    ? std::string("screen")
    : std::string("camera");
}

void RemoteVideoBridge::updateIdentity(std::string session_id, std::uint64_t generation) {
  std::lock_guard lock(mutex_);
  session_id_ = std::move(session_id);
  generation_ = generation;
}

void RemoteVideoBridge::addTrack(
  std::shared_ptr<livekit::Track> track,
  std::string participant_identity,
  std::optional<livekit::TrackSource> publication_source,
  std::string track_id
) {
  if (!track || track->kind() != livekit::TrackKind::KIND_VIDEO) return;
  std::lock_guard lifecycle_lock(lifecycle_mutex_);
  if (track_id.empty()) track_id = track->sid();
  if (track_id.empty()) return;
  // A repeated subscribed callback replaces the decoder for the same SID. It
  // is an implementation detail, not a track removal visible to the renderer.
  removeTrackLocked(track_id, {}, false);
  auto worker = std::make_unique<TrackWorker>();
  worker->track = track;
  worker->stream = stream_factory_(track);
  if (!worker->stream) {
    throw std::runtime_error("remote video stream factory returned no reader");
  }
  auto* raw = worker.get();
  const auto source = remoteVideoSourceLabel(publication_source, track->source());
  try {
    raw->thread = std::thread([
      this, raw, track_id, participant_identity = std::move(participant_identity), source
    ] {
    raw->committed.wait();
#ifdef _WIN32
    try {
      RemoteVideoGpuPoolSet gpu_pools;
      auto& uploader = gpu_pools.active;
      auto& retired_uploaders = gpu_pools.retired;
      livekit::VideoFrameEvent frame_event;
      bool healthy_reported = false;
      std::uint64_t frames_read = 0;
      std::uint64_t frames_submitted = 0;
      std::uint64_t frames_published = 0;
      std::uint64_t frames_dropped_gpu_pool = 0;
      std::uint64_t gpu_pool_rollovers = 0;
      std::uint64_t gpu_slot_timeouts = 0;
      std::uint64_t gpu_slots_recovered = 0;
      std::uint64_t gpu_frames_superseded = 0;
      std::uint64_t gpu_rollovers_blocked = 0;
      bool rollover_blocked_reported = false;
      std::uint64_t gpu_wait_total_us = 0;
      std::uint64_t gpu_wait_max_us = 0;
      std::mutex gpu_pipeline_mutex;
      std::condition_variable gpu_pipeline_changed;
      std::exception_ptr gpu_pipeline_failure;
      auto next_pipeline_report =
        std::chrono::steady_clock::now() + std::chrono::seconds(1);
      auto next_rtp_stats_request =
        std::chrono::steady_clock::now() + std::chrono::seconds(1);
      std::optional<std::future<std::vector<livekit::RtcStats>>> rtp_stats_future;

      const auto publish_ready_frames = [&](
          std::unique_lock<std::mutex>& pipeline_lock) {
        if (!uploader) return;
        for (;;) {
          {
            std::lock_guard frames_lock(raw->frames_mutex);
            if (raw->frames.size() >= max_in_flight) return;
          }
          RemoteVideoTextureFrame uploaded;
          if (!uploader->take(uploaded)) return;
          gpu_wait_total_us += uploaded.gpu_completion_us;
          gpu_wait_max_us = std::max(
            gpu_wait_max_us,
            uploaded.gpu_completion_us
          );
          std::uint64_t next = 0;
          {
            std::lock_guard lock(mutex_);
            next = ++next_frame_sequence_;
          }
          {
            std::lock_guard frames_lock(raw->frames_mutex);
            raw->frames.emplace(next, std::move(uploaded.lease));
          }
          MediaCommand command;
          command.type = event_types_.frame;
          {
            std::lock_guard lock(mutex_);
            command.session_id = session_id_;
            command.generation = generation_;
          }
          command.track_id = track_id;
          command.participant_identity = participant_identity;
          command.video_source = source;
          command.frame_sequence = next;
          command.timestamp_us = uploaded.timestamp_us;
          command.width = static_cast<int>(uploaded.width);
          command.height = static_cast<int>(uploaded.height);
          command.nt_handle = uploaded.nt_handle;
          try {
            command.on_drop = [router = release_router_, track_id, next] {
              router->release(track_id, next);
            };
          } catch (...) {
            release(track_id, next);
            throw;
          }
          bool posted = false;
          pipeline_lock.unlock();
          try {
            posted = post_(std::move(command));
          } catch (...) {
            release(track_id, next);
            pipeline_lock.lock();
            throw;
          }
          if (!posted) release(track_id, next);
          pipeline_lock.lock();
          if (!posted) continue;
          ++frames_published;
          if (!healthy_reported) {
            healthy_reported = true;
            if (on_healthy_) {
              pipeline_lock.unlock();
              try {
                on_healthy_(track_id, raw->track);
              } catch (...) {
                pipeline_lock.lock();
                throw;
              }
              pipeline_lock.lock();
            }
          }
        }
      };

      const auto cleanup_retired_uploaders = [&] {
        for (auto iterator = retired_uploaders.begin();
             iterator != retired_uploaders.end();) {
          const auto result = (*iterator)->poll();
          gpu_slot_timeouts += result.slots_quarantined;
          gpu_slots_recovered += result.slots_recovered;
          gpu_frames_superseded +=
            (*iterator)->consumeSupersededReadyFrames();
          if (result.reset_required || (*iterator)->retirementSafe()) {
            iterator = retired_uploaders.erase(iterator);
          } else {
            ++iterator;
          }
        }
        if (retired_uploaders.size() < max_retired_gpu_generations) {
          rollover_blocked_reported = false;
        }
      };

      const auto rollover_uploader = [&, this](
        const char* reason,
        long hresult
      ) {
        if (retired_uploaders.size() >= max_retired_gpu_generations) {
          if (!rollover_blocked_reported) {
            rollover_blocked_reported = true;
            ++gpu_rollovers_blocked;
            diagnostics::DiagnosticLog::instance().write(
              "remote_video_gpu_rollover_blocked",
              {
                {"trackId", track_id},
                {"reason", reason},
                {"hresult", static_cast<std::int64_t>(hresult)},
                {"retiredGenerations",
                  static_cast<std::uint64_t>(retired_uploaders.size())}
              }
            );
          }
          return false;
        }
        retired_uploaders.push_back(std::move(uploader));
        uploader = createRemoteVideoTexturePool(electron_main_pid_);
        ++gpu_pool_rollovers;
        diagnostics::DiagnosticLog::instance().write(
          "remote_video_gpu_pool_rollover",
          {
            {"trackId", track_id},
            {"reason", reason},
            {"hresult", static_cast<std::int64_t>(hresult)},
            {"count", gpu_pool_rollovers},
            {"retiredGenerations",
              static_cast<std::uint64_t>(retired_uploaders.size())}
          }
        );
        return true;
      };

      const auto poll_uploader = [&] {
        if (!uploader) return;
        const auto result = uploader->poll();
        gpu_slot_timeouts += result.slots_quarantined;
        gpu_slots_recovered += result.slots_recovered;
        gpu_frames_superseded += uploader->consumeSupersededReadyFrames();
        if (result.reset_required) {
          static_cast<void>(rollover_uploader(
            "device_failure", result.hresult));
        } else if (result.upload_capacity_exhausted) {
          static_cast<void>(rollover_uploader(
            "all_upload_slots_quarantined", result.hresult));
        }
      };

      // VideoStream::read() blocks until another decoded frame arrives. GPU
      // completion must therefore have its own pump: otherwise the last frame
      // before a static period can finish uploading but remain unpublished
      // indefinitely because no later frame wakes the capture loop.
      std::jthread gpu_pump([&](std::stop_token stop) {
        try {
          std::unique_lock pipeline_lock(gpu_pipeline_mutex);
          while (!stop.stop_requested()) {
            const bool pending = uploader &&
              (!uploader->retirementSafe() || uploader->ready() != 0);
            gpu_pipeline_changed.wait_for(
              pipeline_lock,
              pending ? std::chrono::milliseconds(2)
                      : std::chrono::milliseconds(50)
            );
            if (stop.stop_requested()) break;
            cleanup_retired_uploaders();
            poll_uploader();
            publish_ready_frames(pipeline_lock);
          }
        } catch (...) {
          {
            std::lock_guard lock(gpu_pipeline_mutex);
            gpu_pipeline_failure = std::current_exception();
          }
          // Wake the blocking decoder read so the owning track worker can
          // propagate this local pipeline failure through normal track
          // recovery instead of leaving a half-alive worker behind.
          raw->stream->close();
        }
      });

      while (!raw->stopped.load() && raw->stream->read(frame_event)) {
        ++frames_read;
        if (!claimFirstFrame(raw->first_frame_state)) break;
        {
          std::lock_guard pipeline_lock(gpu_pipeline_mutex);
          if (gpu_pipeline_failure) {
            std::rethrow_exception(gpu_pipeline_failure);
          }
          if (!uploader) {
            uploader = createRemoteVideoTexturePool(electron_main_pid_);
          }
          if (uploader->submit(
            frame_event.frame,
            static_cast<std::uint64_t>(
              std::max<std::int64_t>(0, frame_event.timestamp_us)
            )
          )) {
            ++frames_submitted;
          } else {
            ++frames_dropped_gpu_pool;
          }
        }
        gpu_pipeline_changed.notify_one();
        const auto now = std::chrono::steady_clock::now();
        if (now >= next_pipeline_report) {
          std::lock_guard pipeline_lock(gpu_pipeline_mutex);
          diagnostics::DiagnosticLog::instance().write(
            "remote_video_pipeline_stats",
            {
              {"trackId", track_id},
              {"framesRead", frames_read},
              {"framesSubmitted", frames_submitted},
              {"framesPublished", frames_published},
              {"framesDroppedGpuPool", frames_dropped_gpu_pool},
              {"gpuPoolRollovers", gpu_pool_rollovers},
              {"gpuSlotTimeouts", gpu_slot_timeouts},
              {"gpuSlotsRecovered", gpu_slots_recovered},
              {"gpuFramesSuperseded", gpu_frames_superseded},
              {"gpuRolloversBlocked", gpu_rollovers_blocked},
              {"gpuRetiredGenerations",
                static_cast<std::uint64_t>(retired_uploaders.size())},
              {"gpuWaitTotalUs", gpu_wait_total_us},
              {"gpuWaitMaxUs", gpu_wait_max_us},
              {"gpuPoolSlotsAvailable",
                static_cast<std::uint64_t>(
                  uploader ? uploader->available() : 0)},
              {"gpuPoolSlotsTotal",
                static_cast<std::uint64_t>(
                  uploader ? uploader->capacity() : 0)},
              {"gpuPoolSlotsQuarantined",
                static_cast<std::uint64_t>(
                  uploader ? uploader->quarantined() : 0)},
              {"width", static_cast<std::uint64_t>(frame_event.frame.width())},
              {"height", static_cast<std::uint64_t>(frame_event.frame.height())}
            }
          );
          next_pipeline_report = now + std::chrono::seconds(1);
        }
        if (rtp_stats_future &&
            rtp_stats_future->wait_for(std::chrono::milliseconds(0)) ==
              std::future_status::ready) {
          try {
            const auto records = rtp_stats_future->get();
            std::uint64_t frames_received = 0;
            std::uint64_t frames_decoded = 0;
            std::uint64_t frames_dropped = 0;
            std::uint64_t bytes_received = 0;
            double frames_per_second = 0;
            double total_decode_time = 0;
            std::uint64_t frame_width = 0;
            std::uint64_t frame_height = 0;
            bool power_efficient_decoder = false;
            bool available = false;
            std::string decoder_implementation;
            for (const auto& record : records) {
              const auto* inbound =
                std::get_if<livekit::RtcInboundRtpStats>(&record.stats);
              if (!inbound || inbound->stream.kind != "video") continue;
              available = true;
              frames_received += inbound->inbound.frames_received;
              frames_decoded += inbound->inbound.frames_decoded;
              frames_dropped += inbound->inbound.frames_dropped;
              bytes_received += inbound->inbound.bytes_received;
              frames_per_second += inbound->inbound.frames_per_second;
              total_decode_time += inbound->inbound.total_decode_time;
              frame_width = std::max<std::uint64_t>(
                frame_width, inbound->inbound.frame_width);
              frame_height = std::max<std::uint64_t>(
                frame_height, inbound->inbound.frame_height);
              power_efficient_decoder =
                power_efficient_decoder || inbound->inbound.power_efficient_decoder;
              if (decoder_implementation.empty()) {
                decoder_implementation = inbound->inbound.decoder_implementation;
              }
            }
            diagnostics::DiagnosticLog::instance().write(
              "remote_video_rtp_stats",
              {
                {"trackId", track_id},
                {"available", available},
                {"framesReceived", frames_received},
                {"framesDecoded", frames_decoded},
                {"framesDropped", frames_dropped},
                {"bytesReceived", bytes_received},
                {"framesPerSecond", frames_per_second},
                {"totalDecodeTime", total_decode_time},
                {"decoderImplementation", std::move(decoder_implementation)},
                {"powerEfficientDecoder", power_efficient_decoder},
                {"frameWidth", frame_width},
                {"frameHeight", frame_height}
              }
            );
          } catch (const std::exception& error) {
            diagnostics::DiagnosticLog::instance().write(
              "remote_video_rtp_stats_failed",
              {
                {"trackId", track_id},
                {"message", error.what()}
              }
            );
          }
          rtp_stats_future.reset();
        }
        if (!rtp_stats_future && now >= next_rtp_stats_request) {
          rtp_stats_future.emplace(raw->track->getStats());
          next_rtp_stats_request = now + std::chrono::seconds(1);
        }
      }
      gpu_pump.request_stop();
      gpu_pipeline_changed.notify_all();
      if (gpu_pump.joinable()) gpu_pump.join();
      {
        std::lock_guard pipeline_lock(gpu_pipeline_mutex);
        if (gpu_pipeline_failure && !raw->stopped.load()) {
          std::rethrow_exception(gpu_pipeline_failure);
        }
      }
      if (!raw->stopped.load()) {
        const std::string message = event_types_.stream_label +
          (raw->first_frame_state.load() == FirstFrameState::TimedOut
            ? " stream did not produce its first frame"
            : " stream ended unexpectedly");
        MediaCommand command;
        command.type = event_types_.failed;
        {
          std::lock_guard lock(mutex_);
          command.session_id = session_id_;
          command.generation = generation_;
        }
        command.track_id = track_id;
        command.video_source = source;
        command.internal_message = message;
        logRemoteVideoFailure(track_id, source, message);
        post_(std::move(command));
        if (on_ended_) on_ended_(track_id, raw->track, message);
      }
    } catch (const std::exception& error) {
      if (raw->stopped.load()) return;
      MediaCommand command;
      command.type = event_types_.failed;
      {
        std::lock_guard lock(mutex_);
        command.session_id = session_id_;
        command.generation = generation_;
      }
      command.track_id = track_id;
      command.video_source = source;
      command.internal_message = error.what();
      logRemoteVideoFailure(track_id, source, error.what());
      post_(std::move(command));
      if (on_ended_) on_ended_(track_id, raw->track, error.what());
    } catch (...) {
      if (raw->stopped.load()) return;
      MediaCommand command;
      command.type = event_types_.failed;
      {
        std::lock_guard lock(mutex_);
        command.session_id = session_id_;
        command.generation = generation_;
      }
      command.track_id = track_id;
      command.video_source = source;
      command.internal_message = "Unknown remote video bridge failure";
      logRemoteVideoFailure(track_id, source, command.internal_message);
      const auto message = command.internal_message;
      post_(std::move(command));
      if (on_ended_) on_ended_(track_id, raw->track, message);
    }
#endif
    });
    raw->first_frame_watchdog = std::thread([raw] {
    raw->committed.wait();
    if (raw->stopped.load()) return;
    const auto deadline = std::chrono::steady_clock::now() +
      kRemoteVideoFirstFrameTimeout;
    while (!raw->stopped.load() &&
           raw->first_frame_state.load() == FirstFrameState::Pending) {
      if (std::chrono::steady_clock::now() >= deadline) {
        if (claimFirstFrameTimeout(raw->first_frame_state)) raw->stream->close();
        return;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    });
  } catch (...) {
    raw->stopped.store(true);
    raw->committed.count_down();
    raw->stream->close();
    if (raw->thread.joinable()) raw->thread.join();
    if (raw->first_frame_watchdog.joinable()) raw->first_frame_watchdog.join();
    throw;
  }
  try {
    std::lock_guard lock(mutex_);
    const auto [_, inserted] = tracks_.try_emplace(track_id, std::move(worker));
    if (!inserted) throw std::runtime_error("duplicate remote video track SID");
    raw->committed.count_down();
  } catch (...) {
    raw->stopped.store(true);
    raw->committed.count_down();
    raw->stream->close();
    if (worker) {
      if (worker->thread.joinable()) worker->thread.join();
      if (worker->first_frame_watchdog.joinable()) {
        worker->first_frame_watchdog.join();
      }
    }
    throw;
  }
}

void RemoteVideoBridge::removeTrack(const std::string& track_id, bool notify) {
  std::lock_guard lifecycle_lock(lifecycle_mutex_);
  removeTrackLocked(track_id, {}, notify);
}

void RemoteVideoBridge::removeTrackIfCurrent(
  const std::string& track_id,
  const std::shared_ptr<livekit::Track>& expected_track,
  bool notify
) {
  if (!expected_track) return;
  std::lock_guard lifecycle_lock(lifecycle_mutex_);
  removeTrackLocked(track_id, expected_track, notify);
}

void RemoteVideoBridge::removeTrackLocked(
  const std::string& track_id,
  const std::shared_ptr<livekit::Track>& expected_track,
  bool notify
) {
  std::unique_ptr<TrackWorker> worker;
  {
    std::lock_guard lock(mutex_);
    auto found = tracks_.find(track_id);
    if (found == tracks_.end()) return;
    if (expected_track && found->second->track != expected_track) return;
    worker = std::move(found->second);
    tracks_.erase(found);
  }
  worker->stopped = true;
  worker->stream->close();
  if (worker->thread.joinable()) worker->thread.join();
  if (worker->first_frame_watchdog.joinable()) {
    worker->first_frame_watchdog.join();
  }
#ifdef _WIN32
  {
    std::lock_guard lock(mutex_);
    std::lock_guard frames_lock(worker->frames_mutex);
    for (auto& [sequence, frame] : worker->frames) {
      if (!released_frame_sequences_.consume(track_id, sequence)) {
        retired_frames_.emplace(
          sequence,
          RetiredFrame{track_id, std::move(frame)}
        );
      }
    }
    worker->frames.clear();
  }
#endif
  if (!notify) return;
  MediaCommand command;
  command.type = event_types_.track_removed;
  command.track_id = track_id;
  {
    std::lock_guard lock(mutex_);
    command.session_id = session_id_;
    command.generation = generation_;
  }
  post_(std::move(command));
}

void RemoteVideoBridge::release(const std::string& track_id, std::uint64_t sequence) {
  std::lock_guard lock(mutex_);
  const auto found = tracks_.find(track_id);
#ifdef _WIN32
  bool released = false;
  if (found != tracks_.end()) {
    std::lock_guard frames_lock(found->second->frames_mutex);
    released = found->second->frames.erase(sequence) != 0;
  }
  if (const auto retired = retired_frames_.find(sequence);
      retired != retired_frames_.end() && retired->second.track_id == track_id) {
    retired_frames_.erase(retired);
    released = true;
  }
  // A release can race the short interval between removing a worker from the
  // active map and migrating its in-flight textures. Remember it so migration
  // never resurrects an already released handle.
  if (!released) {
    static_cast<void>(released_frame_sequences_.remember(
      track_id,
      sequence,
      next_frame_sequence_
    ));
  }
#endif
}

void RemoteVideoBridge::stop() {
  std::vector<std::string> ids;
  {
    std::lock_guard lock(mutex_);
    ids.reserve(tracks_.size());
    for (const auto& [id, _] : tracks_) ids.push_back(id);
  }
  for (const auto& id : ids) removeTrack(id);
}

void RemoteVideoBridge::stop(std::shared_ptr<void> lifetime_owner) {
  if (cleanup_submitted_.exchange(true)) return;
  cleanup_node_->prepare(
    std::move(lifetime_owner),
    this,
    [](void* context) {
      static_cast<RemoteVideoBridge*>(context)->stop();
    }
  );
  cleanup_dispatcher_->submit(cleanup_node_);
}

}  // namespace syrnike::desktop_native::media
