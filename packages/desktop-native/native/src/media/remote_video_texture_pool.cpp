#include "remote_video_texture_pool.hpp"

#ifdef _WIN32

#include <d3d11.h>
#include <d3d11sdklayers.h>
#include <d3d10.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>

#include "d3d11_gpu_completion.hpp"
#include "remote_video_texture_pool_policy.hpp"
#include "video_resource_admission.hpp"

namespace syrnike::desktop_native::media {
namespace {
constexpr auto gpu_completion_timeout = std::chrono::milliseconds(500);

using Microsoft::WRL::ComPtr;

bool d3dDebugLayerRequested() noexcept {
  char value[2]{};
  return GetEnvironmentVariableA(
      "SYRNIKE_MEDIA_D3D11_DEBUG", value, static_cast<DWORD>(std::size(value))) ==
    1 && value[0] == '1';
}

[[noreturn]] void throwHResult(const char* operation, HRESULT result) {
  std::ostringstream message;
  message << operation << " (HRESULT 0x"
          << std::hex << std::uppercase
          << static_cast<std::uint32_t>(result) << ")";
  throw RemoteVideoTexturePoolError(
      message.str(), static_cast<long>(result));
}

[[noreturn]] void throwWin32Error(const char* operation, DWORD error) {
  std::ostringstream message;
  message << operation << " (Win32 " << error << ")";
  throw RemoteVideoTexturePoolError(
      message.str(), static_cast<long>(HRESULT_FROM_WIN32(error)));
}
}  // namespace

struct RemoteVideoD3dDeviceOwner::State final {
  struct Completion final {
    explicit Completion(
      ID3D11Device* device,
      ID3D11DeviceContext* context
    ) : completion(device, context) {}

    D3d11GpuCompletion completion;
  };

  State(
    VideoResourceAdmissionBudget& resource_budget,
    std::string owner_id,
    std::uint32_t electron_main_pid,
    RemoteVideoD3dDeviceOperationProbe operation_probe
  ) : resource_lease(requireVideoResourceAdmission(
          resource_budget,
          VideoResourceRequest{
              .owner = VideoResourceOwner::RemoteVideo,
              .owner_id = std::move(owner_id),
              .d3d_devices = 1,
          })),
      electron_main_pid(electron_main_pid),
      operation_probe(std::move(operation_probe)),
      identity(next_identity.fetch_add(1, std::memory_order_relaxed)) {
    if (electron_main_pid == 0) {
      throw std::invalid_argument("Electron main process ID is required");
    }
    D3D_FEATURE_LEVEL level{};
    debug_layer_enabled = d3dDebugLayerRequested();
    const auto result = D3D11CreateDevice(
      nullptr,
      D3D_DRIVER_TYPE_HARDWARE,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT |
        (debug_layer_enabled ? D3D11_CREATE_DEVICE_DEBUG : 0),
      nullptr,
      0,
      D3D11_SDK_VERSION,
      &device,
      &level,
      &context
    );
    if (FAILED(result)) {
      throwHResult("D3D11 remote video device creation failed", result);
    }
    if (debug_layer_enabled) {
      const auto queue_result = device.As(&debug_queue);
      if (FAILED(queue_result)) {
        throwHResult(
          "D3D11 remote video debug queue query failed", queue_result);
      }
    }
    ComPtr<ID3D10Multithread> multithread;
    const auto multithread_result = context.As(&multithread);
    if (FAILED(multithread_result)) {
      throwHResult(
        "D3D11 remote video multithread protection query failed",
        multithread_result
      );
    }
    multithread->SetMultithreadProtected(TRUE);
    multithread_protected = multithread->GetMultithreadProtected() != FALSE;
    if (!multithread_protected) {
      throw RemoteVideoTexturePoolError(
        "D3D11 remote video multithread protection was not enabled",
        static_cast<long>(E_FAIL)
      );
    }
    main_process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, electron_main_pid);
    if (!main_process) {
      throwWin32Error(
        "Electron main process handle open failed", GetLastError());
    }
    drainDebugMessages("device-created");
  }

