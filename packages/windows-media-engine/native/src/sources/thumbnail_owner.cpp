#include "sources/thumbnail_owner.hpp"

#include "capture/optional_preview_budget.hpp"
#include "capture/wgc_monitor_capture.hpp"
#include "capture/wgc_window_capture.hpp"

#include <d3d11_1.h>
#include <cstring>
#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::sources {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
using Microsoft::WRL::ComPtr;
constexpr std::uint64_t kStagingBytes = 262144;
void check(HRESULT result) {
  if (result != S_OK) throw std::runtime_error("thumbnail_readback_failed");
}

// The same asynchronous texture readback used by the neutral preview observer:
// copy -> release GPU key -> poll completion -> nonblocking Map -> return lease.
// Only the fixed thumbnail is mapped. Full capture pixels never enter JS.
std::shared_ptr<const std::vector<std::uint8_t>> readPixels(
    screen::LocalScreenPreview& preview, const screen::PreviewFrame& frame,
    const std::function<bool()>& current) {
  if (!capture::reserveOptionalPreview(kStagingBytes)) throw std::runtime_error("thumbnail_capacity");
  bool completion_proven = true;
  try {
    const auto device = capture::processD3d11Device(false);
    ComPtr<ID3D11Device1> device1;
    check(device->device()->QueryInterface(IID_PPV_ARGS(&device1)));
    ComPtr<ID3D11Texture2D> shared, staging;
    ComPtr<IDXGIKeyedMutex> keyed;
    ComPtr<ID3D11Query> completion;
    auto pixels = std::make_shared<std::vector<std::uint8_t>>(kThumbnailBytes);
    check(device1->OpenSharedResource1(reinterpret_cast<HANDLE>(frame.handle), IID_PPV_ARGS(&shared)));
    check(shared.As(&keyed));
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = kThumbnailWidth; desc.Height = kThumbnailHeight;
    desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    check(device->device()->CreateTexture2D(&desc, nullptr, &staging));
    const D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
    check(device->device()->CreateQuery(&query, &completion));
    bool submitted = false;
    const auto deadline = Clock::now() + 200ms;
    while (Clock::now() < deadline) {
      // Once submitted, cancellation still drains the one consumer GPU copy.
      if (!submitted && !current()) throw std::runtime_error("thumbnail_cancelled");
      std::unique_lock context(device->contextMutex(), std::try_to_lock);
      if (!context.owns_lock()) { std::this_thread::sleep_for(1ms); continue; }
      if (!submitted) {
        const auto acquired = keyed->AcquireSync(0, 0);
        if (acquired == WAIT_TIMEOUT) { context.unlock(); std::this_thread::sleep_for(1ms); continue; }
        check(acquired);
        completion_proven = false;
        device->context()->CopyResource(staging.Get(), shared.Get());
        device->context()->End(completion.Get());
        check(keyed->ReleaseSync(0));
        device->context()->Flush();
        submitted = true;
      }
      const auto completed = device->context()->GetData(completion.Get(), nullptr, 0, 0);
      if (completed == S_FALSE) { context.unlock(); std::this_thread::sleep_for(1ms); continue; }
      check(completed);
      completion_proven = true;
      D3D11_MAPPED_SUBRESOURCE mapped{};
      const auto mapped_result = device->context()->Map(staging.Get(), 0, D3D11_MAP_READ,
          D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
      if (mapped_result == DXGI_ERROR_WAS_STILL_DRAWING) { context.unlock(); std::this_thread::sleep_for(1ms); continue; }
      check(mapped_result);
      const auto* source = static_cast<const std::uint8_t*>(mapped.pData);
      for (std::uint32_t row = 0; row < kThumbnailHeight; ++row)
        std::memcpy(pixels->data() + row * kThumbnailWidth * 4,
            source + row * mapped.RowPitch, kThumbnailWidth * 4);
      for (std::size_t alpha = 3; alpha < pixels->size(); alpha += 4) (*pixels)[alpha] = 255;
      device->context()->Unmap(staging.Get(), 0);
      context.unlock();
      if (!preview.release(frame.generation, frame.sequence, frame.slot))
        throw std::runtime_error("thumbnail_release_failed");
      capture::releaseOptionalPreview(kStagingBytes);
      return pixels;
    }
    throw std::runtime_error("thumbnail_gpu_deadline");
  } catch (...) {
    if (completion_proven) {
      (void)preview.release(frame.generation, frame.sequence, frame.slot);
      capture::releaseOptionalPreview(kStagingBytes);
    }
    // An unproved GPU read keeps both staging and preview budget quarantined.
    throw;
  }
}
}  // namespace

ThumbnailOwner::ThumbnailOwner(screen::ScreenOwner& sources, capture::ThumbnailAdmission& admission)
    : sources_(sources), admission_(admission), worker_([this] { run(); }) {}
