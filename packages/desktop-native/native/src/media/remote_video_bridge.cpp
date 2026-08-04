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

  void retire(std::unique_ptr<RemoteVideoTexturePool> pool) noexcept {
    try {
      if (!pool || pool->retirementSafe()) return;
      bool queued = false;
      {
        std::lock_guard lock(mutex_);
        if (pools_.size() < max_process_gpu_retirements) {
          pools_.push_back(std::move(pool));
          queued = true;
        }
      }
      if (queued) changed_.notify_one();
      // At the hard process limit the caller is already a terminating track
      // worker. Destroying its wrapper here is bounded and D3D-safe; any frame
      // held by Electron keeps the shared pool State alive through its lease.
    } catch (...) {
      // Teardown remains noexcept. The local unique_ptr performs the same
      // bounded cleanup if queue synchronization or allocation fails.
    }
  }

  bool tryRetire(
    std::unique_ptr<RemoteVideoTexturePool>& pool
  ) noexcept {
    try {
      if (!pool || pool->retirementSafe()) {
        pool.reset();
        return true;
      }
      {
        std::lock_guard lock(mutex_);
        if (pools_.size() >= max_process_gpu_retirements) return false;
        pools_.push_back(std::move(pool));
      }
      changed_.notify_one();
      return true;
    } catch (...) {
      return false;
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
          try {
            const auto result = (*iterator)->poll();
            if (!result.reset_required &&
                !(*iterator)->retirementSafe()) {
              ++iterator;
              continue;
            }
          } catch (...) {
            // Dispose a broken retired generation on this background thread.
            // One malformed device must not stop retirement for every track.
          }
          iterator = pools_.erase(iterator);
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

struct RemoteVideoBridge::TrackRetirementState {
  std::mutex mutex;
  std::condition_variable changed;
  std::size_t pending = 0;
};

struct RemoteVideoBridge::TrackWorker {
  RemoteVideoBridge* bridge = nullptr;
  std::string track_id;
  std::shared_ptr<livekit::Track> track;
  std::shared_ptr<StreamReader> stream;
  std::shared_ptr<AsyncCleanupNode> cleanup_node;
  std::shared_ptr<TrackRetirementState> retirement_state;
  std::thread thread;
  std::thread first_frame_watchdog;
  std::atomic_bool stopped{false};
  std::atomic_bool retirement_submitted{false};
  std::atomic_bool commit_latch_opened{false};
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
    cleanup_launcher_(std::move(cleanup_launcher)),
    cleanup_node_(std::make_shared<AsyncCleanupNode>(
      cleanup_launcher_
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
    )),
    retirement_state_(std::make_shared<TrackRetirementState>()) {}

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
  auto worker = std::make_shared<TrackWorker>();
  worker->bridge = this;
  worker->track_id = track_id;
  worker->track = track;
  worker->cleanup_node = std::make_shared<AsyncCleanupNode>(
    cleanup_launcher_
  );
  worker->retirement_state = retirement_state_;
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
      retired_uploaders.reserve(max_retired_gpu_generations);
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
      bool pool_create_failure_reported = false;
      std::uint64_t gpu_wait_total_us = 0;
      std::uint64_t gpu_wait_max_us = 0;
      enum class PendingGpuRollover {
        None,
        DeviceFailure,
        CapacityExhausted,
      };
      PendingGpuRollover pending_gpu_rollover = PendingGpuRollover::None;
      long pending_gpu_rollover_hresult = 0;
      auto next_gpu_rollover_at = std::chrono::steady_clock::time_point{};
      auto next_gpu_pool_create_at = std::chrono::steady_clock::time_point{};
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
          try {
            const auto result = (*iterator)->poll();
            gpu_slot_timeouts += result.slots_quarantined;
            gpu_slots_recovered += result.slots_recovered;
            gpu_frames_superseded +=
              (*iterator)->consumeSupersededReadyFrames();
            if (!result.reset_required &&
                !(*iterator)->retirementSafe()) {
              ++iterator;
              continue;
            }
          } catch (const RemoteVideoTexturePoolError&) {
            // This generation is already detached from frame submission.
            // Destroy it locally and keep the active viewer stream alive.
          }
          iterator = retired_uploaders.erase(iterator);
        }
      };

      const auto rollover_uploader = [&, this](
        const char* reason,
        long hresult
      ) {
        const auto now = std::chrono::steady_clock::now();
        if (now < next_gpu_rollover_at) return false;
        // Create the replacement transactionally. If the oldest local
        // generation cannot enter the bounded process reaper, keep the current
        // generation alive and drop fresh decoded frames until a later poll;
        // a retirement-capacity race must never terminate the track worker.
        std::unique_ptr<RemoteVideoTexturePool> replacement;
        try {
          replacement =
            std::make_unique<RemoteVideoTexturePool>(electron_main_pid_);
        } catch (const RemoteVideoTexturePoolError& error) {
          next_gpu_rollover_at = now + std::chrono::milliseconds(250);
          if (!rollover_blocked_reported) {
            rollover_blocked_reported = true;
            ++gpu_rollovers_blocked;
            diagnostics::DiagnosticLog::instance().write(
              "remote_video_gpu_rollover_blocked",
              {
                {"trackId", track_id},
                {"reason", "replacement_creation"},
                {"hresult", static_cast<std::int64_t>(error.hresult())},
                {"message", std::string(error.what())}
              }
            );
          }
          return false;
        }
        if (retired_uploaders.size() >= max_retired_gpu_generations) {
          // Each viewer generation owns an independent D3D device. Hand the
          // oldest stalled generation to the process reaper before rotating
          // again, so this track remains bounded without freezing forever
          // behind a query that may never complete.
          auto oldest = std::move(retired_uploaders.front());
          if (!RemoteVideoGpuRetirementQueue::instance().tryRetire(oldest)) {
            next_gpu_rollover_at = now + std::chrono::milliseconds(250);
            retired_uploaders.front() = std::move(oldest);
            if (!rollover_blocked_reported) {
              rollover_blocked_reported = true;
              ++gpu_rollovers_blocked;
              diagnostics::DiagnosticLog::instance().write(
                "remote_video_gpu_rollover_blocked",
                {
                  {"trackId", track_id},
                  {"reason", "process_retirement_race"},
                  {"hresult", static_cast<std::int64_t>(hresult)},
                  {"retiredGenerations",
                    static_cast<std::uint64_t>(retired_uploaders.size())}
                }
              );
            }
            return false;
          }
          retired_uploaders.erase(retired_uploaders.begin());
        }
        retired_uploaders.push_back(std::move(uploader));
        uploader = std::move(replacement);
        ++gpu_pool_rollovers;
        rollover_blocked_reported = false;
        next_gpu_rollover_at = {};
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
        if (pending_gpu_rollover == PendingGpuRollover::DeviceFailure) {
          if (rollover_uploader(
                "device_failure", pending_gpu_rollover_hresult)) {
            pending_gpu_rollover = PendingGpuRollover::None;
            pending_gpu_rollover_hresult = 0;
          }
          return;
        }
        const auto result = uploader->poll();
        gpu_slot_timeouts += result.slots_quarantined;
        gpu_slots_recovered += result.slots_recovered;
        gpu_frames_superseded += uploader->consumeSupersededReadyFrames();
        if (result.reset_required) {
          pending_gpu_rollover = PendingGpuRollover::DeviceFailure;
          pending_gpu_rollover_hresult = result.hresult;
          if (rollover_uploader("device_failure", result.hresult)) {
            pending_gpu_rollover = PendingGpuRollover::None;
            pending_gpu_rollover_hresult = 0;
          }
        } else if (result.upload_capacity_exhausted) {
          pending_gpu_rollover = PendingGpuRollover::CapacityExhausted;
          pending_gpu_rollover_hresult = result.hresult;
          if (rollover_uploader(
                "all_upload_slots_quarantined", result.hresult)) {
            pending_gpu_rollover = PendingGpuRollover::None;
            pending_gpu_rollover_hresult = 0;
          }
        } else if (
          pending_gpu_rollover == PendingGpuRollover::CapacityExhausted) {
          // Every quarantined query completed late before a replacement was
          // available. Resume this generation instead of allocating one.
          pending_gpu_rollover = PendingGpuRollover::None;
          pending_gpu_rollover_hresult = 0;
          rollover_blocked_reported = false;
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
            try {
              publish_ready_frames(pipeline_lock);
            } catch (const RemoteVideoTexturePoolError& error) {
              pending_gpu_rollover = PendingGpuRollover::DeviceFailure;
              pending_gpu_rollover_hresult = error.hresult();
              if (rollover_uploader("frame_export_failure", error.hresult())) {
                pending_gpu_rollover = PendingGpuRollover::None;
                pending_gpu_rollover_hresult = 0;
              }
            }
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
            const auto create_now = std::chrono::steady_clock::now();
            if (create_now < next_gpu_pool_create_at) {
              ++frames_dropped_gpu_pool;
              continue;
            }
            try {
              uploader =
                std::make_unique<RemoteVideoTexturePool>(electron_main_pid_);
            } catch (const RemoteVideoTexturePoolError& error) {
              next_gpu_pool_create_at =
                create_now + std::chrono::milliseconds(250);
              ++frames_dropped_gpu_pool;
              if (!pool_create_failure_reported) {
                pool_create_failure_reported = true;
                diagnostics::DiagnosticLog::instance().write(
                  "remote_video_gpu_pool_create_failed",
                  {
                    {"trackId", track_id},
                    {"hresult", static_cast<std::int64_t>(error.hresult())},
                    {"message", std::string(error.what())}
                  }
                );
              }
              continue;
            }
            pool_create_failure_reported = false;
            next_gpu_pool_create_at = {};
          }
          if (pending_gpu_rollover != PendingGpuRollover::None) {
            ++frames_dropped_gpu_pool;
          } else {
            try {
              if (uploader->submit(
                    frame_event.frame,
                    static_cast<std::uint64_t>(
                      std::max<std::int64_t>(0, frame_event.timestamp_us)))) {
                ++frames_submitted;
              } else {
                ++frames_dropped_gpu_pool;
              }
            } catch (const RemoteVideoTexturePoolError& error) {
              pending_gpu_rollover = PendingGpuRollover::DeviceFailure;
              pending_gpu_rollover_hresult = error.hresult();
              ++frames_dropped_gpu_pool;
            }
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
          } catch (...) {
            diagnostics::DiagnosticLog::instance().write(
              "remote_video_rtp_stats_failed",
              {
                {"trackId", track_id},
                {"message", "unknown statistics result failure"}
              }
            );
          }
          rtp_stats_future.reset();
        }
        if (!rtp_stats_future && now >= next_rtp_stats_request) {
          next_rtp_stats_request = now + std::chrono::seconds(1);
          try {
            rtp_stats_future.emplace(raw->track->getStats());
          } catch (const std::exception& error) {
            diagnostics::DiagnosticLog::instance().write(
              "remote_video_rtp_stats_failed",
              {
                {"trackId", track_id},
                {"message", error.what()}
              }
            );
          } catch (...) {
            diagnostics::DiagnosticLog::instance().write(
              "remote_video_rtp_stats_failed",
              {
                {"trackId", track_id},
                {"message", "unknown statistics request failure"}
              }
            );
          }
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
        command.recovery_mode = "local";
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
      command.recovery_mode = "local";
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
      command.recovery_mode = "local";
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
    submitTrackRetirement(worker);
    throw;
  }
  try {
    std::lock_guard lock(mutex_);
    const auto [_, inserted] = tracks_.try_emplace(track_id, worker);
    if (!inserted) throw std::runtime_error("duplicate remote video track SID");
    if (!raw->commit_latch_opened.exchange(true)) {
      raw->committed.count_down();
    }
  } catch (...) {
    submitTrackRetirement(worker);
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
  std::shared_ptr<TrackWorker> worker;
  {
    std::lock_guard lock(mutex_);
    auto found = tracks_.find(track_id);
    if (found == tracks_.end()) return;
    if (expected_track && found->second->track != expected_track) return;
    worker = std::move(found->second);
    tracks_.erase(found);
  }
  submitTrackRetirement(worker);
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

void RemoteVideoBridge::submitTrackRetirement(
  const std::shared_ptr<TrackWorker>& worker
) noexcept {
  if (!worker || worker->retirement_submitted.exchange(true)) return;
  worker->stopped.store(true);
  if (!worker->commit_latch_opened.exchange(true)) {
    worker->committed.count_down();
  }
  try {
    worker->stream->close();
  } catch (...) {
  }
  {
    std::lock_guard lock(worker->retirement_state->mutex);
    ++worker->retirement_state->pending;
  }
  worker->cleanup_node->prepare(
    worker,
    worker.get(),
    [](void* context) {
      auto* retiring = static_cast<TrackWorker*>(context);
      retiring->bridge->finishTrackRetirement(*retiring);
    },
    [](void* context) {
      auto* retiring = static_cast<TrackWorker*>(context);
      completeTrackRetirement(*retiring);
    }
  );
  cleanup_dispatcher_->submit(worker->cleanup_node);
}

void RemoteVideoBridge::finishTrackRetirement(TrackWorker& worker) noexcept {
  if (worker.thread.joinable()) worker.thread.join();
  if (worker.first_frame_watchdog.joinable()) {
    worker.first_frame_watchdog.join();
  }
#ifdef _WIN32
  {
    std::lock_guard lock(mutex_);
    std::lock_guard frames_lock(worker.frames_mutex);
    const auto retired_at = std::chrono::steady_clock::now();
    for (auto& [sequence, frame] : worker.frames) {
      if (!released_frame_sequences_.consume(worker.track_id, sequence)) {
        makeRetiredFrameRoomLocked(retired_at);
        retired_frames_.emplace(
          sequence,
          RetiredFrame{worker.track_id, std::move(frame), retired_at}
        );
      }
    }
    worker.frames.clear();
  }
#endif
}

void RemoteVideoBridge::completeTrackRetirement(TrackWorker& worker) noexcept {
  const auto state = worker.retirement_state;
  {
    std::lock_guard lock(state->mutex);
    if (state->pending != 0) --state->pending;
  }
  state->changed.notify_all();
}

void RemoteVideoBridge::waitForTrackRetirements() {
  const auto state = retirement_state_;
  std::unique_lock lock(state->mutex);
  state->changed.wait(lock, [&] {
    return state->pending == 0;
  });
}

void RemoteVideoBridge::release(const std::string& track_id, std::uint64_t sequence) {
  std::lock_guard lock(mutex_);
  const auto found = tracks_.find(track_id);
#ifdef _WIN32
  makeRetiredFrameRoomLocked(std::chrono::steady_clock::now());
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
  // A release can race asynchronous worker retirement after the worker leaves
  // the active map. Remember it so migration never resurrects an already
  // released handle.
  if (!released) {
    static_cast<void>(released_frame_sequences_.remember(
      track_id,
      sequence,
      next_frame_sequence_
    ));
  }
#endif
}

#ifdef _WIN32
void RemoteVideoBridge::makeRetiredFrameRoomLocked(
  std::chrono::steady_clock::time_point now
) {
  for (auto iterator = retired_frames_.begin();
       iterator != retired_frames_.end();) {
    if (now - iterator->second.retired_at >= retired_renderer_frame_ttl_) {
      iterator = retired_frames_.erase(iterator);
    } else {
      ++iterator;
    }
  }
  while (retired_frames_.size() >= max_retired_renderer_frames_) {
    const auto oldest = std::min_element(
      retired_frames_.begin(),
      retired_frames_.end(),
      [](const auto& left, const auto& right) {
        return left.second.retired_at < right.second.retired_at;
      }
    );
    if (oldest == retired_frames_.end()) break;
    diagnostics::DiagnosticLog::instance().write(
      "remote_video_retired_frame_evicted",
      {
        {"trackId", oldest->second.track_id},
        {"retiredFrames", static_cast<std::uint64_t>(retired_frames_.size())},
        {"limit", static_cast<std::uint64_t>(max_retired_renderer_frames_)}
      }
    );
    retired_frames_.erase(oldest);
  }
}
#endif

void RemoteVideoBridge::stop() {
  std::lock_guard lifecycle_lock(lifecycle_mutex_);
  std::vector<std::string> ids;
  {
    std::lock_guard lock(mutex_);
    ids.reserve(tracks_.size());
    for (const auto& [id, _] : tracks_) ids.push_back(id);
  }
  for (const auto& id : ids) removeTrackLocked(id, {}, true);
  waitForTrackRetirements();
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