  ~State() {
    if (main_process) CloseHandle(main_process);
  }

  void configure(
    std::uint32_t width,
    std::uint32_t height,
    ComPtr<ID3D11Texture2D>& texture,
    std::unique_ptr<Completion>& completion,
    HANDLE& shared_handle
  ) {
    std::lock_guard lock(context_mutex);
    if (shared_handle) CloseHandle(shared_handle);
    shared_handle = nullptr;
    texture.Reset();
    completion = std::make_unique<Completion>(device.Get(), context.Get());
    if (FAILED(completion->completion.initializationResult())) {
      throwHResult(
        "D3D11 remote video completion query creation failed",
        completion->completion.initializationResult()
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
      D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
    const auto texture_result =
      device->CreateTexture2D(&description, nullptr, &texture);
    if (FAILED(texture_result)) {
      throwHResult(
        "D3D11 remote video shared texture creation failed", texture_result);
    }
    ComPtr<IDXGIResource1> resource;
    const auto resource_result = texture.As(&resource);
    if (FAILED(resource_result)) {
      throwHResult(
        "DXGI remote video resource query failed", resource_result);
    }
    const auto handle_result = resource->CreateSharedHandle(
      nullptr, DXGI_SHARED_RESOURCE_READ, nullptr, &shared_handle);
    if (FAILED(handle_result)) {
      throwHResult(
        "DXGI remote video shared handle creation failed", handle_result);
    }
    drainDebugMessages("texture-configured");
  }

  HRESULT submit(
    ID3D11Texture2D* texture,
    Completion& completion,
    const void* data,
    UINT row_pitch,
    std::chrono::milliseconds timeout
  ) {
    std::lock_guard lock(context_mutex);
    if (operation_probe) operation_probe(RemoteVideoD3dDeviceOperation::Submit);
    context->UpdateSubresource(texture, 0, nullptr, data, row_pitch, 0);
    const auto result = completion.completion.begin(timeout);
    drainDebugMessages("frame-submitted");
    return result;
  }

  HRESULT poll(Completion& completion, std::uint64_t* elapsed_us) {
    std::lock_guard lock(context_mutex);
    if (operation_probe) operation_probe(RemoteVideoD3dDeviceOperation::Poll);
    const auto result = completion.completion.poll(elapsed_us);
    drainDebugMessages("completion-polled");
    return result;
  }

  HANDLE duplicateForElectron(HANDLE shared_handle) {
    std::lock_guard lock(context_mutex);
    HANDLE duplicated = nullptr;
    if (!DuplicateHandle(
          GetCurrentProcess(), shared_handle, main_process, &duplicated,
          0, FALSE, DUPLICATE_SAME_ACCESS)) {
      throwWin32Error(
        "DXGI remote video handle duplication failed", GetLastError());
    }
    drainDebugMessages("handle-duplicated");
    return duplicated;
  }

  void closeElectronHandle(HANDLE remote_handle) noexcept {
    if (!remote_handle) return;
    std::lock_guard lock(context_mutex);
    HANDLE local = nullptr;
    if (DuplicateHandle(
          main_process, remote_handle, GetCurrentProcess(), &local,
          0, FALSE, DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS)) {
      CloseHandle(local);
    }
    drainDebugMessages("electron-handle-closed");
  }

  void drainDebugMessages(const char* stage) noexcept {
    if (!debug_queue) return;
    const auto count = debug_queue->GetNumStoredMessagesAllowedByRetrievalFilter();
    for (UINT64 index = 0; index < count; ++index) {
      SIZE_T bytes = 0;
      if (FAILED(debug_queue->GetMessage(index, nullptr, &bytes)) || bytes == 0) {
        continue;
      }
      std::vector<char> storage(bytes);
      auto* message = reinterpret_cast<D3D11_MESSAGE*>(storage.data());
      if (FAILED(debug_queue->GetMessage(index, message, &bytes)) ||
          message->Severity > D3D11_MESSAGE_SEVERITY_WARNING) {
        continue;
      }
      auto description_bytes = message->DescriptionByteLength;
      if (description_bytes > 0 &&
          message->pDescription[description_bytes - 1] == '\0') {
        --description_bytes;
      }
      std::cerr << "D3D11_DEBUG stage=" << stage
                << " severity=" << static_cast<unsigned>(message->Severity)
                << " category=" << static_cast<unsigned>(message->Category)
                << " id=" << static_cast<unsigned>(message->ID)
                << " description="
                << std::string_view(
                     message->pDescription,
                     description_bytes)
                << '\n';
    }
    debug_queue->ClearStoredMessages();
  }

  inline static std::atomic_uint64_t next_identity{1};
  std::shared_ptr<VideoResourceLease> resource_lease;
  mutable std::mutex context_mutex;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11InfoQueue> debug_queue;
  HANDLE main_process = nullptr;
  std::uint32_t electron_main_pid = 0;
  RemoteVideoD3dDeviceOperationProbe operation_probe;
  std::uint64_t identity = 0;
  bool multithread_protected = false;
  bool debug_layer_enabled = false;
};

RemoteVideoD3dDeviceOwner::RemoteVideoD3dDeviceOwner(
  std::shared_ptr<State> state
) : state_(std::move(state)) {}

std::shared_ptr<RemoteVideoD3dDeviceOwner>
RemoteVideoD3dDeviceOwner::create(
  VideoResourceAdmissionBudget& resource_budget,
  std::string owner_id,
  std::uint32_t electron_main_pid,
  RemoteVideoD3dDeviceOperationProbe operation_probe
) {
  return std::shared_ptr<RemoteVideoD3dDeviceOwner>(
    new RemoteVideoD3dDeviceOwner(std::make_shared<State>(
      resource_budget,
      std::move(owner_id),
      electron_main_pid,
      std::move(operation_probe)
    )));
}

RemoteVideoD3dDeviceOwner::~RemoteVideoD3dDeviceOwner() = default;

std::uint64_t RemoteVideoD3dDeviceOwner::identity() const noexcept {
  return state_->identity;
}

std::uint64_t RemoteVideoD3dDeviceOwner::deviceReservationId() const noexcept {
  return state_->resource_lease->reservationId();
}

bool RemoteVideoD3dDeviceOwner::multithreadProtected() const noexcept {
  return state_->multithread_protected;
}

std::shared_ptr<RemoteVideoD3dDeviceOwner>
selectRemoteVideoD3dDeviceOwnerForRollover(
  const std::shared_ptr<RemoteVideoD3dDeviceOwner>& current,
  RemoteVideoGpuRolloverCause cause,
  VideoResourceAdmissionBudget& resource_budget,
  std::string owner_id,
  std::uint32_t electron_main_pid
) {
  if (cause != RemoteVideoGpuRolloverCause::DeviceFailure) {
    if (!current) throw std::invalid_argument("current D3D owner is required");
    return current;
  }
  return RemoteVideoD3dDeviceOwner::create(
    resource_budget, std::move(owner_id), electron_main_pid);
}

struct RemoteVideoTexturePool::State final
    : public std::enable_shared_from_this<RemoteVideoTexturePool::State> {
  using SlotPhase = RemoteVideoTextureSlotPhase;

  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    std::unique_ptr<RemoteVideoD3dDeviceOwner::State::Completion> completion;
    HANDLE shared_handle = nullptr;
    HANDLE remote_handle = nullptr;
    std::uint32_t remote_pid = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint64_t timestamp_us = 0;
    std::uint64_t source_timestamp_us = 0;
    std::uint32_t source_frame_id = 0;
    std::uint64_t gpu_completion_us = 0;
    std::uint64_t submission_sequence = 0;
    std::chrono::steady_clock::time_point submitted_at{};
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

  State(
      std::shared_ptr<RemoteVideoD3dDeviceOwner> device_owner,
      VideoResourceAdmissionBudget& resource_budget,
      std::string owner_id,
      std::uint32_t width,
      std::uint32_t height,
      std::size_t capacity,
      RemoteVideoTextureCompletionPollControl completion_poll_control)
      : resource_lease_(requireVideoResourceAdmission(
            resource_budget,
            VideoResourceRequest{
                .owner = VideoResourceOwner::RemoteVideo,
                .owner_id = std::move(owner_id),
                .gpu_generations = 1,
                .textures = {{
                    .width = width,
                    .height = height,
                    .count = std::max<std::size_t>(1, capacity),
                    .format = VideoTextureFormat::Bgra8,
                }},
            })),
        device_owner_(std::move(device_owner)),
        width_(width),
        height_(height),
        slots_(std::max<std::size_t>(1, capacity)),
        completion_poll_control_(std::move(completion_poll_control)) {
    if (!device_owner_) {
      throw std::invalid_argument("remote video D3D device owner is required");
    }
    if (width_ == 0 || height_ == 0) {
      throw std::invalid_argument("remote video pool dimensions are required");
    }
  }

  ~State() {
    std::lock_guard lock(mutex_);
    // Resolution rollovers keep the healthy device/context and retire the old
    // pool on a background worker. COM release enters the user-mode driver too,
    // so serialize it with submit/poll/configure on that shared context. The
    // D3D11 multithread flag does not protect an application from releasing a
    // query or texture while another thread is inside a driver call for the
    // same immediate context.
    std::lock_guard context_lock(device_owner_->state_->context_mutex);
    for (auto& slot : slots_) {
      // DuplicateHandle put this value in Electron's handle table. Closing it
      // here recycles that NT number while the renderer may still hold the
      // import (injected fence, probe-epoch churn). Electron owns the
      // duplicate; native only closes it when the slot texture itself changes.
      slot.remote_handle = nullptr;
      slot.remote_pid = 0;
      if (slot.shared_handle) CloseHandle(slot.shared_handle);
      slot.shared_handle = nullptr;
      slot.completion.reset();
      slot.texture.Reset();
    }
  }

  bool submit(
    const livekit::VideoFrame& frame,
    std::uint64_t timestamp_us,
    std::uint64_t source_timestamp_us,
    std::uint32_t source_frame_id
  ) {
    if (frame.type() != livekit::VideoBufferType::BGRA ||
        frame.width() <= 0 ||
        frame.height() <= 0) {
      throw std::invalid_argument(
          "Remote video texture upload requires a non-empty BGRA frame"
      );
    }
    if (static_cast<std::uint32_t>(frame.width()) != width_ ||
        static_cast<std::uint32_t>(frame.height()) != height_) {
      throw std::invalid_argument(
          "Remote video texture upload dimensions do not match its admitted generation");
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
      const auto completion_result =
        device_owner_->state_->submit(
          slot.texture.Get(),
          *slot.completion,
          frame.data(),
          static_cast<UINT>(frame.width() * 4),
          gpu_completion_timeout
        );
      if (FAILED(completion_result)) {
        throwHResult(
          "D3D11 remote video upload submission failed",
          completion_result
        );
      }
      slot.timestamp_us = timestamp_us;
      slot.source_timestamp_us = source_timestamp_us;
      slot.source_frame_id = source_frame_id;
      slot.gpu_completion_us = 0;
      slot.submission_sequence = ++next_submission_sequence_;
      if (completion_poll_control_) {
        slot.submitted_at = std::chrono::steady_clock::now();
      }
      slot.phase = SlotPhase::Uploading;
      next_submit_slot_ = (index + 1) % slots_.size();
      return true;
    }
    return false;
  }

  RemoteVideoTexturePollResult poll() {
    std::lock_guard lock(mutex_);
    RemoteVideoTexturePollResult outcome;
    for (auto& slot : slots_) {
      const bool was_quarantined = slot.phase == SlotPhase::Quarantined;
      if (slot.phase != SlotPhase::Uploading && !was_quarantined) continue;
      std::uint64_t elapsed_us = 0;
      bool withhold_real_poll = false;
      if (completion_poll_control_) {
        elapsed_us = static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - slot.submitted_at)
                .count());
        withhold_real_poll = completion_poll_control_({
              .pool_reservation_id = resource_lease_->reservationId(),
              .submission_sequence = slot.submission_sequence,
              .elapsed_us = elapsed_us,
              .timeout_us = static_cast<std::uint64_t>(
                  std::chrono::duration_cast<std::chrono::microseconds>(
                      gpu_completion_timeout)
                      .count()),
              .quarantined = was_quarantined,
          });
      }
      HRESULT result = S_FALSE;
      RemoteVideoGpuPollClass poll_class = RemoteVideoGpuPollClass::Pending;
      if (withhold_real_poll) {
        if (elapsed_us >= static_cast<std::uint64_t>(
                std::chrono::duration_cast<std::chrono::microseconds>(
                    gpu_completion_timeout)
                    .count())) {
          result = DXGI_ERROR_WAIT_TIMEOUT;
          poll_class = RemoteVideoGpuPollClass::TimedOut;
        }
      } else {
        result = device_owner_->state_->poll(*slot.completion, &elapsed_us);
        const auto generic_class = classifyGpuCompletionPoll(result);
        poll_class = generic_class == GpuCompletionPollClass::Pending
          ? RemoteVideoGpuPollClass::Pending
          : generic_class == GpuCompletionPollClass::TimedOut
            ? RemoteVideoGpuPollClass::TimedOut
            : generic_class == GpuCompletionPollClass::DeviceFailed
              ? RemoteVideoGpuPollClass::Failed
              : RemoteVideoGpuPollClass::Completed;
      }
      const auto transition = decideRemoteVideoSlotTransition(
        slot.phase, poll_class);
      slot.phase = transition.next;
      if (transition.newly_quarantined) {
        ++outcome.slots_quarantined;
        if (outcome.hresult == 0) {
          outcome.hresult = static_cast<long>(result);
        }
      }
      if (transition.device_failed) {
        outcome.reset_required = true;
        // A terminal device failure outranks a quarantine timeout recorded by
        // an earlier slot in this same polling pass.
        outcome.hresult = static_cast<long>(result);
        // The query is terminal and the whole pool will be retired. Mark the
        // slot reusable only so retirement cannot retain a dead device.
        slot.completion.reset();
        continue;
      }
      if (transition.next == SlotPhase::Uploading ||
          transition.next == SlotPhase::Quarantined) {
        continue;
      }
      slot.gpu_completion_us = elapsed_us;
      if (transition.recovered) {
        // The policy keeps a late static frame eligible for latest-wins
        // selection; take() discards it only when a newer frame is ready.
        ++outcome.slots_recovered;
      }
    }
    const auto quarantined_count = countPhase(SlotPhase::Quarantined);
    const auto upload_capable = countPhase(SlotPhase::Available) +
      countPhase(SlotPhase::Uploading) + countPhase(SlotPhase::Ready);
    outcome.upload_capacity_exhausted =
      quarantined_count > 0 && upload_capable == 0;
    return outcome;
  }

