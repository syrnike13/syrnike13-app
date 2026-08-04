#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "common/event_sink.hpp"
#include "common/sequenced_emitter.hpp"
#include "media/livekit_voice_session.hpp"
#include "media/media_runtime.hpp"
#include "media/media_runtime_support.hpp"
#include "media/voice_actor.hpp"
#include "media/voice_attempt_commit.hpp"

namespace {

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    {
      std::lock_guard lock(mutex_);
      if (closed_) emissions_after_close_ += 1;
      events_.push_back(std::move(event));
    }
    changed_.notify_all();
    return true;
  }
  void close() override {
    std::lock_guard lock(mutex_);
    closed_ = true;
  }

  bool waitReply(const std::string& request_id, std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == "reply" && event.request_id == request_id && event.ok) return true;
      }
      return false;
    });
  }

  bool waitFailedReply(const std::string& request_id, std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == "reply" && event.request_id == request_id && !event.ok) return true;
      }
      return false;
    });
  }

  std::size_t replyCount(const std::string& request_id) {
    std::lock_guard lock(mutex_);
    return static_cast<std::size_t>(std::count_if(
      events_.begin(),
      events_.end(),
      [&](const auto& event) {
        return event.type == "reply" && event.request_id == request_id;
      }
    ));
  }

  std::size_t emissionsAfterClose() {
    std::lock_guard lock(mutex_);
    return emissions_after_close_;
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
  bool closed_ = false;
  std::size_t emissions_after_close_ = 0;
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

template <typename Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (!predicate() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return predicate();
}

syrnike::desktop_native::MediaCommand voiceCommand(
  std::string type,
  std::string request_id,
  std::uint64_t generation
) {
  syrnike::desktop_native::MediaCommand command;
  command.type = std::move(type);
  command.request_id = std::move(request_id);
  command.session_id = "voice-session";
  command.generation = generation;
  command.livekit_url = "wss://livekit.example";
  command.livekit_token = "token";
  return command;
}

}  // namespace

