#include "screen/local_screen_preview.hpp"

#include <dxgi1_2.h>
#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::screen {
namespace {
using Microsoft::WRL::ComPtr;
// 256-byte rows and 64KiB allocation alignment, as in remote receive.
constexpr std::uint64_t kTextureBytes = (1280ULL * 4 * 720 + 65535) & ~65535ULL;
void check(HRESULT result) {
  if (FAILED(result)) throw std::runtime_error("preview_d3d_failure");
}
}
const char* previewStateName(PreviewState state) noexcept {
  switch (state) {
    case PreviewState::off: return "off";
    case PreviewState::starting: return "starting";
    case PreviewState::running: return "running";
    case PreviewState::degraded: return "degraded";
    case PreviewState::stopped: return "stopped";
  }
  return "degraded";
}
LocalScreenPreview& LocalScreenPreview::processPreview() {
  static LocalScreenPreview preview;
  return preview;
}
LocalScreenPreview::~LocalScreenPreview() {
  for (auto& slot : slots_) clearLocked(slot);
}
void LocalScreenPreview::clearLocked(Slot& slot) {
  if (slot.frame.handle) CloseHandle(reinterpret_cast<HANDLE>(slot.frame.handle));
  if (slot.texture) stats_.backing_bytes -= kTextureBytes;
  slot = {};
}
void LocalScreenPreview::allocateLocked() {
  if (!stats_.desired || !stats_.publication_active) return;
  if (!device_) {
    try { device_ = capture::processD3d11Device(false); }
    catch (...) { ++stats_.failures; stats_.state = PreviewState::degraded; return; }
  }
  for (auto& slot : slots_) {
    if (slot.texture || slot.state != SlotState::free) continue;
    if (stats_.process_budget < kPublicationReserve + kRemoteReserve +
                                    stats_.backing_bytes + kTextureBytes) return;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = 1280; desc.Height = 720; desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
                     D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    try {
      check(device_->device()->CreateTexture2D(&desc, nullptr, &slot.texture));
      stats_.backing_bytes += kTextureBytes;
      ComPtr<IDXGIResource1> resource;
      check(slot.texture.As(&resource));
      HANDLE handle = nullptr;
      check(resource->CreateSharedHandle(nullptr,
          DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &handle));
      slot.frame.handle = reinterpret_cast<std::uintptr_t>(handle);
      check(slot.texture.As(&slot.keyed));
      D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
      check(device_->device()->CreateQuery(&query, &slot.query));
    } catch (...) {
      clearLocked(slot);
      ++stats_.failures;
      stats_.state = PreviewState::degraded;
      return;
    }
  }
}
bool LocalScreenPreview::beginPublication(std::uint64_t generation) {
  std::lock_guard lock(mutex_);
  if (!generation || stats_.publication_active) return false;
  if (!stats_.process_budget) stats_.process_budget = kProcessBudget;
  publication_generation_ = generation;
  stats_.publication_active = true;
  ++stats_.generation;
  stats_.state = stats_.desired ? PreviewState::starting : PreviewState::off;
  allocateLocked();
  return true;
}
void LocalScreenPreview::retireLocked() {
  ++stats_.generation;
  for (auto& slot : slots_) {
    switch (slot.state) {
      case SlotState::free: case SlotState::ready: clearLocked(slot); break;
      case SlotState::copying: slot.state = SlotState::retiring; break;
      case SlotState::delivered: slot.state = SlotState::retired; break;
      default: break;
    }
  }
}
void LocalScreenPreview::stopPublication() {
  std::lock_guard lock(mutex_);
  if (!stats_.publication_active) return;
  stats_.publication_active = false;
  retireLocked();
  stats_.state = PreviewState::stopped;
}
bool LocalScreenPreview::demand(std::uint64_t revision, bool enabled) {
  std::lock_guard lock(mutex_);
  if (revision <= stats_.revision) return false;
  stats_.revision = revision;
  if (stats_.desired == enabled) return true;
  stats_.desired = enabled;
  retireLocked();
  stats_.state = enabled ? (stats_.publication_active ? PreviewState::starting
                                                    : PreviewState::stopped)
                         : PreviewState::off;
  allocateLocked();
  return true;
}
bool LocalScreenPreview::setProcessBudget(std::uint64_t bytes) {
  std::lock_guard lock(mutex_);
  // A pressure signal cannot revoke an already exported lease. It changes
  // admission immediately, while its backing stays counted until safe release.
  if (bytes < kPublicationReserve + kRemoteReserve || bytes > kProcessBudget)
    return false;
  stats_.process_budget = bytes;
  retireLocked();
  allocateLocked();
  return true;
}
void LocalScreenPreview::offer(const capture::D3d11FrameView& frame,
                               const capture::FrameMetadata& metadata) noexcept {
  const auto started = std::chrono::steady_clock::now();
  std::unique_lock lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) { ++contention_drops_; return; }
  if (!stats_.desired || !stats_.publication_active) return;
  if (stats_.process_budget < kPublicationReserve + kRemoteReserve + kTextureBytes) {
    ++stats_.pressure_drops; stats_.state = PreviewState::degraded; return;
  }
  if (!frame || frame.device_owner != device_ || metadata.width < 2 ||
      metadata.height < 2 || metadata.width > 3840 || metadata.height > 2160) {
    ++stats_.failures; stats_.state = PreviewState::degraded; return;
  }
  auto found = std::find_if(slots_.begin(), slots_.end(), [](const auto& slot) {
    return slot.texture && slot.state == SlotState::free;
  });
  if (found == slots_.end()) { ++stats_.pool_drops; stats_.state = PreviewState::degraded; return; }
  std::unique_lock context(device_->contextMutex(), std::try_to_lock);
  if (!context.owns_lock()) { ++contention_drops_; return; }
  auto& slot = *found;
  bool acquired = false;
  try {
    const auto acquire_result = slot.keyed->AcquireSync(0, 0);
    if (acquire_result != S_OK) {
      stats_.last_gpu_result = static_cast<std::uint32_t>(acquire_result);
      slot.state = SlotState::quarantined;
      ++stats_.failures; stats_.state = PreviewState::degraded; return;
    }
    acquired = true;
    auto& video_device = video_device_;
    auto& video_context = video_context_;
    if (!video_device) check(device_->device()->QueryInterface(IID_PPV_ARGS(&video_device)));
    if (!video_context) check(device_->context()->QueryInterface(IID_PPV_ARGS(&video_context)));
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = metadata.width; content.InputHeight = metadata.height;
    content.OutputWidth = 1280; content.OutputHeight = 720;
    content.InputFrameRate = {60, 1}; content.OutputFrameRate = {60, 1};
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    if (!processor_ || input_width_ != metadata.width || input_height_ != metadata.height) {
      ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
      ComPtr<ID3D11VideoProcessor> processor;
      check(video_device->CreateVideoProcessorEnumerator(&content, &enumerator));
      check(video_device->CreateVideoProcessor(enumerator.Get(), 0, &processor));
      enumerator_ = std::move(enumerator); processor_ = std::move(processor);
      input_width_ = metadata.width; input_height_ = metadata.height;
    }
    auto& enumerator = enumerator_;
    auto& processor = processor_;
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input_desc{};
    input_desc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11VideoProcessorInputView> input;
    check(video_device->CreateVideoProcessorInputView(frame.texture, enumerator.Get(), &input_desc, &input));
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output_desc{};
    output_desc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11VideoProcessorOutputView> output;
    check(video_device->CreateVideoProcessorOutputView(slot.texture.Get(), enumerator.Get(), &output_desc, &output));
    const RECT source{0, 0, static_cast<LONG>(metadata.width), static_cast<LONG>(metadata.height)};
    const RECT destination{0, 0, 1280, 720};
    video_context->VideoProcessorSetStreamSourceRect(processor.Get(), 0, TRUE, &source);
    video_context->VideoProcessorSetStreamDestRect(processor.Get(), 0, TRUE, &destination);
    video_context->VideoProcessorSetOutputTargetRect(processor.Get(), TRUE, &destination);
    D3D11_VIDEO_PROCESSOR_STREAM stream{};
    stream.Enable = TRUE; stream.pInputSurface = input.Get();
    check(video_context->VideoProcessorBlt(processor.Get(), output.Get(), 0, 1, &stream));
    device_->context()->End(slot.query.Get());
    check(slot.keyed->ReleaseSync(0));
    acquired = false;
    device_->context()->Flush();
    // End device ownership on this producer call. Export still requires the
    // later event-query completion, so no renderer can race this GPU write.
    slot.frame.generation = stats_.generation;
    slot.frame.revision = stats_.revision;
    slot.frame.sequence = ++sequence_;
    slot.frame.publication_generation = publication_generation_;
    slot.frame.source_generation = metadata.generation;
    slot.frame.timestamp_us = metadata.capture_timestamp_100ns / 10;
    slot.frame.slot = static_cast<std::uint32_t>(found - slots_.begin());
    slot.submitted = started;
    slot.state = SlotState::copying;
    ++stats_.accepted;
  } catch (...) {
    if (acquired) (void)slot.keyed->ReleaseSync(0);
    slot.state = SlotState::quarantined;
    ++stats_.failures;
    stats_.state = PreviewState::degraded;
  }
  stats_.offer_max_us = (std::max)(stats_.offer_max_us,
      static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now() - started).count()));
}
void LocalScreenPreview::pollLocked() {
  if (!device_) return;
  std::unique_lock context(device_->contextMutex(), std::try_to_lock);
  if (!context.owns_lock()) return;
  for (auto& slot : slots_) {
    if (slot.state != SlotState::copying && slot.state != SlotState::retiring) continue;
    // Allow GetData to submit pending driver work after the producer stops.
    // DONOTFLUSH can strand the final query once capture/encoder cease issuing
    // commands. This call polls once and never waits for GPU completion.
    const auto result = device_->context()->GetData(slot.query.Get(), nullptr, 0, 0);
    const auto age = std::chrono::steady_clock::now() - slot.submitted;
    if (result == S_FALSE && age < std::chrono::milliseconds(200)) continue;
    const bool retired = slot.state == SlotState::retiring;
    if (result != S_OK) {
      stats_.last_gpu_result = static_cast<std::uint32_t>(result);
      stats_.failure_age_us = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(age).count());
      slot.state = SlotState::quarantined;
      ++stats_.failures; stats_.state = PreviewState::degraded;
      continue;
    }
    stats_.gpu_max_us = (std::max)(stats_.gpu_max_us,
        static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(age).count()));
    if (retired) clearLocked(slot);
    else if (age > std::chrono::milliseconds(250)) {
      slot.state = SlotState::free; ++stats_.superseded;
    } else slot.state = SlotState::ready;
  }
}
std::optional<PreviewFrame> LocalScreenPreview::takeFrame() {
  std::lock_guard lock(mutex_);
  pollLocked();
  allocateLocked();
  Slot* newest = nullptr;
  for (auto& slot : slots_) {
    if (slot.state != SlotState::ready) continue;
    if (!newest || slot.frame.sequence > newest->frame.sequence) newest = &slot;
  }
  if (!newest) return {};
  for (auto& slot : slots_) {
    if (&slot != newest && slot.state == SlotState::ready) {
      slot.state = SlotState::free; ++stats_.superseded;
    }
  }
  newest->state = SlotState::delivered;
  ++stats_.delivered;
  stats_.state = PreviewState::running;
  return newest->frame;
}
bool LocalScreenPreview::release(std::uint64_t generation, std::uint64_t sequence,
                                 std::uint32_t index) {
  std::lock_guard lock(mutex_);
  if (index >= slots_.size()) { ++stats_.invalid_releases; return false; }
  auto& slot = slots_[index];
  if ((slot.state != SlotState::delivered && slot.state != SlotState::retired) ||
      slot.frame.generation != generation || slot.frame.sequence != sequence) {
    ++stats_.invalid_releases; return false;
  }
  ++stats_.released;
  if (slot.state == SlotState::retired) clearLocked(slot);
  else slot.state = SlotState::free;
  return true;
}
PreviewStats LocalScreenPreview::stats() const {
  std::lock_guard lock(mutex_);
  auto result = stats_;
  result.pool_drops += contention_drops_.load();
  for (const auto& slot : slots_) {
    result.outstanding += slot.state == SlotState::delivered || slot.state == SlotState::retired;
    result.pending += slot.state == SlotState::copying || slot.state == SlotState::retiring;
    result.quarantined += slot.state == SlotState::quarantined;
  }
  return result;
}
}  // namespace syrnike::windows_media::screen