  bool take(RemoteVideoTextureFrame& frame) {
    std::lock_guard lock(mutex_);
    std::size_t newest_index = slots_.size();
    std::uint64_t newest_sequence = 0;
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      const auto& slot = slots_[index];
      if (slot.phase == SlotPhase::Ready &&
          (newest_index == slots_.size() ||
           slot.submission_sequence > newest_sequence)) {
        newest_index = index;
        newest_sequence = slot.submission_sequence;
      }
    }
    if (newest_index == slots_.size()) return false;

    // Live video has a freshness deadline, not a delivery guarantee. Once the
    // newest completed texture is selected, older completed textures can be
    // reused immediately instead of building latency behind the renderer.
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      if (index == newest_index || slots_[index].phase != SlotPhase::Ready) {
        continue;
      }
      slots_[index].phase = SlotPhase::Available;
      ++superseded_ready_frames_;
    }
    auto& slot = slots_[newest_index];

    // One stable Electron HANDLE per slot. A fresh DuplicateHandle on every
    // take() plus DUPLICATE_CLOSE_SOURCE on release lets Windows reuse the
    // number while Electron still holds the previous import.
    HANDLE duplicated = slot.remote_handle;
    if (!duplicated) {
      duplicated =
        device_owner_->state_->duplicateForElectron(slot.shared_handle);
      slot.remote_handle = duplicated;
      slot.remote_pid = device_owner_->state_->electron_main_pid;
    }
    slot.phase = SlotPhase::Delivered;
    const auto generation = ++slot.generation;
    frame = RemoteVideoTextureFrame{
      reinterpret_cast<std::uint64_t>(duplicated),
      slot.timestamp_us,
      slot.source_timestamp_us,
      slot.source_frame_id,
      slot.gpu_completion_us,
      slot.width,
      slot.height,
      std::make_shared<Lease>(shared_from_this(), newest_index, generation),
    };
    return true;
  }

  std::uint64_t discardReady() {
    std::lock_guard lock(mutex_);
    std::uint64_t discarded = 0;
    for (auto& slot : slots_) {
      if (slot.phase != SlotPhase::Ready) continue;
      slot.phase = SlotPhase::Available;
      ++discarded;
    }
    superseded_ready_frames_ += discarded;
    return discarded;
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

  std::size_t ready() const {
    std::lock_guard lock(mutex_);
    return countPhase(SlotPhase::Ready);
  }

  std::size_t quarantined() const {
    std::lock_guard lock(mutex_);
    return countPhase(SlotPhase::Quarantined);
  }

  bool retirementSafe() const {
    std::lock_guard lock(mutex_);
    return countPhase(SlotPhase::Uploading) == 0 &&
      countPhase(SlotPhase::Quarantined) == 0;
  }

  std::uint64_t consumeSupersededReadyFrames() {
    std::lock_guard lock(mutex_);
    return std::exchange(superseded_ready_frames_, 0);
  }

  std::uint32_t width() const noexcept { return width_; }
  std::uint32_t height() const noexcept { return height_; }
  std::uint64_t deviceOwnerIdentity() const noexcept {
    return device_owner_->identity();
  }
  std::uint64_t deviceReservationId() const noexcept {
    return device_owner_->deviceReservationId();
  }
  std::uint64_t generationReservationId() const noexcept {
    return resource_lease_->reservationId();
  }
  std::shared_ptr<RemoteVideoD3dDeviceOwner> deviceOwner() const {
    return device_owner_;
  }

 private:
  std::size_t countPhase(SlotPhase phase) const {
    return static_cast<std::size_t>(std::count_if(
      slots_.begin(),
      slots_.end(),
      [phase](const Slot& slot) { return slot.phase == phase; }
    ));
  }

  void configureSlot(
    Slot& slot,
    std::uint32_t width,
    std::uint32_t height
  ) {
    if (slot.texture && slot.completion &&
        slot.width == width && slot.height == height) return;
    closeRemoteHandle(slot);
    device_owner_->state_->configure(
      width, height, slot.texture, slot.completion, slot.shared_handle);
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
    slot.phase = SlotPhase::Available;
  }

  void closeRemoteHandle(Slot& slot) noexcept {
    if (!slot.remote_handle || slot.remote_pid == 0) {
      slot.remote_handle = nullptr;
      slot.remote_pid = 0;
      return;
    }
    device_owner_->state_->closeElectronHandle(slot.remote_handle);
    slot.remote_handle = nullptr;
    slot.remote_pid = 0;
  }

  std::shared_ptr<VideoResourceLease> resource_lease_;
  mutable std::mutex mutex_;
  std::shared_ptr<RemoteVideoD3dDeviceOwner> device_owner_;
  std::uint32_t width_ = 0;
  std::uint32_t height_ = 0;
  std::vector<Slot> slots_;
  RemoteVideoTextureCompletionPollControl completion_poll_control_;
  std::size_t next_submit_slot_ = 0;
  std::uint64_t next_submission_sequence_ = 0;
  std::uint64_t superseded_ready_frames_ = 0;
};