int main() try {
  using Client = syrnike::desktop_native::media::DeterministicFakeLiveKitVoiceSession;
  using syrnike::desktop_native::media::MediaRuntime;
  using syrnike::desktop_native::media::VoiceAttemptCommit;

  VoiceAttemptCommit committed_gate;
  bool committed = false;
  std::thread committed_waiter([&] {
    committed = committed_gate.waitFor(std::chrono::seconds(1));
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  committed_gate.commit();
  committed_waiter.join();
  require(committed, "voice attempt commit gate did not release its worker");

  VoiceAttemptCommit cancelled_gate;
  bool cancelled_result = true;
  const auto cancelled_started = std::chrono::steady_clock::now();
  std::thread cancelled_waiter([&] {
    cancelled_result = cancelled_gate.waitFor(std::chrono::seconds(1));
  });
  cancelled_gate.cancel();
  cancelled_waiter.join();
  require(
    !cancelled_result &&
      std::chrono::steady_clock::now() - cancelled_started <
        std::chrono::milliseconds(250),
    "voice attempt commit cancellation did not provide bounded teardown"
  );

  VoiceAttemptCommit timed_gate;
  const auto timeout_started = std::chrono::steady_clock::now();
  require(
    !timed_gate.waitFor(std::chrono::milliseconds(20)) &&
      std::chrono::steady_clock::now() - timeout_started <
        std::chrono::milliseconds(250),
    "voice attempt commit deadline did not bound an orphaned worker"
  );

  auto launcher_sink = std::make_shared<CollectingSink>();
  syrnike::desktop_native::SequencedEmitter launcher_emitter(launcher_sink);
  auto launcher_client = std::make_shared<Client>();
  require(
    launcher_client->connectVoice(
      "launcher-failure",
      1,
      "wss://livekit.example",
      "token",
      {}
    ),
    "voice launcher test did not establish its Room"
  );
  std::atomic_int voice_launch_attempts{0};
  std::atomic_int voice_enqueue_attempts{0};
  {
    syrnike::desktop_native::media::VoiceActor launcher_actor(
      launcher_emitter,
      [](syrnike::desktop_native::MediaCommand) { return true; },
      [](const std::string&, std::uint64_t) { return true; },
      launcher_client,
      [&](syrnike::desktop_native::AsyncCleanupTask task) -> std::thread {
        if (voice_launch_attempts.fetch_add(1) == 0) {
          throw std::runtime_error("injected voice cleanup launch failure");
        }
        return std::thread(std::move(task));
      },
      [&] {
        if (voice_enqueue_attempts.fetch_add(1) == 0) {
          throw std::bad_alloc();
        }
      }
    );
    const auto launcher_shutdown_started = std::chrono::steady_clock::now();
    launcher_actor.shutdown();
    require(
      std::chrono::steady_clock::now() - launcher_shutdown_started <
        std::chrono::milliseconds(100),
      "voice cleanup allocation/enqueue failure blocked shutdown"
    );
    require(
      waitUntil(
        [&] {
          return launcher_client->disconnectCallCount() == 1 &&
            !launcher_client->isVoiceConnected();
        },
        std::chrono::seconds(1)
      ),
      "voice cleanup dispatcher did not retry the failed launch"
    );
  }
  require(
    voice_enqueue_attempts.load() >= 2 &&
      voice_launch_attempts.load() >= 2 &&
      launcher_client->disconnectCallCount() == 1,
    "voice cleanup enqueue/launcher failure lost or duplicated disconnect"
  );

  struct BlockedCleanupOwner {
    std::atomic_int* started;
    std::atomic_int* exited;
    std::atomic_bool* release;
  };
  constexpr int hung_cleanup_count = 65;
  std::atomic_int hung_cleanup_started{0};
  std::atomic_int hung_cleanup_exited{0};
  std::atomic_bool release_hung_cleanup{false};
  std::vector<std::shared_ptr<syrnike::desktop_native::AsyncCleanupNode>>
    hung_cleanup_nodes;
  std::vector<std::shared_ptr<BlockedCleanupOwner>> hung_cleanup_owners;
  hung_cleanup_nodes.reserve(hung_cleanup_count);
  hung_cleanup_owners.reserve(hung_cleanup_count);
  for (int index = 0; index < hung_cleanup_count; ++index) {
    auto node =
      std::make_shared<syrnike::desktop_native::AsyncCleanupNode>();
    auto owner = std::make_shared<BlockedCleanupOwner>(
      BlockedCleanupOwner{
        &hung_cleanup_started,
        &hung_cleanup_exited,
        &release_hung_cleanup,
      }
    );
    node->prepare(
      owner,
      [](void* value) noexcept {
        auto* blocked = static_cast<BlockedCleanupOwner*>(value);
        blocked->started->fetch_add(1);
        while (!blocked->release->load()) std::this_thread::yield();
        blocked->exited->fetch_add(1);
      }
    );
    hung_cleanup_nodes.push_back(node);
    hung_cleanup_owners.push_back(std::move(owner));
  }
  const auto saturation_submit_started = std::chrono::steady_clock::now();
  for (const auto& node : hung_cleanup_nodes) {
    syrnike::desktop_native::AsyncCleanupDispatcher::instance().submit(node);
  }
  require(
    std::chrono::steady_clock::now() - saturation_submit_started <
      std::chrono::milliseconds(100),
    "65 preallocated cleanup submissions blocked their caller"
  );
  require(
    waitUntil(
      [&] { return hung_cleanup_started.load() == hung_cleanup_count; },
      std::chrono::seconds(2)
    ),
    "hung SDK cleanup saturated the launcher-only dispatcher"
  );
  release_hung_cleanup.store(true);
  require(
    waitUntil(
      [&] { return hung_cleanup_exited.load() == hung_cleanup_count; },
      std::chrono::seconds(2)
    ),
    "released SDK cleanup workers did not exit"
  );
  require(
    waitUntil(
      [&] { return hung_cleanup_nodes.front()->finished(); },
      std::chrono::seconds(1)
    ),
    "cleanup node did not become reusable after completion"
  );
  std::atomic_int reuse_count{0};
  auto reuse_owner = std::shared_ptr<void>(
    &reuse_count,
    [](void*) {}
  );
  hung_cleanup_nodes.front()->prepare(
    std::move(reuse_owner),
    [](void* value) noexcept {
      static_cast<std::atomic_int*>(value)->fetch_add(1);
    }
  );
  syrnike::desktop_native::AsyncCleanupDispatcher::instance().submit(
    hung_cleanup_nodes.front()
  );
  require(
    waitUntil(
      [&] { return reuse_count.load() == 1; },
      std::chrono::seconds(1)
    ),
    "completed cleanup node was not reusable exactly once"
  );

  auto sink = std::make_shared<CollectingSink>();
  auto client = std::make_shared<Client>();
  client->setBlocked(Client::Operation::Connect, true);
  auto runtime = std::make_unique<MediaRuntime>(sink, client);

  require(runtime->dispatch(voiceCommand("connectVoice", "connect-a", 1)),
    "runtime rejected connect A");
  client->waitUntilPending(Client::Operation::Connect, 1);

  require(runtime->dispatch(voiceCommand("disconnectVoice", "disconnect-a", 2)),
    "runtime rejected disconnect A");
  require(sink->waitReply("disconnect-a", std::chrono::milliseconds(500)),
    "disconnect was blocked behind connect A");
  require(sink->waitFailedReply("connect-a", std::chrono::milliseconds(500)),
    "cancelled connect A did not settle its pending request");
  require(client->pending(Client::Operation::Connect) == 0,
    "disconnect did not cooperatively cancel connect A");

  client->setBlocked(Client::Operation::Connect, false);
  require(runtime->dispatch(voiceCommand("connectVoice", "connect-b", 3)),
    "runtime rejected connect B");
  require(sink->waitReply("connect-b", std::chrono::seconds(2)),
    "connect B did not complete after stale A completion");
  require(client->isVoiceConnected(),
    "stale connect A completion disconnected or replaced Room B");

  std::chrono::steady_clock::duration longest_dispatch{};
  for (std::uint64_t reconnect = 0; reconnect < 50; ++reconnect) {
    const auto started = std::chrono::steady_clock::now();
    require(
      runtime->dispatch(voiceCommand(
        "connectVoice",
        "reconnect-" + std::to_string(reconnect),
        4 + reconnect
      )),
      "rapid reconnect was lost at the voice mailbox"
    );
    longest_dispatch = std::max(
      longest_dispatch,
      std::chrono::steady_clock::now() - started
    );
  }
  require(
    longest_dispatch < std::chrono::milliseconds(50),
    "JS-facing reconnect dispatch blocked for 50ms or longer"
  );
  require(
    sink->waitReply("reconnect-49", std::chrono::seconds(5)),
    "voice mailbox did not settle the final rapid reconnect"
  );

  runtime->requestShutdown();
  runtime->shutdownAndWait();
  runtime.reset();
  client.reset();
  require(
    waitUntil(
      [] {
        return syrnike::desktop_native::media::LiveKitLease::activeCount() == 0;
      },
      std::chrono::seconds(2)
    ),
    "initial runtime quarantine did not release its LiveKit lease"
  );

  const auto leases_before_blocked_runtime =
    syrnike::desktop_native::media::LiveKitLease::activeCount();
  const auto initializes_before_blocked_runtime =
    syrnike::desktop_native::media::LiveKitLease::initializeTransitionCount();
  const auto shutdowns_before_blocked_runtime =
    syrnike::desktop_native::media::LiveKitLease::shutdownTransitionCount();
  auto blocked_sink = std::make_shared<CollectingSink>();
  auto blocked_client = std::make_shared<Client>();
  blocked_client->setBlocked(Client::Operation::Connect, true);
  blocked_client->setCancelPendingConnectOnDisconnect(false);
  std::mutex microphone_gate_mutex;
  std::condition_variable microphone_gate_changed;
  bool microphone_operation_entered = false;
  bool release_microphone_operation = false;
  bool microphone_operation_exited = false;
  std::atomic_int subsystem_cleanup_launches{0};
  std::atomic_int subsystem_cleanup_completions{0};
  auto blocked_runtime = std::make_unique<MediaRuntime>(
    blocked_sink,
    blocked_client,
    MediaRuntime::SteadyNow{},
    [&](const syrnike::desktop_native::MediaCommand&) {
      std::unique_lock lock(microphone_gate_mutex);
      microphone_operation_entered = true;
      microphone_gate_changed.notify_all();
      microphone_gate_changed.wait(lock, [&] {
        return release_microphone_operation;
      });
      microphone_operation_exited = true;
      microphone_gate_changed.notify_all();
    },
    MediaRuntime::BeforeVoiceShutdown{},
    std::shared_ptr<
      syrnike::desktop_native::media::LiveKitRuntimeLifetime
    >{},
    [&](syrnike::desktop_native::AsyncCleanupTask task) -> std::thread {
      if (subsystem_cleanup_launches.fetch_add(1) == 0) {
        throw std::runtime_error(
          "injected media runtime quarantine launch failure"
        );
      }
      return std::thread(std::move(task));
    },
    [&] {
      subsystem_cleanup_completions.fetch_add(1);
    }
  );
  blocked_runtime->waitUntilReady();
  syrnike::desktop_native::MediaCommand configure_microphone;
  configure_microphone.type = "configureMicrophone";
  configure_microphone.request_id = "blocked-microphone-operation";
  configure_microphone.session_id = "blocked-microphone";
  configure_microphone.generation = 1;
  require(
    blocked_runtime->dispatch(std::move(configure_microphone)),
    "runtime rejected blocked microphone operation"
  );
  {
    std::unique_lock lock(microphone_gate_mutex);
    require(
      microphone_gate_changed.wait_for(
        lock,
        std::chrono::seconds(1),
        [&] { return microphone_operation_entered; }
      ),
      "microphone operation did not reach its injected blocker"
    );
  }
  require(
    blocked_runtime->dispatch(
      voiceCommand("connectVoice", "blocked-voice-connect", 1)
    ),
    "runtime rejected blocked voice connect"
  );
  blocked_client->waitUntilPending(Client::Operation::Connect, 1);

  syrnike::desktop_native::MediaCommand shutdown_command;
  shutdown_command.type = "shutdown";
  shutdown_command.request_id = "blocked-runtime-shutdown";
  const auto blocked_shutdown_started = std::chrono::steady_clock::now();
  require(
    blocked_runtime->dispatch(std::move(shutdown_command)),
    "runtime rejected shutdown with blocked subsystems"
  );
  blocked_runtime->shutdownAndWait();
  const auto blocked_shutdown_elapsed =
    std::chrono::steady_clock::now() - blocked_shutdown_started;
  require(
    blocked_shutdown_elapsed <
      syrnike::desktop_native::media::kNativeShutdownBudget,
    "combined voice and microphone blockers exceeded the native shutdown budget"
  );
  require(
    blocked_sink->replyCount("blocked-runtime-shutdown") == 1,
    "runtime shutdown did not produce exactly one quarantine reply"
  );
  require(
    blocked_client->pending(Client::Operation::Connect) == 1,
    "voice blocker was released instead of quarantined"
  );
  {
    std::lock_guard lock(microphone_gate_mutex);
    require(
      !microphone_operation_exited,
      "microphone blocker was released instead of quarantined"
    );
  }
  require(
    syrnike::desktop_native::media::LiveKitLease::activeCount() ==
      leases_before_blocked_runtime + 1,
    "blocked runtime released LiveKit before quarantined work completed"
  );
  require(
    subsystem_cleanup_completions.load() == 0,
    "media runtime reported quarantine completion before blocked work exited"
  );
  blocked_runtime.reset();

  {
    std::lock_guard lock(microphone_gate_mutex);
    release_microphone_operation = true;
  }
  microphone_gate_changed.notify_all();
  Client::Release failed_connect;
  failed_connect.bool_result = false;
  blocked_client->releaseNext(
    Client::Operation::Connect,
    std::move(failed_connect)
  );
  require(
    waitUntil(
      [&] {
        std::lock_guard lock(microphone_gate_mutex);
        return microphone_operation_exited;
      },
      std::chrono::seconds(1)
    ),
    "quarantined microphone operation did not exit after release"
  );
  require(
    waitUntil(
      [&] {
        return blocked_client->pending(Client::Operation::Connect) == 0;
      },
      std::chrono::seconds(1)
    ),
    "quarantined voice connect did not exit after release"
  );
  blocked_client.reset();
  require(
    waitUntil(
      [&] {
        return syrnike::desktop_native::media::LiveKitLease::activeCount() ==
          leases_before_blocked_runtime;
      },
      std::chrono::seconds(2)
    ),
    "combined runtime quarantine retained its LiveKit lease after completion"
  );
  require(
    syrnike::desktop_native::media::LiveKitLease::initializeTransitionCount() ==
        initializes_before_blocked_runtime + 1 &&
      syrnike::desktop_native::media::LiveKitLease::shutdownTransitionCount() ==
        shutdowns_before_blocked_runtime + 1,
    "combined runtime quarantine initialized or released LiveKit more than once"
  );
  require(
    blocked_sink->emissionsAfterClose() == 0,
    "late quarantined work emitted after the runtime sink closed"
  );
  require(
    subsystem_cleanup_launches.load() >= 2,
    "media runtime quarantine did not retry its failed cleanup launch"
  );
  require(
    subsystem_cleanup_completions.load() == 1,
    "media runtime quarantine completion hook was lost or duplicated"
  );

  bool shutdown_injection_observed_active_lease = false;
  const auto leases_before_exception_runtime =
    syrnike::desktop_native::media::LiveKitLease::activeCount();
  const auto initializes_before_exception_runtime =
    syrnike::desktop_native::media::LiveKitLease::initializeTransitionCount();
  const auto shutdowns_before_exception_runtime =
    syrnike::desktop_native::media::LiveKitLease::shutdownTransitionCount();
  auto exception_client = std::make_shared<Client>();
  std::shared_ptr<syrnike::desktop_native::media::LiveKitRuntimeLifetime>
    detached_task_lifetime;
  {
    auto exception_sink = std::make_shared<CollectingSink>();
    MediaRuntime exception_runtime(
      exception_sink,
      exception_client,
      {},
      {},
      [&] {
        shutdown_injection_observed_active_lease =
          syrnike::desktop_native::media::LiveKitLease::activeCount() ==
            leases_before_exception_runtime + 1;
        throw std::runtime_error("injected voice shutdown failure");
      }
    );
    exception_runtime.waitUntilReady();
    detached_task_lifetime = exception_client->runtimeLifetimeToken();
    exception_runtime.requestShutdown();
    exception_runtime.shutdownAndWait();
  }
  require(
    shutdown_injection_observed_active_lease,
    "voice shutdown exception ran after the LiveKit FFI lease was destroyed"
  );
  require(
    syrnike::desktop_native::media::LiveKitLease::activeCount() ==
      leases_before_exception_runtime + 1,
    "runtime destruction shut LiveKit down while a detached client/task remained"
  );
  exception_client.reset();
  require(
    syrnike::desktop_native::media::LiveKitLease::activeCount() ==
      leases_before_exception_runtime + 1,
    "client release shut LiveKit down while a detached task token remained"
  );
  {
    auto replacement_sink = std::make_shared<CollectingSink>();
    MediaRuntime replacement_runtime(
      replacement_sink,
      std::make_shared<Client>()
    );
    replacement_runtime.waitUntilReady();
    require(
      syrnike::desktop_native::media::LiveKitLease::activeCount() ==
        leases_before_exception_runtime + 2,
      "replacement runtime did not acquire a second logical LiveKit lease"
    );
    replacement_runtime.requestShutdown();
    replacement_runtime.shutdownAndWait();
  }
  require(
    waitUntil(
      [&] {
        return syrnike::desktop_native::media::LiveKitLease::activeCount() ==
          leases_before_exception_runtime + 1;
      },
      std::chrono::seconds(2)
    ) &&
      syrnike::desktop_native::media::LiveKitLease::initializeTransitionCount() ==
        initializes_before_exception_runtime + 1 &&
      syrnike::desktop_native::media::LiveKitLease::shutdownTransitionCount() ==
        shutdowns_before_exception_runtime,
    "replacement runtime reinitialized or shut down LiveKit under retained work"
  );
  detached_task_lifetime.reset();
  require(
    waitUntil(
      [&] {
        return syrnike::desktop_native::media::LiveKitLease::activeCount() ==
          leases_before_exception_runtime;
      },
      std::chrono::seconds(2)
    ) &&
      syrnike::desktop_native::media::LiveKitLease::shutdownTransitionCount() ==
        shutdowns_before_exception_runtime + 1,
    "last detached SDK owner did not release the LiveKit runtime lease"
  );
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
