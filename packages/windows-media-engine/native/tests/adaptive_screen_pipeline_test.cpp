#include "screen/production_screen_pipeline.hpp"
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace syrnike::windows_media;
using namespace syrnike::windows_media::screen;
using namespace std::chrono_literals;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
template <typename Predicate> void until(Predicate predicate) {
  const auto deadline = std::chrono::steady_clock::now() + 10s;
  while (!predicate()) {
    require(std::chrono::steady_clock::now() < deadline, "adaptive integration deadline");
    std::this_thread::sleep_for(1ms);
  }
}
class Adapter final : public ScreenPublicationAdapter {
 public:
  std::mutex mutex;
  ScreenOperationCompletion pending;
  std::uint64_t generation = 0;
  bool unpublish_seen = false;
  OutgoingNetworkObservation networkObservation() const noexcept override { return {}; }
  void startPublish(std::uint64_t g, ScreenTrackDescriptor, ScreenOperationCompletion cb) override {
    std::scoped_lock lock(mutex);
    generation = g; pending = std::move(cb);
  }
  void startSubmit(std::uint64_t g, EncodedScreenFrame, ScreenOperationCompletion cb) override { cb(g, {}); }
  void startUnpublish(std::uint64_t g, ScreenOperationCompletion cb) override {
    { std::scoped_lock lock(mutex); unpublish_seen = true; }
    cb(g, {});
  }
  bool publishReady() { std::scoped_lock lock(mutex); return bool(pending); }
  void complete() {
    ScreenOperationCompletion cb;
    std::uint64_t g;
    { std::scoped_lock lock(mutex); cb = std::move(pending); g = generation; }
    require(bool(cb), "no pending publication"); cb(g, {});
  }
};
void supersededSettingAndDrain() {
  const auto device = capture::processD3d11Device(false);
  auto frames = std::make_shared<ScreenFramePipeline>();
  std::mutex adapters_mutex;
  std::vector<std::shared_ptr<Adapter>> adapters;
  ProductionScreenPipeline pipeline(device, frames, kScreenProfile1080p60,
      [&](std::function<void()>) {
        auto value = std::make_shared<Adapter>();
        std::scoped_lock lock(adapters_mutex); adapters.push_back(value); return value;
      });
  const auto adapterAt = [&](std::size_t index) {
    std::scoped_lock lock(adapters_mutex);
    return adapters.size() > index ? adapters[index] : std::shared_ptr<Adapter>{};
  };
  require(pipeline.enableAdaptiveQuality(31, 4), "enable rejected admitted profiles");
  require(pipeline.start("adaptive-test", 5s).ok, "initial start failed");
  until([&] { return adapterAt(0)->publishReady(); });
  adapterAt(0)->complete();
  until([&] { return pipeline.state() == ProductionScreenPipelineState::running; });
  require(pipeline.setMaximumQuality(2, 3), "first ceiling rejected");
  until([&] { auto a = adapterAt(1); return a && a->publishReady(); });
  require(pipeline.setMaximumQuality(3, 0), "newer ceiling rejected");
  require(!pipeline.setMaximumQuality(2, 4), "stale revision accepted");
  adapterAt(1)->complete();
  until([&] { auto a = adapterAt(2); return a && a->publishReady(); });
  const auto pending = pipeline.stats();
  require(pending.applied_revision == 1 && pending.reconfiguring,
          "late superseded publication became current");
  adapterAt(2)->complete();
  until([&] { return pipeline.stats().applied_revision == 3; });
  require(pipeline.stats().current_profile == 0 && pipeline.stats().profile_generation == 3,
          "replacement did not obey latest ceiling");
  require(pipeline.stop(std::chrono::steady_clock::now() + 5s).ok, "replacement stop failed");
  const auto stopped = pipeline.stats();
  require(stopped.capture.active == 0 && stopped.converter.slots_in_use == 0 &&
          stopped.encoder.input_slots_in_use == 0 && stopped.encoder.output_slots_in_use == 0,
          "replacement retained media leases");
  for (const auto& a : adapters) {
    std::scoped_lock lock(a->mutex); require(a->unpublish_seen, "generation was not unpublished");
  }
}
}
int main() {
  try { supersededSettingAndDrain(); std::cout << "Adaptive sender generation and setting fences passed\n"; }
  catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
