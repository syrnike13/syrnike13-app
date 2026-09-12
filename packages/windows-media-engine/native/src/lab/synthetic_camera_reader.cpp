#include "lab/synthetic_camera_reader.hpp"

#include <windows.h>
#include <algorithm>
#include <condition_variable>
#include <mutex>
#include <stdexcept>

namespace syrnike::windows_media::lab {
namespace {
using namespace camera;
using Clock = std::chrono::steady_clock;
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
class SyntheticSample final : public CameraSample {
 public:
  SyntheticSample(CameraProfile profile, std::uint64_t sequence, std::uint64_t generation,
                  std::shared_ptr<SyntheticCameraControl> control)
      : profile_(profile), sequence_(sequence), control_(std::move(control)), generation_(generation),
        captured_ms_(static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count())) { ++control_->samples_alive; }
  ~SyntheticSample() override { --control_->samples_alive; }
  bool copyBgra(std::span<std::uint8_t> output) override {
    if (const auto delay = control_->copy_delay_ms.exchange(0); delay)
      std::this_thread::sleep_for(std::chrono::milliseconds{delay});
    const auto required = cameraBgraBytes(profile_.width, profile_.height);
    if (output.size() < required) return false;

    // Keep the fixture's metadata bands, but fill the bulk of the frame with
    // one operation. The old per-pixel checkerboard made the synthetic reader
    // spend seconds copying a 720p frame on a busy hosted runner, causing its
    // fresh-frame proof to time out before fault injection. This changes only
    // test-fixture pixels; production conversion and freshness budgets remain
    // unchanged.
    for (std::uint32_t row = 0; row < profile_.height; ++row) {
      const auto row_begin = output.begin() + static_cast<std::size_t>(row) * profile_.width * 4;
      const auto row_bytes = static_cast<std::size_t>(profile_.width) * 4;
      std::fill(row_begin, row_begin + row_bytes, control_->color);
      for (std::size_t alpha = 3; alpha < row_bytes; alpha += 4) row_begin[alpha] = 255;
      if (row >= 96) continue;
      for (std::uint32_t column = 16; column < 528 && column < profile_.width; ++column) {
        const auto offset = static_cast<std::size_t>(column) * 4;
        const auto bits = row < 48 ? sequence_ : row < 64 ? generation_ : captured_ms_;
        const auto light = static_cast<std::uint8_t>(
            (bits & (std::uint64_t{1} << ((column - 16) / 16))) ? 235 : 16);
        row_begin[offset] = light;
        row_begin[offset + 1] = light;
        row_begin[offset + 2] = light;
        row_begin[offset + 3] = 255;
      }
    }
    return true;
  }
 private:
  CameraProfile profile_;
  std::uint64_t sequence_;
  std::shared_ptr<SyntheticCameraControl> control_;
  std::uint64_t generation_, captured_ms_;
};
class SyntheticReader final : public CameraReader {
 public:
  explicit SyntheticReader(std::shared_ptr<SyntheticCameraControl> control) : control_(std::move(control)) {
    if (!event_) throw std::runtime_error("Synthetic camera event creation failed");
  }
  ~SyntheticReader() override {
    if (!close(Clock::now() + std::chrono::seconds{2})) std::terminate();
    CloseHandle(event_);
  }
  CameraOpenResult open(const CameraEndpoint&, CameraProfile requested, bool allow_downgrade) override {
    if (opened_) return {CameraFailure::invalid_state};
    if (control_->fail_open) return {CameraFailure::unavailable};
    profile_ = requested;
    if (requested.width == 1920 && !control_->supports_1080) {
      if (!allow_downgrade) return {CameraFailure::unsupported_profile};
      profile_ = {1280, 720, 30};
    }
    opened_ = true;
    generation_ = ++control_->opens;
    const auto live = ++control_->readers_alive;
    auto maximum = control_->maximum_readers.load();
    while (maximum < live && !control_->maximum_readers.compare_exchange_weak(maximum, live)) {}
    try { worker_ = std::thread([this] { run(); }); }
    catch (...) { --control_->readers_alive; ++control_->closes; throw; }
    return {CameraFailure::none, profile_, profile_ != requested};
  }
  void* eventHandle() const noexcept override { return event_; }
  CameraFailure requestSample() override {
    std::scoped_lock lock(mutex_);
    if (!opened_ || closing_ || requested_ || completed_) return CameraFailure::invalid_state;
    requested_ = true;
    changed_.notify_all();
    return CameraFailure::none;
  }
  std::optional<CameraReadEvent> takeCompleted() override {
    std::scoped_lock lock(mutex_);
    auto result = std::move(completed_);
    completed_.reset();
    ResetEvent(event_);
    return result;
  }
  bool close(Clock::time_point deadline) noexcept override {
    {
      std::unique_lock lock(mutex_);
      closing_ = true;
      changed_.notify_all();
      if (worker_.joinable() && !changed_.wait_until(lock, deadline, [&] { return done_; })) return false;
    }
    if (worker_.joinable()) {
      worker_.join();
      --control_->readers_alive;
      ++control_->closes;
    }
    completed_.reset();
    return true;
  }
 private:
  void run() noexcept {
    try {
      auto next = Clock::now();
      std::uint64_t sequence = 0;
      std::unique_lock lock(mutex_);
      while (!closing_) {
        changed_.wait(lock, [&] { return closing_ || requested_; });
        if (closing_) break;
        if (control_->withhold_samples) {
          {
            std::lock_guard fault_lock(control_->fault_mutex);
            ++control_->withheld_samples;
          }
          control_->fault_changed.notify_all();
          changed_.wait(lock, [&] { return closing_; });
          break;
        }
        next = (std::max)(next + std::chrono::microseconds{33'333}, Clock::now());
        next += std::chrono::milliseconds{control_->delay_ms.exchange(0)};
        if (changed_.wait_until(lock, next, [&] { return closing_; })) break;
        CameraReadEvent event;
        event.failure = control_->next_failure.exchange(CameraFailure::none);
        event.received_100ns = timestamp();
        if (event.failure == CameraFailure::none)
          event.sample = std::make_unique<SyntheticSample>(profile_, ++sequence, generation_, control_);
        requested_ = false;
        completed_ = std::move(event);
        ++control_->callbacks;
        SetEvent(event_);
      }
      if (control_->emit_late_callback) {
        // A callback attempted after close is explicitly observed and fenced.
        auto late_sample = std::make_unique<SyntheticSample>(profile_, ++sequence, generation_, control_);
        ++control_->late_callbacks;
      }
      done_ = true;
      changed_.notify_all();
    } catch (...) {
      std::scoped_lock lock(mutex_);
      completed_ = CameraReadEvent{CameraFailure::source_error, 0, 0, {}};
      done_ = true;
      SetEvent(event_);
      changed_.notify_all();
    }
  }
  std::shared_ptr<SyntheticCameraControl> control_;
  HANDLE event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  CameraProfile profile_;
  std::uint64_t generation_ = 0;
  std::mutex mutex_;
  std::condition_variable changed_;
  bool opened_ = false, requested_ = false, closing_ = false, done_ = false;
  std::optional<CameraReadEvent> completed_;
  std::thread worker_;
};
}  // namespace
camera::CameraReaderFactory syntheticCameraReader(std::shared_ptr<SyntheticCameraControl> control) {
  if (!control) throw std::invalid_argument("Synthetic camera control is required");
  return [control = std::move(control)] { return std::make_unique<SyntheticReader>(control); };
}
}  // namespace syrnike::windows_media::lab
