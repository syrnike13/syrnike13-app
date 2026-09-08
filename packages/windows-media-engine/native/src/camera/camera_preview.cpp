#include "camera/camera_preview.hpp"
#include "capture/d3d11_device.hpp"
#include "capture/optional_preview_budget.hpp"

#include <dxgi1_2.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media::camera {
namespace {
using Clock = std::chrono::steady_clock;
using Microsoft::WRL::ComPtr;
constexpr std::uint32_t kWidth = CameraPreviewLease::width, kHeight = CameraPreviewLease::height;
constexpr std::uint64_t kTextureBytes = (kWidth * kHeight * 4ULL + 65535) & ~65535ULL;
enum class SlotPhase { free, copying, ready, delivered, quarantined };
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
void check(HRESULT result) { if (FAILED(result)) throw std::runtime_error("Camera preview GPU failure"); }
struct Slot {
  SlotPhase phase = SlotPhase::free;
  bool reserved = false;
  HANDLE handle = nullptr;
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<IDXGIKeyedMutex> keyed;
  ComPtr<ID3D11Query> query;
  CameraFrameMetadata metadata;
  Clock::time_point submitted;
  ~Slot() { clear(); }
  void clear() noexcept {
    if (handle) CloseHandle(std::exchange(handle, nullptr));
    query.Reset(); keyed.Reset(); texture.Reset();
    // A failed GPU/consumer fence cannot prove the exported allocation is no
    // longer retained externally. Keep its global reservation until process
    // restart, even when our COM references disappear. Recreating previews
    // therefore cannot turn a stalled renderer/driver into unbounded backing.
    if (std::exchange(reserved, false) && phase != SlotPhase::quarantined)
      capture::releaseOptionalPreview(kTextureBytes);
    phase = SlotPhase::free;
  }
};
}
struct CameraPreviewState {
  explicit CameraPreviewState(std::shared_ptr<CameraFramePort> port) : input(std::move(port)) {
    done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!done) throw std::runtime_error("Camera preview event creation failed");
  }
  ~CameraPreviewState() { CloseHandle(done); }
  std::shared_ptr<CameraFramePort> input;
  std::shared_ptr<capture::D3d11DeviceOwner> device;
  std::mutex mutex;
  std::array<Slot, 2> slots;
  CameraPreviewStats stats;
  std::atomic_bool stopping{false};
  HANDLE done = nullptr;
};
CameraPreviewLease::CameraPreviewLease(std::shared_ptr<CameraPreviewState> state, std::uint32_t slot,
                                     std::uintptr_t handle, CameraFrameMetadata metadata)
    : state_(std::move(state)), slot_(slot), handle_(handle), metadata_(metadata) {}
CameraPreviewLease::CameraPreviewLease(CameraPreviewLease&& other) noexcept
    : state_(std::move(other.state_)), slot_(other.slot_), handle_(std::exchange(other.handle_, 0)),
      metadata_(other.metadata_) {}
