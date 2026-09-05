#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>

#include "screen/production_screen_sender.hpp"

namespace {

using namespace std::chrono_literals;
using namespace syrnike::windows_media::screen;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

class ManualPublicationAdapter final : public ScreenPublicationAdapter {
 public:
  void startPublish(std::uint64_t generation, ScreenTrackDescriptor,
                    ScreenOperationCompletion completion) override {
    std::lock_guard lock(mutex_);
    publish_.emplace(generation, std::move(completion));
  }

  void startSubmit(std::uint64_t generation, EncodedScreenFrame frame,
                   ScreenOperationCompletion completion) override {
    std::lock_guard lock(mutex_);
    if (throw_submit_) throw std::runtime_error("injected submit start failure");
    submitted_.emplace(frame.slot, Submitted{generation, std::move(completion)});
  }

  void startUnpublish(std::uint64_t generation,
                      ScreenOperationCompletion completion) override {
    std::lock_guard lock(mutex_);
    unpublish_.emplace(generation, std::move(completion));
  }

  void completePublish(std::uint64_t generation,
                       ScreenOperationResult result = {}) {
    take(publish_, generation)(generation, std::move(result));
  }

  void completeSubmit(std::uint32_t slot, ScreenOperationResult result = {}) {
    Submitted submitted;
    {
      std::lock_guard lock(mutex_);
      submitted = std::move(submitted_.at(slot));
      submitted_.erase(slot);
    }
    submitted.completion(submitted.generation, std::move(result));
  }

  void completeUnpublish(std::uint64_t generation,
                         ScreenOperationResult result = {}) {
    take(unpublish_, generation)(generation, std::move(result));
  }

  void throwOnSubmitStart() {
    std::lock_guard lock(mutex_);
    throw_submit_ = true;
  }

 private:
  struct Submitted {
    std::uint64_t generation = 0;
    ScreenOperationCompletion completion;
  };

  static ScreenOperationCompletion take(
      std::map<std::uint64_t, ScreenOperationCompletion>& operations,
      std::uint64_t generation) {
    auto completion = std::move(operations.at(generation));
    operations.erase(generation);
    return completion;
  }

