#include <mfapi.h>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <thread>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"

// Compile the real encoder in this test translation unit so fault injection
// does not add runtime switches to the shipping utility.
#define private public
#include "screen/hardware_h264_encoder.hpp"
#undef private

std::mutex shutdown_mutex;
std::condition_variable shutdown_changed;
bool block_shutdown = false;
bool shutdown_entered = false;
HRESULT testMFShutdown() {
  {
    std::unique_lock lock(shutdown_mutex);
    shutdown_entered = true;
    shutdown_changed.notify_all();
    shutdown_changed.wait(lock, [] { return !block_shutdown; });
  }
  return MFShutdown();
}
#define MFShutdown testMFShutdown
#include "screen/hardware_h264_encoder.cpp"
#undef MFShutdown
#include "screen/production_screen_pipeline.hpp"

using namespace syrnike::windows_media::screen;
using namespace std::chrono_literals;

class FaultTestAdapter final : public ScreenPublicationAdapter {
 public:
  std::atomic<bool> unpublished = false;
  void startPublish(std::uint64_t g, ScreenTrackDescriptor,
                    ScreenOperationCompletion cb) override { cb(g, {}); }
  void startSubmit(std::uint64_t g, EncodedScreenFrame,
                   ScreenOperationCompletion cb) override { cb(g, {}); }
  void startUnpublish(std::uint64_t g,
                      ScreenOperationCompletion cb) override {
    unpublished = true;
    cb(g, {});
  }
};

void pipelinePropagatesEncoderFailure() {
  auto device = syrnike::windows_media::capture::processD3d11Device(false);
  auto frames = std::make_shared<ScreenFramePipeline>();
  auto adapter = std::make_shared<FaultTestAdapter>();
  std::shared_ptr<HardwareH264Encoder> encoder;
  ProductionScreenPipeline pipeline(device, frames, kScreenProfile720p30,
      [&](const auto& value) { encoder = value; return adapter; });
  if (!pipeline.start("fault-test", 5s).ok) throw std::runtime_error("start failed");
  fail(encoder->state_, "screen_hardware_h264_output_stalled", "injected stall",
       "encoder_output");
  const auto deadline = std::chrono::steady_clock::now() + 1s;
  while (!adapter->unpublished && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(1ms);
  if (!adapter->unpublished || pipeline.state() != ProductionScreenPipelineState::failed ||
      !pipeline.failure() || pipeline.failure()->code != "screen_hardware_h264_output_stalled")
    throw std::runtime_error("encoder failure did not terminate publication");
  (void)pipeline.stop(std::chrono::steady_clock::now() + 5s);
}

void shutdownDeadlineIncludesMediaFoundationCleanup() {
  auto device = syrnike::windows_media::capture::processD3d11Device(false);
  HardwareH264Encoder encoder(device, kScreenProfile720p30);
  if (encoder.start(5s)) throw std::runtime_error("start failed");
  {
    std::scoped_lock lock(shutdown_mutex);
    block_shutdown = true;
    shutdown_entered = false;
  }
  fail(encoder.state_, "injected_failure", "injected failure", "encoder_output");
  bool entered;
  {
    std::unique_lock lock(shutdown_mutex);
    entered = shutdown_changed.wait_for(lock, 5s, [] { return shutdown_entered; });
  }
  const auto started = std::chrono::steady_clock::now();
  const bool stopped = encoder.stop(30ms);
  const auto elapsed = std::chrono::steady_clock::now() - started;
  {
    std::scoped_lock lock(shutdown_mutex);
    block_shutdown = false;
  }
  shutdown_changed.notify_all();
  (void)encoder.stop(5s);
  if (!entered || stopped || elapsed > 500ms)
    throw std::runtime_error("stop joined a worker still inside MFShutdown");
}

int main() try {
  pipelinePropagatesEncoderFailure();
  shutdownDeadlineIncludesMediaFoundationCleanup();
  std::cout << "encoder fault tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
