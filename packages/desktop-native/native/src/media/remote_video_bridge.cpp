#include "remote_video_bridge.hpp"

#ifdef _WIN32
#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>
#endif

#include <livekit/video_stream.h>

#include <algorithm>
#include <chrono>
#include <iomanip>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <utility>

#include "../common/diagnostic_log.hpp"
#include "d3d11_gpu_completion.hpp"

namespace syrnike::desktop_native::media {
namespace {
constexpr std::size_t max_in_flight = 3;
constexpr auto gpu_completion_timeout = std::chrono::milliseconds(500);

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

#ifdef _WIN32
using Microsoft::WRL::ComPtr;

[[noreturn]] void throwHResult(const char* operation, HRESULT result) {
  std::ostringstream message;
  message << operation << " (HRESULT 0x"
          << std::hex << std::uppercase << static_cast<std::uint32_t>(result) << ")";
  throw std::runtime_error(message.str());
}

[[noreturn]] void throwWin32Error(const char* operation, DWORD error) {
  std::ostringstream message;
  message << operation << " (Win32 " << error << ")";
  throw std::runtime_error(message.str());
}

struct SharedFrame {
  ComPtr<ID3D11Texture2D> texture;
  HANDLE remote_handle = nullptr;
  std::uint32_t remote_pid = 0;

  ~SharedFrame() {
    if (!remote_handle || remote_pid == 0) return;
    const HANDLE process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, remote_pid);
    if (!process) return;
    HANDLE local = nullptr;
    if (DuplicateHandle(
      process, remote_handle, GetCurrentProcess(), &local, 0, FALSE,
      DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS
    )) {
      CloseHandle(local);
    }
    CloseHandle(process);
  }
};

class D3DSharedTextureUploader {
 public:
  D3DSharedTextureUploader() {
    D3D_FEATURE_LEVEL level{};
    const auto result = D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr, 0, D3D11_SDK_VERSION, &device_, &level, &context_
    );
    if (FAILED(result)) throwHResult("D3D11 device creation failed", result);
    completion_ = std::make_unique<D3d11GpuCompletion>(device_.Get(), context_.Get());
    if (FAILED(completion_->initializationResult())) {
      throwHResult(
        "D3D11 upload completion query creation failed",
        completion_->initializationResult()
      );
    }
  }

  std::pair<std::uint64_t, std::shared_ptr<SharedFrame>> upload(
    const livekit::VideoFrame& frame,
    std::uint32_t main_pid
  ) {
    D3D11_TEXTURE2D_DESC description{};
    description.Width = static_cast<UINT>(frame.width());
    description.Height = static_cast<UINT>(frame.height());
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    // Electron imports an NT handle for a shared BGRA texture. NTHANDLE alone
    // is not a complete shared-resource contract and CreateTexture2D rejects it.
    description.MiscFlags =
      D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
      D3D11_RESOURCE_MISC_SHARED;
    ComPtr<ID3D11Texture2D> texture;
    const auto texture_result = device_->CreateTexture2D(&description, nullptr, &texture);
    if (FAILED(texture_result)) {
      throwHResult("D3D11 shared texture creation failed", texture_result);
    }
    context_->UpdateSubresource(
      texture.Get(), 0, nullptr, frame.data(),
      static_cast<UINT>(frame.width() * 4), 0
    );
    // Electron's BGRA import does not accept a keyed mutex or producer fence.
    // Wait for the upload itself, not merely command submission, before the
    // handle becomes visible to another D3D device.
    const auto completion_result = completion_->wait(gpu_completion_timeout);
    if (FAILED(completion_result)) {
      throwHResult("D3D11 shared texture upload did not complete", completion_result);
    }
    ComPtr<IDXGIResource1> resource;
    const auto query_result = texture.As(&resource);
    if (FAILED(query_result)) throwHResult("DXGI resource query failed", query_result);
    HANDLE local_handle = nullptr;
    const auto handle_result = resource->CreateSharedHandle(
      nullptr, DXGI_SHARED_RESOURCE_READ, nullptr, &local_handle
    );
    if (FAILED(handle_result)) {
      throwHResult("DXGI shared handle creation failed", handle_result);
    }
    HANDLE main_process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, main_pid);
    if (!main_process) {
      const auto open_process_error = GetLastError();
      CloseHandle(local_handle);
      throwWin32Error(
        "Electron main process handle open failed",
        open_process_error
      );
    }
    HANDLE duplicated = nullptr;
    const BOOL duplicated_ok = DuplicateHandle(
      GetCurrentProcess(), local_handle, main_process, &duplicated,
      0, FALSE, DUPLICATE_SAME_ACCESS
    );
    const auto duplicate_error = duplicated_ok ? ERROR_SUCCESS : GetLastError();
    CloseHandle(main_process);
    CloseHandle(local_handle);
    if (!duplicated_ok) {
      throwWin32Error("DXGI handle duplication failed", duplicate_error);
    }
    auto retained = std::make_shared<SharedFrame>();
    retained->texture = std::move(texture);
    retained->remote_handle = duplicated;
    retained->remote_pid = main_pid;
    return {reinterpret_cast<std::uint64_t>(duplicated), std::move(retained)};
  }

 private:
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  std::unique_ptr<D3d11GpuCompletion> completion_;
};
#endif
}  // namespace

