#include "video/shared_texture_pool.hpp"

#include <dxgi1_2.h>

#include <algorithm>
#include <stdexcept>
#include <thread>

namespace syrnike::windows_media::video {
namespace {
void checked(HRESULT value) {
  if (FAILED(value)) throw std::runtime_error("remote_video_d3d_failure");
}
std::uint64_t bytes(const TextureLease& lease) {
  // Conservative row alignment for estimated D3D backing accounting.
  const auto rows =
      ((std::uint64_t{lease.width} * 4 + 255) & ~255ULL) * lease.height;
  return (rows + 65535) & ~65535ULL;
}
}  // namespace
SharedTexturePool& SharedTexturePool::processPool() {
  static SharedTexturePool pool;
  return pool;
}
SharedTexturePool::~SharedTexturePool() {
  for (auto& slot : slots_) clear(slot);
}
void SharedTexturePool::clear(Slot& slot) {
  if (slot.lease.handle)
    CloseHandle(reinterpret_cast<HANDLE>(slot.lease.handle));
  metrics_.backing_bytes -= bytes(slot.lease);
  slot = {};
}
std::uint64_t SharedTexturePool::beginGeneration() {
  std::scoped_lock lock(mutex_);
  const auto free =
      std::find(active_generations_.begin(), active_generations_.end(), 0);
  if (free == active_generations_.end())
    throw std::runtime_error("remote_video_generation_capacity");
  *free = ++metrics_.generation;
  return *free;
}
void SharedTexturePool::retire(std::uint64_t generation) {
  std::scoped_lock lock(mutex_);
  const auto active = std::find(active_generations_.begin(),
                                active_generations_.end(), generation);
  if (generation == 0 || active == active_generations_.end()) return;
  *active = 0;
  ++metrics_.generation;
  for (auto& slot : slots_) {
    if (slot.lease.generation != generation) continue;
    if (slot.state == SlotState::Free)
      clear(slot);
    else if (slot.state == SlotState::Delivered)
      slot.state = SlotState::Retired;
  }
}
std::optional<TextureLease> SharedTexturePool::upload(
    std::uint64_t generation, std::uint32_t width, std::uint32_t height,
    std::int64_t timestamp_us, std::span<const std::uint8_t> bgra,
    std::int64_t ingress_us) {
  std::scoped_lock lock(mutex_);
  const auto drop = [this]() -> std::optional<TextureLease> {
    ++metrics_.dropped;
    return {};
  };
  if (generation == 0 ||
      std::find(active_generations_.begin(), active_generations_.end(),
                generation) == active_generations_.end() ||
      width == 0 || height == 0 || width > 3840 || height > 2160 ||
      bgra.size() != std::uint64_t{width} * height * 4)
    return drop();
  for (std::uint32_t index = 0; index < slots_.size(); ++index) {
    auto& slot = slots_[index];
    if (slot.state != SlotState::Free) continue;
    if (!device_) device_ = capture::processD3d11Device(true);
    if (!slot.texture || slot.lease.width != width ||
        slot.lease.height != height) {
      clear(slot);
      TextureLease allocation;
      allocation.generation = generation;
      allocation.slot = index;
      allocation.width = width;
      allocation.height = height;
      allocation.timestamp_us = timestamp_us;
      if (metrics_.backing_bytes + bytes(allocation) > kBudget) return drop();
      D3D11_TEXTURE2D_DESC desc{};
      desc.Width = width;
      desc.Height = height;
      desc.MipLevels = 1;
      desc.ArraySize = 1;
      desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      desc.SampleDesc.Count = 1;
      desc.Usage = D3D11_USAGE_DEFAULT;
      desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
      desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
                       D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
      checked(
          device_->device()->CreateTexture2D(&desc, nullptr, &slot.texture));
      slot.lease = allocation;
      metrics_.backing_bytes += bytes(allocation);
      Microsoft::WRL::ComPtr<IDXGIResource1> resource;
      checked(slot.texture.As(&resource));
      HANDLE handle = nullptr;
      checked(resource->CreateSharedHandle(
          nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
          nullptr, &handle));
      allocation.handle = reinterpret_cast<std::uintptr_t>(handle);
      slot.lease = allocation;
    }
    // CPU upload runs on a worker lane, never an SDK callback. Complete the GPU
    // write before export. A hung device quarantines its backing; no reuse.
    slot.lease.generation = generation;
    slot.state = SlotState::Quarantined;
    Microsoft::WRL::ComPtr<IDXGIKeyedMutex> keyed;
    checked(slot.texture.As(&keyed));
    if (keyed->AcquireSync(0, 0) != S_OK) return drop();
    bool complete = false;
    {
      std::scoped_lock context_lock(device_->contextMutex());
      Microsoft::WRL::ComPtr<ID3D11Query> query;
      D3D11_QUERY_DESC query_desc{D3D11_QUERY_EVENT, 0};
      const auto query_result =
          device_->device()->CreateQuery(&query_desc, &query);
      if (SUCCEEDED(query_result)) {
        device_->context()->UpdateSubresource(slot.texture.Get(), 0, nullptr,
                                              bgra.data(), width * 4, 0);
        device_->context()->End(query.Get());
        device_->context()->Flush();
        const auto deadline =
            std::chrono::steady_clock::now() + std::chrono::milliseconds(200);
        HRESULT status = S_FALSE;
        do {
          status = device_->context()->GetData(query.Get(), nullptr, 0, 0);
          if (status != S_FALSE) break;
          std::this_thread::yield();
        } while (std::chrono::steady_clock::now() < deadline);
        complete = status == S_OK;
      }
    }
    checked(keyed->ReleaseSync(0));
    if (!complete) return drop();
    slot.lease.generation = generation;
    slot.lease.sequence = ++sequence_;
    slot.lease.timestamp_us = timestamp_us;
    slot.lease.ingress_us = ingress_us;
    slot.state = SlotState::Delivered;
    slot.delivered_at = std::chrono::steady_clock::now();
    ++metrics_.accepted;
    return slot.lease;
  }
  return drop();
}
bool SharedTexturePool::release(std::uint64_t generation,
                                std::uint64_t sequence, std::uint32_t index) {
  std::scoped_lock lock(mutex_);
  if (index >= slots_.size()) {
    ++metrics_.invalid_releases;
    return false;
  }
  auto& slot = slots_[index];
  if ((slot.state != SlotState::Delivered &&
       slot.state != SlotState::Retired) ||
      slot.lease.generation != generation || slot.lease.sequence != sequence) {
    ++metrics_.invalid_releases;
    return false;
  }
  ++metrics_.released;
  const double elapsed =
      std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - slot.delivered_at)
          .count();
  metrics_.release_max_ms = std::max(metrics_.release_max_ms, elapsed);
  release_samples_[(metrics_.released - 1) % release_samples_.size()] = elapsed;
  if (slot.state == SlotState::Retired)
    clear(slot);
  else
    slot.state = SlotState::Free;
  return true;
}
PoolSnapshot SharedTexturePool::snapshot() const {
  std::scoped_lock lock(mutex_);
  auto result = metrics_;
  std::array<std::uint64_t, kSlots> generations{};
  std::size_t generation_count = 0;
  for (const auto& slot : slots_) {
    result.delivered += slot.state == SlotState::Delivered;
    result.retired += slot.state == SlotState::Retired;
    result.quarantined += slot.state == SlotState::Quarantined;
    if (slot.state == SlotState::Delivered ||
        slot.state == SlotState::Retired) {
      result.oldest_age_ms =
          std::max(result.oldest_age_ms,
                   std::chrono::duration<double, std::milli>(
                       std::chrono::steady_clock::now() - slot.delivered_at)
                       .count());
    }
    if (slot.state != SlotState::Free &&
        std::find(active_generations_.begin(), active_generations_.end(),
                  slot.lease.generation) == active_generations_.end() &&
        std::find(generations.begin(), generations.begin() + generation_count,
                  slot.lease.generation) ==
            generations.begin() + generation_count)
      generations[generation_count++] = slot.lease.generation;
  }
  result.retired_generations = static_cast<std::uint32_t>(generation_count);
  if (result.delivered + result.retired + result.quarantined == kSlots)
    result.stalled_ms = result.oldest_age_ms;
  const auto count =
      std::min<std::uint64_t>(metrics_.released, release_samples_.size());
  if (count) {
    auto samples = release_samples_;
    std::sort(samples.begin(), samples.begin() + count);
    result.release_p50_ms = samples[(count + 1) / 2 - 1];
    result.release_p95_ms = samples[(count * 95 + 99) / 100 - 1];
  }
  return result;
}
std::uint64_t SharedTexturePool::generation() const {
  std::scoped_lock lock(mutex_);
  return metrics_.generation;
}
}  // namespace syrnike::windows_media::video
