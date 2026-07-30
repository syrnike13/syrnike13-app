#include "remote_video_texture_pool.hpp"

#ifdef _WIN32

#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>

#include "d3d11_gpu_completion.hpp"

namespace syrnike::desktop_native::media {
namespace {
constexpr auto gpu_completion_timeout = std::chrono::milliseconds(500);

using Microsoft::WRL::ComPtr;

[[noreturn]] void throwHResult(const char* operation, HRESULT result) {
  std::ostringstream message;
  message << operation << " (HRESULT 0x"
          << std::hex << std::uppercase
          << static_cast<std::uint32_t>(result) << ")";
  throw std::runtime_error(message.str());
}

[[noreturn]] void throwWin32Error(const char* operation, DWORD error) {
  std::ostringstream message;
  message << operation << " (Win32 " << error << ")";
  throw std::runtime_error(message.str());
}
}  // namespace

struct RemoteVideoTexturePool::State final
    : public std::enable_shared_from_this<RemoteVideoTexturePool::State> {
  enum class SlotPhase {
    Available,
    Uploading,
    Ready,
    Delivered,
  };

  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    std::unique_ptr<D3d11GpuCompletion> completion;
    HANDLE shared_handle = nullptr;
    HANDLE remote_handle = nullptr;
    std::uint32_t remote_pid = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint64_t timestamp_us = 0;
    std::uint64_t gpu_completion_us = 0;
    std::uint64_t generation = 0;
    SlotPhase phase = SlotPhase::Available;
  };

  class Lease final {
   public:
    Lease(
      std::shared_ptr<State> state,
      std::size_t slot,
      std::uint64_t generation
    ) : state_(std::move(state)),
        slot_(slot),
        generation_(generation) {}

    ~Lease() {
      state_->release(slot_, generation_);
    }

   private:
    std::shared_ptr<State> state_;
    std::size_t slot_;
    std::uint64_t generation_;
  };

  State(std::uint32_t electron_main_pid, std::size_t capacity)
      : electron_main_pid_(electron_main_pid),
        slots_(std::max<std::size_t>(1, capacity)) {
    if (electron_main_pid_ == 0) {
      throw std::invalid_argument("Electron main process ID is required");
    }
    D3D_FEATURE_LEVEL level{};
    const auto device_result = D3D11CreateDevice(
      nullptr,
      D3D_DRIVER_TYPE_HARDWARE,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      &device_,
      &level,
      &context_
    );
    if (FAILED(device_result)) {
      throwHResult("D3D11 remote video device creation failed", device_result);
    }
    main_process_ = OpenProcess(
      PROCESS_DUP_HANDLE,
      FALSE,
      electron_main_pid_
    );
    if (!main_process_) {
      throwWin32Error(
        "Electron main process handle open failed",
        GetLastError()
      );
    }
  }

  ~State() {
    std::lock_guard lock(mutex_);
    for (auto& slot : slots_) {
      closeRemoteHandle(slot);
      if (slot.shared_handle) CloseHandle(slot.shared_handle);
    }
    if (main_process_) CloseHandle(main_process_);
  }

  bool submit(
    const livekit::VideoFrame& frame,
    std::uint64_t timestamp_us
  ) {
    if (frame.type() != livekit::VideoBufferType::BGRA ||
        frame.width() <= 0 ||
        frame.height() <= 0) {
      throw std::invalid_argument(
        "Remote video texture upload requires a non-empty BGRA frame"
      );
    }
    std::lock_guard lock(mutex_);
    for (std::size_t attempt = 0; attempt < slots_.size(); ++attempt) {
      const auto index = (next_submit_slot_ + attempt) % slots_.size();
      auto& slot = slots_[index];
      if (slot.phase != SlotPhase::Available) continue;
      configureSlot(
        slot,
        static_cast<std::uint32_t>(frame.width()),
        static_cast<std::uint32_t>(frame.height())
      );
      context_->UpdateSubresource(
        slot.texture.Get(),
        0,
        nullptr,
        frame.data(),
        static_cast<UINT>(frame.width() * 4),
        0
      );
      const auto completion_result =
        slot.completion->begin(gpu_completion_timeout);
      if (FAILED(completion_result)) {
        throwHResult(
          "D3D11 remote video upload submission failed",
          completion_result
        );
      }
      slot.timestamp_us = timestamp_us;
      slot.gpu_completion_us = 0;
      slot.phase = SlotPhase::Uploading;
      next_submit_slot_ = (index + 1) % slots_.size();
      return true;
    }
    return false;
  }

  void poll() {
    std::lock_guard lock(mutex_);
    for (auto& slot : slots_) {
      if (slot.phase != SlotPhase::Uploading) continue;
      std::uint64_t elapsed_us = 0;
      const auto result = slot.completion->poll(&elapsed_us);
      if (result == S_FALSE) continue;
      if (FAILED(result)) {
        slot.phase = SlotPhase::Available;
        throwHResult(
          "D3D11 remote video upload did not complete",
          result
        );
      }
      slot.gpu_completion_us = elapsed_us;
      slot.phase = SlotPhase::Ready;
    }
  }