RemoteVideoTexturePool::RemoteVideoTexturePool(
  VideoResourceAdmissionBudget& resource_budget,
  std::string owner_id,
  std::uint32_t electron_main_pid,
  std::uint32_t width,
  std::uint32_t height,
  std::size_t capacity,
  RemoteVideoTextureCompletionPollControl completion_poll_control
) : state_([&] {
      auto device_owner = RemoteVideoD3dDeviceOwner::create(
        resource_budget, owner_id, electron_main_pid);
      return std::make_shared<State>(
        std::move(device_owner),
        resource_budget,
        std::move(owner_id),
        width,
        height,
        capacity,
        std::move(completion_poll_control));
    }()) {}

RemoteVideoTexturePool::RemoteVideoTexturePool(
  std::shared_ptr<RemoteVideoD3dDeviceOwner> device_owner,
  VideoResourceAdmissionBudget& resource_budget,
  std::string owner_id,
  std::uint32_t width,
  std::uint32_t height,
  std::size_t capacity,
  RemoteVideoTextureCompletionPollControl completion_poll_control
) : state_(std::make_shared<State>(
      std::move(device_owner),
      resource_budget,
      std::move(owner_id),
      width,
      height,
      capacity,
      std::move(completion_poll_control))) {}

RemoteVideoTexturePool::~RemoteVideoTexturePool() = default;

