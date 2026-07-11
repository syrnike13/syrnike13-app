#include "remote_video_bridge.hpp"

#ifdef _WIN32
#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>
#endif

#include <livekit/video_stream.h>

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace syrnike::desktop_native::media {
namespace {
constexpr std::size_t max_in_flight = 3;

#ifdef _WIN32
using Microsoft::WRL::ComPtr;

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
    if (FAILED(result)) throw std::runtime_error("D3D11 device creation failed");
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
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    description.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    ComPtr<ID3D11Texture2D> texture;
    if (FAILED(device_->CreateTexture2D(&description, nullptr, &texture))) {
      throw std::runtime_error("D3D11 shared texture creation failed");
    }
    context_->UpdateSubresource(
      texture.Get(), 0, nullptr, frame.data(),
      static_cast<UINT>(frame.width() * 4), 0
    );
    ComPtr<IDXGIResource1> resource;
    if (FAILED(texture.As(&resource))) throw std::runtime_error("DXGI resource query failed");
    HANDLE local_handle = nullptr;
    if (FAILED(resource->CreateSharedHandle(
      nullptr, DXGI_SHARED_RESOURCE_READ, nullptr, &local_handle
    ))) throw std::runtime_error("DXGI shared handle creation failed");
    HANDLE main_process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, main_pid);
    if (!main_process) {
      CloseHandle(local_handle);
      throw std::runtime_error("Electron main process handle open failed");
    }
    HANDLE duplicated = nullptr;
    const BOOL duplicated_ok = DuplicateHandle(
      GetCurrentProcess(), local_handle, main_process, &duplicated,
      0, FALSE, DUPLICATE_SAME_ACCESS
    );
    CloseHandle(main_process);
    CloseHandle(local_handle);
    if (!duplicated_ok) throw std::runtime_error("DXGI handle duplication failed");
    auto retained = std::make_shared<SharedFrame>();
    retained->texture = std::move(texture);
    retained->remote_handle = duplicated;
    retained->remote_pid = main_pid;
    return {reinterpret_cast<std::uint64_t>(duplicated), std::move(retained)};
  }

 private:
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
};
#endif
}  // namespace

struct RemoteVideoBridge::TrackWorker {
  std::shared_ptr<livekit::VideoStream> stream;
  std::thread thread;
  std::atomic_bool stopped{false};
  std::mutex frames_mutex;
#ifdef _WIN32
  std::unordered_map<std::uint64_t, std::shared_ptr<SharedFrame>> frames;
#endif
};

RemoteVideoBridge::RemoteVideoBridge(std::uint32_t electron_main_pid, Post post)
  : electron_main_pid_(electron_main_pid), post_(std::move(post)) {}

RemoteVideoBridge::~RemoteVideoBridge() { stop(); }

void RemoteVideoBridge::updateIdentity(std::string session_id, std::uint64_t generation) {
  std::lock_guard lock(mutex_);
  session_id_ = std::move(session_id);
  generation_ = generation;
}

void RemoteVideoBridge::addTrack(
  std::shared_ptr<livekit::Track> track,
  std::string participant_identity
) {
  if (!track || track->kind() != livekit::TrackKind::KIND_VIDEO) return;
  const auto track_id = track->sid();
  removeTrack(track_id);
  livekit::VideoStream::Options options;
  options.capacity = 1;
  options.format = livekit::VideoBufferType::BGRA;
  auto worker = std::make_unique<TrackWorker>();
  worker->stream = livekit::VideoStream::fromTrack(track, options);
  auto* raw = worker.get();
  const auto source = track->source() == livekit::TrackSource::SOURCE_SCREENSHARE
    ? std::string("screen") : std::string("camera");
  raw->thread = std::thread([
    this, raw, track_id, participant_identity = std::move(participant_identity), source
  ] {
#ifdef _WIN32
    try {
      D3DSharedTextureUploader uploader;
      std::uint64_t sequence = 0;
      livekit::VideoFrameEvent frame_event;
      while (!raw->stopped.load() && raw->stream->read(frame_event)) {
        const auto next = ++sequence;
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
        command.type = "__remoteVideoFrame";
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
        if (!post_(std::move(command))) release(track_id, next);
      }
    } catch (...) {
      MediaCommand command;
      command.type = "__remoteVideoFailed";
      {
        std::lock_guard lock(mutex_);
        command.session_id = session_id_;
        command.generation = generation_;
      }
      command.track_id = track_id;
      command.video_source = source;
      post_(std::move(command));
    }
#endif
  });
  std::lock_guard lock(mutex_);
  tracks_.emplace(track_id, std::move(worker));
}

void RemoteVideoBridge::removeTrack(const std::string& track_id) {
  std::unique_ptr<TrackWorker> worker;
  {
    std::lock_guard lock(mutex_);
    auto found = tracks_.find(track_id);
    if (found == tracks_.end()) return;
    worker = std::move(found->second);
    tracks_.erase(found);
  }
  worker->stopped = true;
  worker->stream->close();
  if (worker->thread.joinable()) worker->thread.join();
  MediaCommand command;
  command.type = "__remoteVideoTrackRemoved";
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
  if (found == tracks_.end()) return;
#ifdef _WIN32
  std::lock_guard frames_lock(found->second->frames_mutex);
  found->second->frames.erase(sequence);
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