struct RemoteVideoBridge::TrackWorker {
  std::shared_ptr<livekit::Track> track;
  std::shared_ptr<livekit::VideoStream> stream;
  std::thread thread;
  std::thread first_frame_watchdog;
  std::atomic_bool stopped{false};
  std::atomic_bool committed{false};
  std::atomic<FirstFrameState> first_frame_state{FirstFrameState::Pending};
  std::mutex frames_mutex;
#ifdef _WIN32
  std::unordered_map<std::uint64_t, std::shared_ptr<SharedFrame>> frames;
#endif
};

RemoteVideoBridge::RemoteVideoBridge(
  std::uint32_t electron_main_pid,
  Post post,
  OnEnded on_ended,
  OnHealthy on_healthy,
  VideoBridgeEventTypes event_types
) : electron_main_pid_(electron_main_pid),
    post_(std::move(post)),
    on_ended_(std::move(on_ended)),
    on_healthy_(std::move(on_healthy)),
    event_types_(std::move(event_types)),
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
  livekit::VideoStream::Options options;
  options.capacity = 1;
  options.format = livekit::VideoBufferType::BGRA;
  auto worker = std::make_unique<TrackWorker>();
  worker->track = track;
  worker->stream = livekit::VideoStream::fromTrack(track, options);
  auto* raw = worker.get();
  const auto source = remoteVideoSourceLabel(publication_source, track->source());
  try {
    raw->thread = std::thread([
      this, raw, track_id, participant_identity = std::move(participant_identity), source
    ] {
    while (!raw->committed.load(std::memory_order_acquire)) {
      std::this_thread::yield();
    }
#ifdef _WIN32
    try {
      D3DSharedTextureUploader uploader;
      livekit::VideoFrameEvent frame_event;
      bool healthy_reported = false;
      while (!raw->stopped.load() && raw->stream->read(frame_event)) {
        if (!claimFirstFrame(raw->first_frame_state)) break;
        std::uint64_t next = 0;
        {
          std::lock_guard lock(mutex_);
          next = ++next_frame_sequence_;
        }
        {
          std::lock_guard frames_lock(raw->frames_mutex);
          if (raw->frames.size() >= max_in_flight) continue;
        }
        auto [handle, retained] = uploader.upload(frame_event.frame, electron_main_pid_);
        {
          std::lock_guard frames_lock(raw->frames_mutex);
          raw->frames.emplace(next, std::move(retained));
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
        command.timestamp_us = static_cast<std::uint64_t>(std::max<std::int64_t>(0, frame_event.timestamp_us));
        command.width = frame_event.frame.width();
        command.height = frame_event.frame.height();
        command.nt_handle = handle;
        try {
          command.on_drop = [router = release_router_, track_id, next] {
            router->release(track_id, next);
          };
        } catch (...) {
          release(track_id, next);
          throw;
        }
        if (!post_(std::move(command))) {
          release(track_id, next);
        } else if (!healthy_reported) {
          healthy_reported = true;
          if (on_healthy_) on_healthy_(track_id, raw->track);
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
    while (!raw->committed.load(std::memory_order_acquire)) {
      std::this_thread::yield();
    }
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
    raw->committed.store(true, std::memory_order_release);
    raw->stream->close();
    if (raw->thread.joinable()) raw->thread.join();
    if (raw->first_frame_watchdog.joinable()) raw->first_frame_watchdog.join();
    throw;
  }
  try {
    std::lock_guard lock(mutex_);
    const auto [_, inserted] = tracks_.try_emplace(track_id, std::move(worker));
    if (!inserted) throw std::runtime_error("duplicate remote video track SID");
    raw->committed.store(true, std::memory_order_release);
  } catch (...) {
    raw->stopped.store(true);
    raw->committed.store(true, std::memory_order_release);
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
      if (released_frame_sequences_.erase(sequence) == 0) {
        retired_frames_.emplace(sequence, std::move(frame));
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
  released = retired_frames_.erase(sequence) != 0 || released;
  // A release can race the short interval between removing a worker from the
  // active map and migrating its in-flight textures. Remember it so migration
  // never resurrects an already released handle.
  if (!released) released_frame_sequences_.insert(sequence);
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

}  // namespace syrnike::desktop_native::media