  bool take(RemoteVideoTextureFrame& frame) {
    std::lock_guard lock(mutex_);
    for (std::size_t attempt = 0; attempt < slots_.size(); ++attempt) {
      const auto index = (next_ready_slot_ + attempt) % slots_.size();
      auto& slot = slots_[index];
      if (slot.phase != SlotPhase::Ready) continue;

      HANDLE duplicated = nullptr;
      if (!DuplicateHandle(
            GetCurrentProcess(),
            slot.shared_handle,
            main_process_,
            &duplicated,
            0,
            FALSE,
            DUPLICATE_SAME_ACCESS)) {
        throwWin32Error(
          "DXGI remote video handle duplication failed",
          GetLastError()
        );
      }
      slot.remote_handle = duplicated;
      slot.remote_pid = electron_main_pid_;
      slot.phase = SlotPhase::Delivered;
      const auto generation = ++slot.generation;
      frame = RemoteVideoTextureFrame{
        reinterpret_cast<std::uint64_t>(duplicated),
        slot.timestamp_us,
        slot.gpu_completion_us,
        slot.width,
        slot.height,
        std::make_shared<Lease>(shared_from_this(), index, generation),
      };
      next_ready_slot_ = (index + 1) % slots_.size();
      return true;
    }
    return false;
  }

  std::size_t available() const {
    std::lock_guard lock(mutex_);
    return static_cast<std::size_t>(std::count_if(
      slots_.begin(),
      slots_.end(),
      [](const Slot& slot) {
        return slot.phase == SlotPhase::Available;
      }
    ));
  }

  std::size_t capacity() const {
    return slots_.size();
  }

 private:
  void configureSlot(
    Slot& slot,
    std::uint32_t width,
    std::uint32_t height
  ) {
    if (slot.texture && slot.width == width && slot.height == height) return;
    if (slot.shared_handle) CloseHandle(slot.shared_handle);
    slot.shared_handle = nullptr;
    slot.texture.Reset();
    slot.completion =
      std::make_unique<D3d11GpuCompletion>(device_.Get(), context_.Get());
    if (FAILED(slot.completion->initializationResult())) {
      throwHResult(
        "D3D11 remote video completion query creation failed",
        slot.completion->initializationResult()
      );
    }

    D3D11_TEXTURE2D_DESC description{};
    description.Width = width;
    description.Height = height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags =
      D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    description.MiscFlags =
      D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
      D3D11_RESOURCE_MISC_SHARED;
    const auto texture_result =
      device_->CreateTexture2D(&description, nullptr, &slot.texture);
    if (FAILED(texture_result)) {
      throwHResult(
        "D3D11 remote video shared texture creation failed",
        texture_result
      );
    }
    ComPtr<IDXGIResource1> resource;
    const auto resource_result = slot.texture.As(&resource);
    if (FAILED(resource_result)) {
      throwHResult(
        "DXGI remote video resource query failed",
        resource_result
      );
    }
    const auto handle_result = resource->CreateSharedHandle(
      nullptr,
      DXGI_SHARED_RESOURCE_READ,
      nullptr,
      &slot.shared_handle
    );
    if (FAILED(handle_result)) {
      throwHResult(
        "DXGI remote video shared handle creation failed",
        handle_result
      );
    }
    slot.width = width;
    slot.height = height;
  }

  void release(std::size_t index, std::uint64_t generation) noexcept {
    std::lock_guard lock(mutex_);
    if (index >= slots_.size()) return;
    auto& slot = slots_[index];
    if (slot.phase != SlotPhase::Delivered ||
        slot.generation != generation) {
      return;
    }
    closeRemoteHandle(slot);
    slot.phase = SlotPhase::Available;
  }

  static void closeRemoteHandle(Slot& slot) noexcept {
    if (!slot.remote_handle || slot.remote_pid == 0) {
      slot.remote_handle = nullptr;
      slot.remote_pid = 0;
      return;
    }
    const HANDLE process = OpenProcess(
      PROCESS_DUP_HANDLE,
      FALSE,
      slot.remote_pid
    );
    if (process) {
      HANDLE local = nullptr;
      if (DuplicateHandle(
            process,
            slot.remote_handle,
            GetCurrentProcess(),
            &local,
            0,
            FALSE,
            DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS)) {
        CloseHandle(local);
      }
      CloseHandle(process);
    }
    slot.remote_handle = nullptr;
    slot.remote_pid = 0;
  }

  mutable std::mutex mutex_;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  HANDLE main_process_ = nullptr;
  std::uint32_t electron_main_pid_;
  std::vector<Slot> slots_;
  std::size_t next_submit_slot_ = 0;
  std::size_t next_ready_slot_ = 0;
};

RemoteVideoTexturePool::RemoteVideoTexturePool(
  std::uint32_t electron_main_pid,
  std::size_t capacity
) : state_(std::make_shared<State>(electron_main_pid, capacity)) {}

RemoteVideoTexturePool::~RemoteVideoTexturePool() = default;

bool RemoteVideoTexturePool::submit(
  const livekit::VideoFrame& frame,
  std::uint64_t timestamp_us
) {
  return state_->submit(frame, timestamp_us);
}

void RemoteVideoTexturePool::poll() {
  state_->poll();
}

bool RemoteVideoTexturePool::take(RemoteVideoTextureFrame& frame) {
  return state_->take(frame);
}

std::size_t RemoteVideoTexturePool::available() const {
  return state_->available();
}

std::size_t RemoteVideoTexturePool::capacity() const {
  return state_->capacity();
}

}  // namespace syrnike::desktop_native::media

#endif