bool RemoteVideoTexturePool::submit(
  const livekit::VideoFrame& frame,
  std::uint64_t timestamp_us,
  std::uint64_t source_timestamp_us,
  std::uint32_t source_frame_id
) {
  return state_->submit(
    frame, timestamp_us, source_timestamp_us, source_frame_id);
}

RemoteVideoTexturePollResult RemoteVideoTexturePool::poll() {
  return state_->poll();
}

bool RemoteVideoTexturePool::take(RemoteVideoTextureFrame& frame) {
  return state_->take(frame);
}

std::uint64_t RemoteVideoTexturePool::discardReady() {
  return state_->discardReady();
}

std::size_t RemoteVideoTexturePool::available() const {
  return state_->available();
}

std::size_t RemoteVideoTexturePool::capacity() const {
  return state_->capacity();
}

std::size_t RemoteVideoTexturePool::ready() const {
  return state_->ready();
}

std::size_t RemoteVideoTexturePool::quarantined() const {
  return state_->quarantined();
}

std::uint32_t RemoteVideoTexturePool::width() const noexcept {
  return state_->width();
}

std::uint32_t RemoteVideoTexturePool::height() const noexcept {
  return state_->height();
}

bool RemoteVideoTexturePool::retirementSafe() const {
  return state_->retirementSafe();
}

std::uint64_t RemoteVideoTexturePool::consumeSupersededReadyFrames() {
  return state_->consumeSupersededReadyFrames();
}

std::uint64_t RemoteVideoTexturePool::deviceOwnerIdentity() const noexcept {
  return state_->deviceOwnerIdentity();
}

std::uint64_t RemoteVideoTexturePool::deviceReservationId() const noexcept {
  return state_->deviceReservationId();
}

std::uint64_t RemoteVideoTexturePool::generationReservationId() const noexcept {
  return state_->generationReservationId();
}

std::shared_ptr<RemoteVideoD3dDeviceOwner>
RemoteVideoTexturePool::deviceOwner() const {
  return state_->deviceOwner();
}

}  // namespace syrnike::desktop_native::media

#endif
