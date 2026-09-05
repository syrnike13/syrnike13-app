#include <chrono>
#include <cstdint>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "capture/monitor_capture.hpp"
#include "screen/cpu_screen_converter.hpp"
#include "screen/screen_frame_pipeline.hpp"

namespace {

using namespace syrnike::windows_media::capture;
using namespace syrnike::windows_media::screen;
using namespace syrnike::windows_media::sources;
using namespace std::chrono_literals;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

class TestResource final : public FrameResource {
 public:
  TestResource(std::uint32_t width, std::uint32_t height, std::uint8_t value)
      : width_(width), height_(height), value_(value) {}

  std::uint64_t sampledHash() override { return value_; }

  void copyBgraTo(std::span<std::uint8_t> destination,
                  std::size_t stride) override {
    require(stride >= width_ * 4ULL && destination.size() >= stride * height_,
            "test readback destination was too small");
    for (std::uint32_t y = 0; y < height_; ++y) {
      for (std::uint32_t x = 0; x < width_; ++x) {
        auto* pixel = destination.data() + y * stride + x * 4ULL;
        pixel[0] = static_cast<std::uint8_t>(value_ + x);
        pixel[1] = static_cast<std::uint8_t>(value_ + y);
        pixel[2] = value_;
        pixel[3] = 255;
      }
    }
  }

 private:
  std::uint32_t width_;
  std::uint32_t height_;
  std::uint8_t value_;
};

class TestEnumerator final : public SourceEnumerator {
 public:
  EnumerationBatch enumerate(const EnumerationOptions&) override {
    EnumerationBatch batch;
    SourceCandidate source;
    source.kind = SourceKind::Monitor;
    source.identity = "screen-test-monitor";
    source.title = "Screen test";
    batch.candidates.push_back(std::move(source));
    return batch;
  }

  ResolveStatus validate(SourceKind, const std::string&) override {
    return ResolveStatus::Available;
  }

  MonitorTargetResult resolveMonitorTarget(const std::string& identity) override {
    return identity == "screen-test-monitor"
               ? MonitorTargetResult{ResolveStatus::Available,
                                     MonitorTargetToken{1, identity}}
               : MonitorTargetResult{ResolveStatus::Unknown, std::nullopt};
  }
};

class TestBackend final : public MonitorCaptureBackend {
 public:
  BackendStartResult start(const MonitorTargetToken&, FrameCallback on_frame,
                           TerminalCallback) override {
    callback = std::move(on_frame);
    return {};
  }

  CaptureStopResult stop(
      std::chrono::steady_clock::time_point) noexcept override {
    return {};
  }

  void emit(std::int64_t timestamp, std::uint32_t width,
            std::uint32_t height, std::uint8_t value) {
    callback(BackendFrame{timestamp, width, height, FramePixelFormat::Bgra8,
                          std::make_shared<TestResource>(width, height, value),
                          1});
  }

  FrameCallback callback;
};

struct TestCapture {
  SourceRegistry registry{std::make_unique<TestEnumerator>()};
  TestBackend* backend = nullptr;
  std::unique_ptr<MonitorCapture> capture;

  TestCapture() {
    const auto sources = registry.enumerate();
    require(sources.sources.size() == 1, "test source enumeration failed");
    auto owned_backend = std::make_unique<TestBackend>();
    backend = owned_backend.get();
    capture = std::make_unique<MonitorCapture>(
        registry, sources.sources.front().id, std::move(owned_backend));
    require(capture->start().ok, "test capture failed to start");
  }

  ~TestCapture() { (void)capture->stop(1s); }