CameraPreviewLease& CameraPreviewLease::operator=(CameraPreviewLease&& other) noexcept {
  if (this != &other) {
    release(); state_ = std::move(other.state_); slot_ = other.slot_;
    handle_ = std::exchange(other.handle_, 0); metadata_ = other.metadata_;
  }
  return *this;
}
CameraPreviewLease::~CameraPreviewLease() { release(); }
void CameraPreviewLease::release() noexcept {
  if (!state_) return;
  {
    std::lock_guard lock(state_->mutex);
    auto& slot = state_->slots[slot_];
    // Reclaim both a consumed lease (key 0) and an unopened lease (key 1).
    auto result = slot.keyed->AcquireSync(0, 0);
    if (result != S_OK) result = slot.keyed->AcquireSync(1, 0);
    if (result == S_OK && SUCCEEDED(slot.keyed->ReleaseSync(0))) {
      slot.phase = SlotPhase::free;
      if (state_->stopping || slot.metadata.generation != state_->input->generation()) slot.clear();
    } else {
      slot.phase = SlotPhase::quarantined;
      state_->stats.last_gpu_result = static_cast<std::uint32_t>(result);
      state_->stats.failure = CameraPreviewFailure::consumer_stalled;
    }
  }
  state_.reset(); handle_ = 0;
}
CameraPreview::CameraPreview(std::shared_ptr<CameraFramePort> input) {
  if (!input) throw std::invalid_argument("Camera preview input is missing");
  state_ = std::make_shared<CameraPreviewState>(std::move(input));
  worker_ = std::thread([state = state_] { run(state); });
}
CameraPreview::~CameraPreview() { if (!stop(Clock::now() + std::chrono::seconds{5})) std::terminate(); }
bool CameraPreview::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  state_->stopping = true;
  if (!worker_.joinable()) return true;
  const auto wait_ms = static_cast<DWORD>((std::clamp)(
      std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count(),
      std::int64_t{0}, std::int64_t{5000}));
  if (WaitForSingleObject(state_->done, wait_ms) != WAIT_OBJECT_0) return false;
  worker_.join();
  return true;
}
std::optional<CameraPreviewLease> CameraPreview::take() {
  std::lock_guard lock(state_->mutex);
  if (state_->stopping) return std::nullopt;
  for (std::uint32_t index = 0; index < state_->slots.size(); ++index) {
    auto& slot = state_->slots[index];
    if (slot.phase != SlotPhase::ready) continue;
    if (slot.metadata.generation != state_->input->generation() ||
        timestamp() - slot.metadata.captured_100ns > kMaximumCameraAge100ns) {
      slot.clear(); ++state_->stats.dropped; continue;
    }
    slot.phase = SlotPhase::delivered;
    ++state_->stats.delivered;
    return CameraPreviewLease(state_, index, reinterpret_cast<std::uintptr_t>(slot.handle), slot.metadata);
  }
  return std::nullopt;
}
CameraPreviewStats CameraPreview::stats() const {
  std::lock_guard lock(state_->mutex);
  auto result = state_->stats;
  for (const auto& slot : state_->slots) {
    if (slot.reserved) result.backing_bytes += kTextureBytes;
    if (slot.phase == SlotPhase::delivered) ++result.outstanding;
    if (slot.phase == SlotPhase::quarantined) ++result.quarantined;
  }
  return result;
}
void CameraPreview::run(const std::shared_ptr<CameraPreviewState>& state) noexcept {
  try {
    state->device = capture::processD3d11Device(false);
    std::vector<std::uint8_t> input(kMaximumCameraBytes), scaled(kWidth * kHeight * 4);
    while (!state->stopping) {
      CameraFrameMetadata metadata;
      const bool available = state->input->take(metadata, input, timestamp());
      if (available) {
        for (std::uint32_t y = 0; y < kHeight; ++y) {
          for (std::uint32_t x = 0; x < kWidth; ++x) {
            const auto source = ((y * metadata.height / kHeight) * metadata.width +
                                 x * metadata.width / kWidth) * 4;
            std::memcpy(scaled.data() + (y * kWidth + x) * 4, input.data() + source, 4);
          }
        }
      }
      {
        std::lock_guard lock(state->mutex);
        std::unique_lock context(state->device->contextMutex(), std::try_to_lock);
        if (context.owns_lock()) {
          auto* gpu = state->device->context();
          for (auto& slot : state->slots) {
            if (slot.phase == SlotPhase::free && slot.texture &&
                slot.metadata.generation != state->input->generation()) slot.clear();
            if (slot.phase == SlotPhase::copying) {
              // Submit pending driver work even when capture has stopped. A
              // DONOTFLUSH poll can strand the final event query indefinitely.
              const auto result = gpu->GetData(slot.query.Get(), nullptr, 0, 0);
              if (result == S_OK) {
                const bool retired = slot.metadata.generation != state->input->generation();
                const auto released = slot.keyed->ReleaseSync(retired ? 0 : 1);
                if (FAILED(released)) {
                  slot.phase = SlotPhase::quarantined;
                  state->stats.last_gpu_result = static_cast<std::uint32_t>(released);
                  state->stats.failure = CameraPreviewFailure::gpu_failed;
                } else if (retired) slot.clear();
                else slot.phase = SlotPhase::ready;
              } else if (result != S_FALSE || Clock::now() - slot.submitted > std::chrono::milliseconds{500}) {
                slot.phase = SlotPhase::quarantined;
                state->stats.last_gpu_result = static_cast<std::uint32_t>(result);
                state->stats.failure = result == S_FALSE ? CameraPreviewFailure::gpu_stalled : CameraPreviewFailure::gpu_failed;
              }
            }
            if (slot.phase == SlotPhase::ready && (slot.metadata.generation != state->input->generation() ||
                timestamp() - slot.metadata.captured_100ns > kMaximumCameraAge100ns)) slot.clear();
          }
          if (available && metadata.generation == state->input->generation()) {
            auto found = std::find_if(state->slots.begin(), state->slots.end(), [](const auto& slot) {
              return slot.phase == SlotPhase::free;
            });
            if (found == state->slots.end()) ++state->stats.dropped;
            else {
              auto& slot = *found;
              if (!slot.texture && !capture::reserveOptionalPreview(kTextureBytes)) {
                state->stats.failure = CameraPreviewFailure::budget_exhausted; ++state->stats.dropped;
              } else {
                if (!slot.texture) {
                  slot.reserved = true;
                  D3D11_TEXTURE2D_DESC desc{};
                  desc.Width = kWidth; desc.Height = kHeight; desc.MipLevels = 1; desc.ArraySize = 1;
                  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
                  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
                  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
                  check(state->device->device()->CreateTexture2D(&desc, nullptr, &slot.texture));
                  ComPtr<IDXGIResource1> resource;
                  check(slot.texture.As(&resource));
                  check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
                      nullptr, &slot.handle));
                  check(slot.texture.As(&slot.keyed));
                  D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
                  check(state->device->device()->CreateQuery(&query, &slot.query));
                }
                const auto acquired = slot.keyed->AcquireSync(0, 0);
                if (acquired != S_OK) {
                  state->stats.last_gpu_result = static_cast<std::uint32_t>(acquired);
                  slot.phase = SlotPhase::quarantined; state->stats.failure = CameraPreviewFailure::consumer_stalled;
                } else {
                  gpu->UpdateSubresource(slot.texture.Get(), 0, nullptr, scaled.data(), kWidth * 4, 0);
                  gpu->End(slot.query.Get()); gpu->Flush();
                  slot.metadata = metadata; slot.submitted = Clock::now(); slot.phase = SlotPhase::copying;
                  ++state->stats.submitted;
                }
              }
            }
          }
        } else if (available) ++state->stats.dropped;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds{5});
    }
  } catch (...) {
    std::lock_guard lock(state->mutex);
    state->stats.failure = CameraPreviewFailure::gpu_failed;
  }
  // Stop stops admission first, then gives submitted GPU work a finite chance
  // to complete. Never recycle its reservation merely because CPU work ended.
  const auto drained_by = Clock::now() + std::chrono::milliseconds{500};
  for (;;) {
    bool pending = false;
    {
      std::lock_guard lock(state->mutex);
      if (state->device) {
        std::unique_lock context(state->device->contextMutex(), std::try_to_lock);
        for (auto& slot : state->slots) {
          if (slot.phase != SlotPhase::copying) continue;
          const auto result = context.owns_lock()
              ? state->device->context()->GetData(slot.query.Get(), nullptr, 0, 0)
              : S_FALSE;
          if (result == S_OK) {
            const auto released = slot.keyed->ReleaseSync(0);
            if (FAILED(released)) {
              slot.phase = SlotPhase::quarantined;
              state->stats.last_gpu_result = static_cast<std::uint32_t>(released);
              state->stats.failure = CameraPreviewFailure::gpu_failed;
            } else slot.clear();
          }
          else if (result != S_FALSE || Clock::now() >= drained_by) {
            slot.phase = SlotPhase::quarantined;
            state->stats.last_gpu_result = static_cast<std::uint32_t>(result);
            state->stats.failure = CameraPreviewFailure::gpu_stalled;
          } else pending = true;
        }
      }
    }
    if (!pending) break;
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
  {
    std::lock_guard lock(state->mutex);
    state->stopping = true;
    for (auto& slot : state->slots) if (slot.phase != SlotPhase::delivered) slot.clear();
    state->input.reset();
  }
  SetEvent(state->done);
}
}  // namespace syrnike::windows_media::camera
