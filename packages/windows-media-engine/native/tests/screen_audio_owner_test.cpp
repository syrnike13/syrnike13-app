#include "audio/screen_audio_owner.hpp"
#include <barrier>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace syrnike::windows_media::audio;
using namespace std::chrono_literals;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
template <class Predicate>
void until(Predicate predicate) {
  const auto end = std::chrono::steady_clock::now() + 3s;
  while (!predicate()) {
    require(std::chrono::steady_clock::now() < end, "Audio owner test deadline");
    std::this_thread::sleep_for(1ms);
  }
}
struct Gate {
  std::mutex mutex;
  std::condition_variable changed;
  bool release = false;
  unsigned starts = 0, stops = 0;
  std::optional<ScreenAudioFailure> failure;
  std::vector<ScreenAudioMode> modes;
};
class Session final : public ScreenAudioSession {
 public:
  explicit Session(std::shared_ptr<Gate> gate) : gate_(std::move(gate)) {}
  std::optional<ScreenAudioFailure> start(const ScreenAudioIntent& intent) override {
    std::unique_lock lock(gate_->mutex);
    ++gate_->starts;
    gate_->modes.push_back(intent.mode);
    gate_->changed.notify_all();
    require(gate_->changed.wait_for(lock, 2s, [&] { return gate_->release; }),
            "Blocked start was not released");
    running_ = !gate_->failure;
    return gate_->failure;
  }
  bool stop(std::chrono::steady_clock::time_point) noexcept override {
    std::scoped_lock lock(gate_->mutex);
    ++gate_->stops;
    running_ = false;
    return true;
  }
  std::optional<ScreenAudioFailure> failure() const noexcept override {
    std::scoped_lock lock(gate_->mutex);
    return gate_->failure;
  }
  ScreenAudioSessionStats stats() const noexcept override {
    std::scoped_lock lock(gate_->mutex);
    ScreenAudioSessionStats result;
    result.clients = running_ ? 1 : 0;
    return result;
  }

 private:
  std::shared_ptr<Gate> gate_;
  bool running_ = false;
};
void supersededStartNeverCommits() {
  auto gate = std::make_shared<Gate>();
  ScreenAudioOwner owner([gate] { return std::make_unique<Session>(gate); });
  const ScreenAudioIntent on{ScreenAudioMode::include_process_tree,
                             AudioProcessIdentity::current()};
  require(owner.applyDesired(1, on), "On intent rejected");
  {
    std::unique_lock lock(gate->mutex);
    require(gate->changed.wait_for(lock, 2s, [&] { return gate->starts == 1; }),
            "Start not entered");
  }
  require(owner.applyDesired(2, std::nullopt), "Superseding off rejected");
  require(!owner.applyDesired(1, on), "Stale intent accepted");
  {
    std::scoped_lock lock(gate->mutex);
    gate->release = true;
    gate->changed.notify_all();
  }
  until([&] { return owner.stats().state == ScreenAudioState::stopped; });
  const auto stopped = owner.stats();
  require(stopped.active_revision == 0 && stopped.session.clients == 0,
          "Superseded audio became current");
  {
    std::scoped_lock lock(gate->mutex);
    require(gate->starts == 1 && gate->stops == 1, "Old session was not drained exactly once");
  }
  require(owner.stop(std::chrono::steady_clock::now() + 2s), "Owner stop failed");
}
void independentRevisionAndExplicitRetry() {
  auto gate = std::make_shared<Gate>();
  gate->release = true;
  ScreenAudioOwner owner([gate] { return std::make_unique<Session>(gate); });
  ScreenAudioIntent on{ScreenAudioMode::include_process_tree, AudioProcessIdentity::current()};
  require(owner.applyDesired(1, on), "On rejected");
  until([&] { return owner.stats().active_revision == 1; });
  require(owner.applyDesired(2, on), "Equivalent revision rejected");
  until([&] { return owner.stats().active_revision == 2; });
  {
    std::scoped_lock lock(gate->mutex);
    require(gate->starts == 1, "Equivalent intent republished");
    gate->failure = ScreenAudioFailure{ScreenAudioFailureCode::target_exited};
  }
  until([&] { return owner.stats().state == ScreenAudioState::failed; });
  require(owner.stats().failure->code == ScreenAudioFailureCode::target_exited,
          "Target loss reason lost");
  {
    std::scoped_lock lock(gate->mutex);
    require(gate->starts == 1 && gate->stops == 1, "Failure automatically retried or leaked");
    gate->failure.reset();
  }
  on.mode = ScreenAudioMode::system_exclude_client;
  require(owner.applyDesired(3, on), "Explicit new mode rejected");
  until([&] { return owner.stats().active_revision == 3; });
  {
    std::scoped_lock lock(gate->mutex);
    require(gate->starts == 2 && gate->modes.back() == ScreenAudioMode::system_exclude_client,
            "New mode not applied");
  }
  require(owner.applyDesired(4, std::nullopt), "Audio off rejected");
  until([&] { return owner.stats().state == ScreenAudioState::stopped; });
  require(owner.stop(std::chrono::steady_clock::now() + 2s), "Final stop failed");
}
void concurrentStopJoinsOnce() {
  auto gate = std::make_shared<Gate>();
  gate->release = true;
  ScreenAudioOwner owner([gate] { return std::make_unique<Session>(gate); });
  require(owner.applyDesired(1, ScreenAudioIntent{ScreenAudioMode::include_process_tree,
      AudioProcessIdentity::current()}), "Concurrent-stop intent rejected");
  until([&] { return owner.stats().state == ScreenAudioState::running; });
  std::barrier start{3};
  bool first = false, second = false;
  std::thread a([&] { start.arrive_and_wait(); first = owner.stop(std::chrono::steady_clock::now() + 2s); });
  std::thread b([&] { start.arrive_and_wait(); second = owner.stop(std::chrono::steady_clock::now() + 2s); });
  start.arrive_and_wait(); a.join(); b.join();
  require(first && second && gate->stops == 1, "Concurrent stops did not share one teardown");
}
void retirementCannotBeSupersededByNewIntent() {
  auto gate = std::make_shared<Gate>();
  ScreenAudioOwner owner([gate] { return std::make_unique<Session>(gate); });
  const ScreenAudioIntent on{ScreenAudioMode::include_process_tree,
                             AudioProcessIdentity::current()};
  require(owner.applyDesired(1, on), "Retirement fixture on rejected");
  {
    std::unique_lock lock(gate->mutex);
    require(gate->changed.wait_for(lock, 2s, [&] { return gate->starts == 1; }),
            "Retirement fixture did not start");
  }
  require(owner.applyDesired(2, std::nullopt), "Superseding retirement fixture off rejected");
  {
    std::scoped_lock lock(gate->mutex);
    gate->failure =
        ScreenAudioFailure{ScreenAudioFailureCode::publication_timeout, E_PENDING, true};
    gate->release = true;
    gate->changed.notify_all();
  }
  until([&] { return owner.stats().failure.has_value(); });
  require(owner.stats().failure->utility_retirement_required,
          "Superseding intent erased unsafe completion");
  require(!owner.applyDesired(3, on), "Retired utility admitted new audio work");
  require(owner.stop(std::chrono::steady_clock::now() + 2s), "Retired owner thread did not finish");
}
}  // namespace
int main() {
  try {
    supersededStartNeverCommits();
    independentRevisionAndExplicitRetry();
    retirementCannotBeSupersededByNewIntent();
    concurrentStopJoinsOnce();
    std::cout << "Screen audio desired-state and failure isolation passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