  std::mutex mutex_;
  std::map<std::uint64_t, ScreenOperationCompletion> publish_;
  std::map<std::uint32_t, Submitted> submitted_;
  std::map<std::uint64_t, ScreenOperationCompletion> unpublish_;
  bool throw_submit_ = false;
};

ScreenPublicationEvent waitEvent(ProductionScreenSender& sender) {
  auto event = sender.waitForEvent(1s);
  require(event.has_value(), "screen publication event timed out");
  return std::move(*event);
}

EncodedScreenFrame frame(std::uint64_t generation, std::uint32_t slot,
                         std::uint64_t sequence) {
  static constexpr std::uint8_t kAccessUnit[] = {0, 0, 0, 1, 0x65};
  return EncodedScreenFrame{generation, slot, sequence, sequence * 1'000,
                            true, kAccessUnit, sizeof(kAccessUnit)};
}

void publishesSubmitsAndStopsAsynchronously() {
  auto adapter = std::make_shared<ManualPublicationAdapter>();
  ProductionScreenSender sender(adapter);
  const auto started = sender.start(ScreenTrackDescriptor{"screen", 1920, 1080,
                                                           60, 8'000'000});
  require(started.ok && started.generation == 1,
          "screen generation did not start");
  adapter->completePublish(1);
  auto published = waitEvent(sender);
  require(published.kind == ScreenPublicationEventKind::Published &&
              published.generation == 1,
          "publish acknowledgement was not emitted");

  require(sender.submit(frame(1, 7, 10)) == ScreenSubmitResult::Accepted,
          "encoded frame was not accepted");
  adapter->completeSubmit(7);
  auto consumed = waitEvent(sender);
  require(consumed.kind == ScreenPublicationEventKind::SlotReleased &&
              consumed.slot == 7 &&
              consumed.release_reason == ScreenSlotReleaseReason::Consumed,
          "SDK consumption did not return the encoded slot");

  require(sender.stop(1).ok, "screen stop did not enqueue");
  adapter->completeUnpublish(1);
  auto stopped = waitEvent(sender);
  require(stopped.kind == ScreenPublicationEventKind::Unpublished &&
              sender.state() == ScreenPublicationState::Idle,
          "unpublish acknowledgement did not close the generation");
}

void overloadKeepsNewestPendingFrameAndReturnsSupersededSlot() {
  auto adapter = std::make_shared<ManualPublicationAdapter>();
  ProductionScreenSender sender(adapter);
  require(sender.start(ScreenTrackDescriptor{"screen", 2560, 1440, 30,
                                              10'000'000})
              .ok,
          "overload generation did not start");
  adapter->completePublish(1);
  (void)waitEvent(sender);

  require(sender.submit(frame(1, 1, 1)) == ScreenSubmitResult::Accepted,
          "active frame was rejected");
  require(sender.submit(frame(1, 2, 2)) == ScreenSubmitResult::Accepted,
          "pending frame was rejected");
  require(sender.submit(frame(1, 3, 3)) == ScreenSubmitResult::Accepted,
          "newest pending frame was rejected");
  const auto superseded = waitEvent(sender);
  require(superseded.kind == ScreenPublicationEventKind::SlotReleased &&
              superseded.slot == 2 &&
              superseded.release_reason ==
                  ScreenSlotReleaseReason::Superseded,
          "latest-wins overload did not return the older pending slot");

  adapter->completeSubmit(1);
  const auto first = waitEvent(sender);
  require(first.slot == 1 &&
              first.release_reason == ScreenSlotReleaseReason::Consumed,
          "active slot was not returned before the pending frame advanced");
  adapter->completeSubmit(3);
  const auto newest = waitEvent(sender);
  require(newest.slot == 3 &&
              newest.release_reason == ScreenSlotReleaseReason::Consumed,
          "newest pending slot was not submitted");
}

void staleCompletionCannotMutateANewGeneration() {
  auto adapter = std::make_shared<ManualPublicationAdapter>();
  ProductionScreenSender sender(adapter);
  require(sender.start(ScreenTrackDescriptor{"first", 1920, 1080, 60,
                                              8'000'000})
              .ok,
          "first generation did not start");
  adapter->completePublish(1);
  (void)waitEvent(sender);
  require(sender.stop(1).ok, "first generation did not stop");
  adapter->completeUnpublish(1);
  (void)waitEvent(sender);

  require(sender.start(ScreenTrackDescriptor{"second", 1280, 720, 30,
                                              4'000'000})
              .ok,
          "second generation did not start");
  adapter->completePublish(2);
  const auto published = waitEvent(sender);
  require(published.generation == 2 &&
              sender.state() == ScreenPublicationState::Published,
          "new generation was not published");
}

void hungSubmitEscalatesAndLateCompletionReturnsBorrowedSlot() {
  auto adapter = std::make_shared<ManualPublicationAdapter>();
  ProductionScreenSender sender(
      adapter, ScreenPublicationDeadlines{1s, 20ms, 1s});
  require(sender.start(ScreenTrackDescriptor{"screen", 1280, 720, 30,
                                              4'000'000})
              .ok,
          "timeout generation did not start");
  adapter->completePublish(1);
  (void)waitEvent(sender);
  require(sender.submit(frame(1, 2, 1)) == ScreenSubmitResult::Accepted,
          "timeout frame was rejected");
  const auto terminal = waitEvent(sender);
  require(terminal.kind == ScreenPublicationEventKind::TerminalFailure &&
              terminal.failure &&
              terminal.failure->utility_epoch_retirement_required,
          "hung SDK submit did not require utility epoch retirement");
  adapter->completeSubmit(2);
  const auto returned = waitEvent(sender);
  require(returned.kind == ScreenPublicationEventKind::SlotReleased &&
              returned.slot == 2 &&
              returned.release_reason == ScreenSlotReleaseReason::Consumed,
          "late SDK completion did not return the borrowed slot exactly once");
}

void hungUnpublishHasAnIndependentDeadline() {
  auto adapter = std::make_shared<ManualPublicationAdapter>();
  ProductionScreenSender sender(
      adapter, ScreenPublicationDeadlines{1s, 1s, 20ms});
  require(sender.start(ScreenTrackDescriptor{"screen", 1280, 720, 30,
                                              4'000'000})
              .ok,
          "unpublish timeout generation did not start");
  adapter->completePublish(1);
  (void)waitEvent(sender);
  require(sender.stop(1).ok, "unpublish timeout stop was rejected");
  const auto terminal = waitEvent(sender);
  require(terminal.kind == ScreenPublicationEventKind::TerminalFailure &&
              terminal.failure && terminal.failure->stage == "screen_unpublish" &&
              terminal.failure->utility_epoch_retirement_required,
          "hung unpublish did not produce its typed terminal deadline");
}

void adapterSubmitStartFailureReturnsSlotBeforeTerminalFailure() {
  auto adapter = std::make_shared<ManualPublicationAdapter>();
  ProductionScreenSender sender(adapter);
  require(sender.start(ScreenTrackDescriptor{"screen", 1280, 720, 30,
                                              4'000'000})
              .ok,
          "throwing adapter generation did not start");
  adapter->completePublish(1);
  (void)waitEvent(sender);
  adapter->throwOnSubmitStart();
  require(sender.submit(frame(1, 1, 1)) == ScreenSubmitResult::Accepted,
          "throwing adapter frame was not accepted by the port");
  const auto released = waitEvent(sender);
  const auto terminal = waitEvent(sender);
  require(released.kind == ScreenPublicationEventKind::SlotReleased &&
              released.slot == 1 &&
              released.release_reason == ScreenSlotReleaseReason::Failed &&
              terminal.kind == ScreenPublicationEventKind::TerminalFailure,
          "adapter start failure did not return the active slot before failing");
}

}  // namespace

int main() try {
  publishesSubmitsAndStopsAsynchronously();
  overloadKeepsNewestPendingFrameAndReturnsSupersededSlot();
  staleCompletionCannotMutateANewGeneration();
  hungSubmitEscalatesAndLateCompletionReturnsBorrowedSlot();
  hungUnpublishHasAnIndependentDeadline();
  adapterSubmitStartFailureReturnsSlotBeforeTerminalFailure();
  return 0;
} catch (const std::exception& error) {
  return error.what()[0] == '\0' ? 2 : 1;
}