ThumbnailOwner::~ThumbnailOwner() { stop(); }
ThumbnailSnapshot ThumbnailOwner::query(std::uint64_t revision, std::optional<std::string> source_id) {
  std::lock_guard lock(mutex_);
  if (!stopping_ && revision > request_.revision) {
    request_ = {revision, std::move(source_id), Clock::now() + kThumbnailDeadline};
    snapshot_ = {revision, request_.source_id ? ThumbnailState::pending : ThumbnailState::cancelled};
    changed_.notify_all();
  }
  if (snapshot_.state == ThumbnailState::pending && Clock::now() >= request_.deadline)
    snapshot_ = {request_.revision, ThumbnailState::failed, "thumbnail_deadline"};
  return snapshot_;
}
bool ThumbnailOwner::current(const Request& request) const {
  std::lock_guard lock(mutex_);
  return !stopping_ && request_.revision == request.revision &&
      Clock::now() < request.deadline && !admission_.publicationRequested();
}
ThumbnailStats ThumbnailOwner::stats() const {
  std::lock_guard lock(mutex_);
  return stats_;
}
void ThumbnailOwner::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  changed_.notify_all();
}
void ThumbnailOwner::stop() {
  std::lock_guard join(join_mutex_);
  beginStop();
  {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
ThumbnailSnapshot ThumbnailOwner::capture(const Request& request) {
  ThumbnailSnapshot result{request.revision, ThumbnailState::failed, "thumbnail_unavailable"};
  auto registry = sources_.sourceRegistry();
  if (!registry || !request.source_id || !current(request)) return result;
  const auto source = registry->resolve(*request.source_id);
  if (source.status != ResolveStatus::Available || !source.kind) return result;
  std::unique_ptr<capture::MonitorCapture> monitor;
  std::unique_ptr<capture::WindowCapture> window;
  screen::LocalScreenPreview preview(kThumbnailWidth, kThumbnailHeight);
  try {
    capture::CaptureStartResult started;
    if (*source.kind == SourceKind::Monitor) {
      capture::WgcMonitorCaptureOptions options;
      options.request_d3d_debug_layer = false;
      options.maximum_width = 3840; options.maximum_height = 2160; options.frame_pool_size = 1;
      monitor = std::make_unique<capture::MonitorCapture>(*registry, *request.source_id,
          capture::createWgcMonitorCaptureBackend(options));
      started = monitor->start();
    } else {
      capture::WgcWindowCaptureOptions options;
      options.request_d3d_debug_layer = false;
      options.include_cursor = false;
      options.maximum_width = 3840; options.maximum_height = 2160; options.frame_pool_size = 1;
      window = std::make_unique<capture::WindowCapture>(*registry, *request.source_id,
          capture::createWgcWindowCaptureBackend(options));
      started = window->start();
    }
    if (!started.ok) throw std::runtime_error("thumbnail_capture_failed");
    (void)preview.beginPublication(request.revision);
    (void)preview.demand(request.revision, true);
    bool submitted = false;
    while (current(request)) {
      if (!submitted) {
        auto frame = monitor ? monitor->waitForFrame(10ms) : window->waitForFrame(10ms);
        if (frame) {
          if (const auto view = frame->d3d11View()) preview.offer(*view, frame->metadata());
          frame->release();
          submitted = preview.stats().accepted != 0;
        }
      }
      if (const auto frame = preview.takeFrame()) {
        result.pixels = readPixels(preview, *frame, [&] { return current(request); });
        result.state = ThumbnailState::ready;
        result.code.clear();
        break;
      }
      std::this_thread::sleep_for(1ms);
    }
    if (result.state != ThumbnailState::ready) result.code = "thumbnail_deadline";
  } catch (...) { result.code = "thumbnail_failed"; }
  (void)preview.demand(request.revision + 1, false);
  preview.stopPublication();
  if (monitor && !monitor->stop(kShutdownDeadline).ok) std::terminate();
  if (window && !window->stop(kShutdownDeadline).ok) std::terminate();
  const auto drain_deadline = Clock::now() + 200ms;
  while (preview.stats().pending && Clock::now() < drain_deadline) {
    (void)preview.takeFrame();
    std::this_thread::sleep_for(1ms);
  }
  return result;
}
void ThumbnailOwner::run() noexcept {
  std::uint64_t applied = 0;
  for (;;) {
    Request request;
    {
      std::unique_lock lock(mutex_);
      changed_.wait(lock, [&] { return stopping_ || request_.revision != applied; });
      if (stopping_) break;
      request = request_;
    }
    ThumbnailSnapshot result{request.revision, ThumbnailState::cancelled};
    if (request.source_id) {
      result = {request.revision, ThumbnailState::failed, "thumbnail_capture_busy"};
      if (admission_.acquireThumbnail()) {
        {
          std::lock_guard lock(mutex_);
          ++stats_.admitted;
          ++stats_.active;
          stats_.peak_active = (std::max)(stats_.peak_active, stats_.active);
        }
        try { result = capture(request); }
        catch (...) { result = {request.revision, ThumbnailState::failed, "thumbnail_failed"}; }
        admission_.releaseThumbnail();
        {
          std::lock_guard lock(mutex_);
          --stats_.active;
          if (request_.revision != request.revision || admission_.publicationRequested()) ++stats_.cancelled;
          else if (result.state == ThumbnailState::ready) ++stats_.ready;
          else ++stats_.failed;
        }
      }
    }
    {
      std::lock_guard lock(mutex_);
      if (!stopping_ && request_.revision == request.revision && Clock::now() < request.deadline)
        snapshot_ = std::move(result);
    }
    applied = request.revision;
  }
  {
    std::lock_guard lock(mutex_);
    snapshot_ = {};
    done_ = true;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::sources