  FrameLease next(std::uint8_t value, std::int64_t timestamp,
                  std::uint32_t width = 4, std::uint32_t height = 4) {
    backend->emit(timestamp, width, height, value);
    auto lease = capture->waitForFrame(10ms);
    require(lease.has_value(), "test frame lease was unavailable");
    return std::move(*lease);
  }
};

std::uint64_t markerBits(const std::vector<std::uint8_t>& frame,
                         std::uint32_t width, std::size_t offset,
                         std::size_t length) {
  std::uint64_t value = 0;
  for (std::size_t bit = offset; bit < offset + length; ++bit) {
    const auto column = bit % kScreenMarkerColumns;
    const auto row = bit / kScreenMarkerColumns;
    const auto x = column * kScreenMarkerTileSize +
                   kScreenMarkerTileSize / 2;
    const auto y = row * kScreenMarkerTileSize +
                   kScreenMarkerTileSize / 2;
    value = (value << 1U) |
            (frame[(y * width + x) * 4ULL] >= 128 ? 1ULL : 0ULL);
  }
  return value;
}

void pipelineLatestWinsAndReleases() {
  TestCapture source;
  ScreenFramePipeline pipeline;
  const auto now = screenSteadyTimestamp100ns();
  require(pipeline.submit(source.next(10, now)), "first frame was rejected");
  require(pipeline.submit(source.next(20, now + 1)),
          "second frame was rejected");
  auto frame = pipeline.waitForFrame(10ms);
  require(frame && frame->metadata().sequence == 2,
          "pipeline did not retain the newest frame");
  frame->release();
  require(pipeline.stop(std::chrono::steady_clock::now() + 1s),
          "pipeline failed to stop");
  const auto stats = pipeline.stats();
  require(stats.submitted == 2 && stats.accepted == 2 && stats.superseded == 1 &&
              stats.dropped == 1 && stats.released == 2 &&
              stats.maximum_depth == kScreenFramePipelineCapacity &&
              stats.pending == 0 && stats.active == 0,
          "pipeline counters violated latest-wins ownership");
}

void pipelineDropsExpiredFrame() {
  TestCapture source;
  ScreenFramePipeline pipeline{20ms};
  const auto old = screenSteadyTimestamp100ns() - 1'000'000;
  require(pipeline.submit(source.next(30, old)), "old frame was not accepted");
  require(!pipeline.waitForFrame(10ms), "old frame escaped the age fence");
  require(pipeline.stop(std::chrono::steady_clock::now() + 1s),
          "expired pipeline failed to stop");
  const auto stats = pipeline.stats();
  require(stats.submitted == 1 && stats.too_old == 1 && stats.dropped == 1 &&
              stats.released == 1,
          "expired frame counters were incorrect");
}

void pipelineRestartsOnlyAfterFullRelease() {
  TestCapture source;
  ScreenFramePipeline pipeline;
  const auto now = screenSteadyTimestamp100ns();
  require(pipeline.submit(source.next(21, now)),
          "restart test frame was rejected");
  auto active = pipeline.waitForFrame(10ms);
  require(active.has_value(), "restart test frame was unavailable");
  require(!pipeline.stop(std::chrono::steady_clock::now()),
          "pipeline stopped while an active lease was retained");
  require(!pipeline.restart(),
          "pipeline restarted while an active lease was retained");
  active->release();
  require(pipeline.stop(std::chrono::steady_clock::now() + 1s),
          "pipeline failed to observe the released lease");
  require(pipeline.restart(), "fully released pipeline did not restart");
  require(pipeline.submit(source.next(22, now + 1)),
          "restarted pipeline rejected a frame");
  auto restarted = pipeline.waitForFrame(10ms);
  require(restarted.has_value(), "restarted pipeline produced no frame");
  restarted->release();
  require(pipeline.stop(std::chrono::steady_clock::now() + 1s),
          "restarted pipeline failed to stop");
  const auto stats = pipeline.stats();
  require(stats.submitted == 2 && stats.released == 2 &&
              stats.pending == 0 && stats.active == 0,
          "pipeline restart violated exact lease accounting");
}

void pipelineDropsInvalidTimestamp() {
  TestCapture source;
  ScreenFramePipeline pipeline{20ms};
  require(pipeline.submit(source.next(31, 0)),
          "invalid-timestamp frame was not accepted by the callback seam");
  require(!pipeline.waitForFrame(10ms),
          "invalid-timestamp frame escaped the publication age fence");
  require(pipeline.stop(std::chrono::steady_clock::now() + 1s),
          "invalid-timestamp pipeline failed to stop");
  const auto stats = pipeline.stats();
  require(stats.submitted == 1 && stats.too_old == 1 && stats.dropped == 1 &&
              stats.released == 1,
          "invalid timestamp did not use the stale-frame release path");
}

void pipelineAllowsSmallCaptureClockSkew() {
  TestCapture source;
  ScreenFramePipeline pipeline{20ms};
  const auto slightly_future = screenSteadyTimestamp100ns() + 100'000;
  require(pipeline.submit(source.next(32, slightly_future)),
          "small capture clock skew was rejected at the callback seam");
  auto frame = pipeline.waitForFrame(10ms);
  require(frame.has_value(), "small capture clock skew was treated as stale");
  frame->release();
  require(pipeline.stop(std::chrono::steady_clock::now() + 1s),
          "clock-skew pipeline failed to stop");
}

void converterReusesBuffersAndWritesMarker() {
  TestCapture source;
  ScreenFramePipeline pipeline;
  CpuScreenConverter converter;
  constexpr std::uint32_t output_width = 640;
  constexpr std::uint32_t output_height = 360;
  std::vector<std::uint8_t> output(output_width * output_height * 4ULL);

  const auto now = screenSteadyTimestamp100ns();
  require(pipeline.submit(source.next(40, now)), "converter frame rejected");
  auto first = pipeline.waitForFrame(10ms);
  require(first.has_value(), "converter frame unavailable");
  const auto first_result = converter.convert(*first, output, output_width,
                                               output_height);
  require(markerBits(output, output_width, 0, 16) == kScreenMarkerMagic &&
              markerBits(output, output_width, 16, 32) ==
                  first_result.source.sequence &&
              markerBits(output, output_width, 96, 16) == 1 &&
              markerBits(output, output_width, 112, 16) == 4 &&
              markerBits(output, output_width, 128, 16) == 4,
          "screen marker did not preserve frame metadata");
  first->release();

  require(pipeline.submit(source.next(50, now + 1)),
          "second converter frame rejected");
  auto second = pipeline.waitForFrame(10ms);
  require(second.has_value(), "second converter frame unavailable");
  (void)converter.convert(*second, output, output_width, output_height);
  second->release();
  require(converter.stats().buffer_reconfigurations == 1,
          "converter allocated again for an unchanged generation");
  require(pipeline.stop(std::chrono::steady_clock::now() + 1s),
          "converter pipeline failed to stop");
}

}  // namespace

int main() try {
  pipelineLatestWinsAndReleases();
  pipelineRestartsOnlyAfterFullRelease();
  pipelineDropsExpiredFrame();
  pipelineDropsInvalidTimestamp();
  pipelineAllowsSmallCaptureClockSkew();
  converterReusesBuffersAndWritesMarker();
  std::cout << "screen-reference-tests:ok\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
