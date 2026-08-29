#include <atomic>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

#include "media/remote_audio_operation_supervisor.hpp"

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::CleanupSupervisor;
using syrnike::desktop_native::media::RemoteAudioAttemptRetireStatus;
using syrnike::desktop_native::media::RemoteAudioAttemptWaitStatus;
using syrnike::desktop_native::media::RemoteAudioExternalStage;
using syrnike::desktop_native::media::RemoteAudioOperationAttempt;
using syrnike::desktop_native::media::RemoteAudioAttemptDomain;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void waitForBaseline(const std::shared_ptr<RemoteAudioAttemptDomain>& domain) {
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  while (std::chrono::steady_clock::now() < deadline) {
    const auto snapshot = domain->snapshot();
    if (snapshot.active_attempts == 0 &&
        snapshot.quarantined_attempts == 0) {
      return;
    }
    std::this_thread::yield();
  }
  throw std::runtime_error("remote audio attempt domain did not return to baseline");
}

}  // namespace

int main() try {
  CleanupSupervisor supervisor({.worker_limit = 2, .admission_capacity = 8});
  auto domain = std::make_shared<RemoteAudioAttemptDomain>(supervisor, 2);

  const std::vector stages{
    RemoteAudioExternalStage::EndpointProbe,
    RemoteAudioExternalStage::EndpointResolve,
    RemoteAudioExternalStage::Activate,
    RemoteAudioExternalStage::Initialize,
    RemoteAudioExternalStage::Start,
  };
  for (const auto stage : stages) {
    std::atomic_bool release{false};
    std::atomic_bool late_ready{false};
    auto attempt = RemoteAudioOperationAttempt::start(
      domain,
      [&](RemoteAudioOperationAttempt::Context& context) {
        context.setStage(stage);
        while (!release.load(std::memory_order_acquire)) {
          std::this_thread::yield();
        }
        late_ready.store(context.markReady(), std::memory_order_release);
      }
    );
    require(
      attempt->waitUntilReady(std::chrono::steady_clock::now() + 20ms).status ==
        RemoteAudioAttemptWaitStatus::TimedOut,
      "hung external operation did not produce a typed startup timeout"
    );
    require(
      attempt->stage() == stage,
      "hung external operation lost its exact stage"
    );
    require(
      attempt->retire(std::chrono::steady_clock::now() + 20ms) ==
        RemoteAudioAttemptRetireStatus::Quarantined,
      "hung external operation blocked instead of entering quarantine"
    );
    release.store(true, std::memory_order_release);
    waitForBaseline(domain);
    require(
      !late_ready.load(std::memory_order_acquire),
      "late external completion mutated the retired attempt"
    );
  }

  auto failed = RemoteAudioOperationAttempt::start(
    domain,
    [](RemoteAudioOperationAttempt::Context& context) {
      context.setStage(RemoteAudioExternalStage::Start);
      throw syrnike::desktop_native::media::AudioFailure(
        syrnike::desktop_native::media::AudioFailureKind::ClientStartFailed,
        "injected renderer start failure",
        E_FAIL
      );
    }
  );
  require(
    failed->waitUntilReady(std::chrono::steady_clock::now() + 100ms).status ==
      RemoteAudioAttemptWaitStatus::Failed &&
      failed->failure().has_value() &&
      failed->failure()->kind ==
        syrnike::desktop_native::media::AudioFailureKind::ClientStartFailed,
    "external operation failure lost its typed cause"
  );
  require(
    failed->retire(std::chrono::steady_clock::now() + 100ms) ==
      RemoteAudioAttemptRetireStatus::Stopped,
    "failed external operation did not retire cooperatively"
  );

  std::atomic_bool release_stop{false};
  auto hung_stop = RemoteAudioOperationAttempt::start(
    domain,
    [&](RemoteAudioOperationAttempt::Context& context) {
      context.setStage(RemoteAudioExternalStage::Render);
      static_cast<void>(context.markReady());
      while (!context.stopRequested()) std::this_thread::yield();
      context.setStage(RemoteAudioExternalStage::Stop);
      while (!release_stop.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
    }
  );
  require(
    hung_stop->waitUntilReady(std::chrono::steady_clock::now() + 100ms).status ==
      RemoteAudioAttemptWaitStatus::Ready,
    "stop-timeout attempt did not first become ready"
  );
  require(
    hung_stop->retire(std::chrono::steady_clock::now() + 20ms) ==
      RemoteAudioAttemptRetireStatus::Quarantined &&
      hung_stop->stage() == RemoteAudioExternalStage::Stop,
    "hung stop did not retain its typed stop stage"
  );
  release_stop.store(true, std::memory_order_release);
  waitForBaseline(domain);

  auto cooperative = RemoteAudioOperationAttempt::start(
    domain,
    [](RemoteAudioOperationAttempt::Context& context) {
      context.setStage(RemoteAudioExternalStage::Render);
      require(context.markReady(), "cooperative attempt could not become ready");
      while (!context.stopRequested()) std::this_thread::yield();
      context.setStage(RemoteAudioExternalStage::Stop);
    }
  );
  require(
    cooperative->waitUntilReady(std::chrono::steady_clock::now() + 100ms).status ==
      RemoteAudioAttemptWaitStatus::Ready,
    "healthy retry did not reach ready state"
  );
  RemoteAudioAttemptRetireStatus first_retire{};
  RemoteAudioAttemptRetireStatus second_retire{};
  std::thread first([&] {
    first_retire = cooperative->retire(std::chrono::steady_clock::now() + 200ms);
  });
  std::thread second([&] {
    second_retire = cooperative->retire(std::chrono::steady_clock::now() + 200ms);
  });
  first.join();
  second.join();
  require(
    first_retire == RemoteAudioAttemptRetireStatus::Stopped &&
      second_retire == RemoteAudioAttemptRetireStatus::Stopped,
    "concurrent shutdown did not converge on one cooperative retirement"
  );

  std::atomic_bool release_first{false};
  auto first_hung = RemoteAudioOperationAttempt::start(
    domain,
    [&](RemoteAudioOperationAttempt::Context& context) {
      context.setStage(RemoteAudioExternalStage::Activate);
      while (!release_first.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
    }
  );
  require(
    first_hung->retire(std::chrono::steady_clock::now() + 10ms) ==
      RemoteAudioAttemptRetireStatus::Quarantined,
    "first stalled generation was not quarantined"
  );
  std::atomic_bool release_second{false};
  auto second_hung = RemoteAudioOperationAttempt::start(
    domain,
    [&](RemoteAudioOperationAttempt::Context& context) {
      context.setStage(RemoteAudioExternalStage::Initialize);
      while (!release_second.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
    }
  );
  require(
    second_hung->retire(std::chrono::steady_clock::now() + 10ms) ==
      RemoteAudioAttemptRetireStatus::Quarantined,
    "second stalled generation was not quarantined"
  );
  bool rejected = false;
  try {
    static_cast<void>(RemoteAudioOperationAttempt::start(
      domain,
      [](RemoteAudioOperationAttempt::Context&) {}
    ));
  } catch (const syrnike::desktop_native::media::AudioFailure& failure) {
    rejected = failure.kind() ==
      syrnike::desktop_native::media::AudioFailureKind::OperationTimedOut;
  }
  require(rejected, "quarantine capacity did not reject the third generation");
  const auto saturated = domain->snapshot();
  require(
    saturated.active_attempts == 0 &&
      saturated.quarantined_attempts == 2 &&
      saturated.peak_owned_attempts <= 2 &&
      saturated.rejected_starts == 1,
    "remote audio owner bounds were not exact"
  );
  release_second.store(true, std::memory_order_release);
  const auto second_completion_deadline =
    std::chrono::steady_clock::now() + 200ms;
  while (domain->snapshot().quarantined_attempts == 2 &&
         std::chrono::steady_clock::now() < second_completion_deadline) {
    std::this_thread::yield();
  }
  const auto second_returned_capacity =
    domain->snapshot().quarantined_attempts == 1;
  if (!second_returned_capacity) {
    release_first.store(true, std::memory_order_release);
    waitForBaseline(domain);
  }
  require(
    second_returned_capacity,
    "a completed newer quarantine stayed blocked behind an older hung owner"
  );

  auto retry = RemoteAudioOperationAttempt::start(
    domain,
    [](RemoteAudioOperationAttempt::Context& context) {
      context.setStage(RemoteAudioExternalStage::Render);
      static_cast<void>(context.markReady());
      while (!context.stopRequested()) std::this_thread::yield();
    }
  );
  require(
    retry->waitUntilReady(std::chrono::steady_clock::now() + 100ms).status ==
      RemoteAudioAttemptWaitStatus::Ready,
    "returned quarantine capacity did not admit a healthy retry"
  );
  require(
    retry->retire(std::chrono::steady_clock::now() + 100ms) ==
      RemoteAudioAttemptRetireStatus::Stopped,
    "healthy retry did not retire cooperatively"
  );

  release_first.store(true, std::memory_order_release);
  waitForBaseline(domain);

  const auto shutdown = supervisor.shutdown(std::chrono::steady_clock::now() + 1s);
  require(
    shutdown.finished && shutdown.detached_threads == 0,
    "operation supervisor shutdown detached a worker"
  );
  std::cout << "Remote audio operation supervisor tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
