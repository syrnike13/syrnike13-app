#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "common/cleanup_supervisor.hpp"
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
        if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id && event.ok) return true;
      }
      return false;
    });
  }

  bool waitFailedReply(const std::string& request_id, std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id && !event.ok) return true;
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
        return event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id;
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
  syrnike::desktop_native::NativeCommandType type,
  std::string request_id,
  std::uint64_t generation
) {
  syrnike::desktop_native::MediaCommand command;
  command.type = type;
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
  std::atomic_int voice_launch_attempts{0};
  std::atomic_int voice_enqueue_attempts{0};
  std::mutex launcher_post_mutex;
  std::condition_variable launcher_post_changed;
  std::optional<syrnike::desktop_native::MediaCommand> launcher_completion;
  {
    syrnike::desktop_native::media::VoiceActor launcher_actor(
      launcher_emitter,
      [&](syrnike::desktop_native::MediaCommand command) {
        {
          std::lock_guard lock(launcher_post_mutex);
          launcher_completion = std::move(command);
        }
        launcher_post_changed.notify_all();
        return true;
      },
      [](const std::string&, std::uint64_t) { return true; },
      launcher_client,
      [&] {
        if (voice_launch_attempts.fetch_add(1) == 0) {
          throw std::runtime_error("injected voice cleanup launch failure");
        }
      },
      [&] {
        if (voice_enqueue_attempts.fetch_add(1) == 0) {
          throw std::bad_alloc();
        }
      }
    );
    auto launcher_connect = voiceCommand(
      syrnike::desktop_native::NativeCommandType::ConnectVoice,
      "launcher-connect",
      1
    );
    launcher_connect.session_id = "launcher-failure";
    launcher_actor.connect(launcher_connect);
    {
      std::unique_lock lock(launcher_post_mutex);
      require(
        launcher_post_changed.wait_for(
          lock,
          std::chrono::seconds(1),
          [&] { return launcher_completion.has_value(); }
        ),
        "voice launcher test did not finish its owned Room connection"
      );
      auto completion = std::move(*launcher_completion);
      launcher_completion.reset();
      lock.unlock();
      launcher_actor.handleWorkerCommand(completion);
    }
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
            !syrnike::desktop_native::media::requireSessionPortValue(
              launcher_client->lifecycle().status(
                syrnike::desktop_native::media::SessionPortCall::current()
              )
            );
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

  {
    const auto cleanup_before_exact =
      syrnike::desktop_native::CleanupSupervisor::instance().snapshot();
    auto exact_sink = std::make_shared<CollectingSink>();
    syrnike::desktop_native::SequencedEmitter exact_emitter(exact_sink);
    auto exact_client = std::make_shared<Client>();
    std::mutex completion_mutex;
    std::condition_variable completion_changed;
    std::deque<syrnike::desktop_native::MediaCommand> completions;
    syrnike::desktop_native::media::VoiceActor exact_actor(
      exact_emitter,
      [&](syrnike::desktop_native::MediaCommand command) {
        {
          std::lock_guard lock(completion_mutex);
          completions.push_back(std::move(command));
        }
        completion_changed.notify_all();
        return true;
      },
      [](const std::string&, std::uint64_t) { return true; },
      exact_client
    );
    const auto take_completion = [&] {
      std::unique_lock lock(completion_mutex);
      require(
        completion_changed.wait_for(
          lock, std::chrono::seconds(1), [&] { return !completions.empty(); }
        ),
        "exact-owner voice completion was not posted"
      );
      auto command = std::move(completions.front());
      completions.pop_front();
      return command;
    };

    exact_client->setBlocked(Client::Operation::Connect, true);
    auto equal_a = voiceCommand(
      syrnike::desktop_native::NativeCommandType::ConnectVoice,
      "equal-owner-a",
      70
    );
    exact_actor.connect(equal_a);
    exact_client->waitUntilPending(Client::Operation::Connect, 1);
    Client::Release failed_a;
    failed_a.error_message = "injected old equal-generation failure";
    exact_client->releaseNext(Client::Operation::Connect, std::move(failed_a));
    auto completion_a = take_completion();

    exact_client->setBlocked(Client::Operation::Connect, false);
    auto equal_b = equal_a;
    equal_b.request_id = "equal-owner-b";
    exact_actor.connect(equal_b);
    auto completion_b = take_completion();
    require(
      completion_a.internal_epoch != 0 &&
        completion_b.internal_epoch != 0 &&
        completion_a.internal_epoch != completion_b.internal_epoch,
      "equal-generation voice completions did not carry exact owner tokens"
    );
    exact_actor.handleWorkerCommand(completion_a);
    exact_actor.handleWorkerCommand(completion_b);
    require(
      exact_sink->waitReply("equal-owner-b", std::chrono::seconds(1)),
      "old equal-generation failure consumed the replacement completion"
    );

    auto transferred = equal_b;
    transferred.request_id = "equal-owner-transfer";
    exact_actor.connect(transferred);
    auto transferred_completion = take_completion();
    require(
      transferred_completion.internal_epoch != completion_b.internal_epoch,
      "same-generation reconnect reused its previous exact owner token"
    );
    exact_actor.handleWorkerCommand(transferred_completion);
    require(
      waitUntil(
        [&] {
          const auto status = exact_client->lifecycle().status(
            syrnike::desktop_native::media::SessionPortCall::current()
          );
          return !status.hasError() && status.value().value &&
            status.value().epoch.owner_token ==
              transferred_completion.internal_epoch;
        },
        std::chrono::seconds(1)
      ),
      "old cleanup retired the atomically transferred Room owner"
    );

    auto deadline_edge = transferred;
    deadline_edge.request_id = "deadline-edge-owner";
    exact_actor.connect(deadline_edge);
    auto deadline_completion = take_completion();
    deadline_completion.internal_message =
      "LiveKit voice connection deadline expired";
    deadline_completion.video_source = "native_operation_timeout";
    exact_actor.handleWorkerCommand(deadline_completion);
    require(
      waitUntil(
        [&] {
          return !syrnike::desktop_native::media::requireSessionPortValue(
            exact_client->lifecycle().status(
              syrnike::desktop_native::media::SessionPortCall::current()
            )
          );
        },
        std::chrono::seconds(1)
      ),
      "deadline-edge failure left its committed exact Room owner connected"
    );
    exact_actor.shutdown();
    require(
      waitUntil(
        [&] {
          return syrnike::desktop_native::CleanupSupervisor::instance()
            .snapshot().owned_jobs == cleanup_before_exact.owned_jobs;
        },
        std::chrono::seconds(1)
      ),
      "exact-owner completion cleanup retained a supervised job"
    );
  }

  {
    const auto cleanup_before_noncooperative =
      syrnike::desktop_native::CleanupSupervisor::instance().snapshot();
    auto blocked_lane_sink = std::make_shared<CollectingSink>();
    syrnike::desktop_native::SequencedEmitter blocked_lane_emitter(
      blocked_lane_sink
    );
    auto blocked_lane_client = std::make_shared<Client>();
    blocked_lane_client->setBlocked(Client::Operation::Connect, true);
    blocked_lane_client->setCancelPendingConnectOnDisconnect(false);
    syrnike::desktop_native::media::VoiceActor blocked_lane_actor(
      blocked_lane_emitter,
      [](syrnike::desktop_native::MediaCommand) { return true; },
      [](const std::string&, std::uint64_t) { return true; },
      blocked_lane_client
    );
    auto blocked_a = voiceCommand(
      syrnike::desktop_native::NativeCommandType::ConnectVoice,
      "noncooperative-a",
      80
    );
    blocked_lane_actor.connect(blocked_a);
    blocked_lane_client->waitUntilPending(Client::Operation::Connect, 1);

    auto blocked_b = blocked_a;
    blocked_b.request_id = "noncooperative-b";
    blocked_b.generation = 81;
    const auto supersede_started = std::chrono::steady_clock::now();
    blocked_lane_actor.connect(blocked_b);
    require(
      std::chrono::steady_clock::now() - supersede_started <
        std::chrono::milliseconds(250),
      "non-cooperative connect blocked superseding voice control"
    );
    blocked_lane_client->waitUntilPending(Client::Operation::Connect, 2);

    auto blocked_disconnect = blocked_b;
    blocked_disconnect.type =
      syrnike::desktop_native::NativeCommandType::DisconnectVoice;
    blocked_disconnect.request_id = "noncooperative-disconnect";
    const auto disconnect_started = std::chrono::steady_clock::now();
    blocked_lane_actor.disconnect(blocked_disconnect, true);
    require(
      std::chrono::steady_clock::now() - disconnect_started <
          std::chrono::milliseconds(250) &&
        blocked_lane_sink->waitReply(
          "noncooperative-disconnect", std::chrono::milliseconds(250)
        ),
      "non-cooperative connect blocked disconnect on the voice lane"
    );

    Client::Release cancelled_connect;
    cancelled_connect.bool_result = false;
    blocked_lane_client->releaseNext(
      Client::Operation::Connect, cancelled_connect
    );
    blocked_lane_client->releaseNext(
      Client::Operation::Connect, std::move(cancelled_connect)
    );
    require(
      waitUntil(
        [&] {
          return blocked_lane_client->pending(Client::Operation::Connect) == 0 &&
            syrnike::desktop_native::CleanupSupervisor::instance()
              .snapshot().owned_jobs ==
                cleanup_before_noncooperative.owned_jobs;
        },
        std::chrono::seconds(2)
      ),
      "supervised non-cooperative voice attempts retained worker handles"
    );
    blocked_lane_actor.shutdown();
  }

  {
    const auto cleanup_before_rejected_completion =
      syrnike::desktop_native::CleanupSupervisor::instance().snapshot();
    auto rejected_sink = std::make_shared<CollectingSink>();
    syrnike::desktop_native::SequencedEmitter rejected_emitter(rejected_sink);
    auto rejected_client = std::make_shared<Client>();
    syrnike::desktop_native::media::VoiceActor rejected_actor(
      rejected_emitter,
      [](syrnike::desktop_native::MediaCommand) { return false; },
      [](const std::string&, std::uint64_t) { return true; },
      rejected_client
    );
    auto rejected_connect = voiceCommand(
      syrnike::desktop_native::NativeCommandType::ConnectVoice,
      "rejected-completion",
      90
    );
    rejected_actor.connect(rejected_connect);
    require(
      waitUntil(
        [&] {
          return rejected_client->disconnectCallCount() == 1 &&
            !syrnike::desktop_native::media::requireSessionPortValue(
              rejected_client->lifecycle().status(
                syrnike::desktop_native::media::SessionPortCall::current()
              )
            );
        },
        std::chrono::seconds(1)
      ),
      "rejected voice completion retained its committed Room owner"
    );
    rejected_actor.shutdown();
    require(
      waitUntil(
        [&] {
          return syrnike::desktop_native::CleanupSupervisor::instance()
            .snapshot().owned_jobs ==
              cleanup_before_rejected_completion.owned_jobs;
        },
        std::chrono::seconds(1)
      ),
      "rejected voice completion retained supervised cleanup ownership"
    );
    require(
      rejected_client->disconnectCallCount() == 1,
      "rejected voice completion disconnected its exact owner more than once"
    );
  }

  auto sink = std::make_shared<CollectingSink>();
  auto client = std::make_shared<Client>();
  client->setBlocked(Client::Operation::Connect, true);
  auto runtime = std::make_unique<MediaRuntime>(sink, client);

  require(runtime->dispatch(voiceCommand(syrnike::desktop_native::NativeCommandType::ConnectVoice, "connect-a", 1)),
    "runtime rejected connect A");
  client->waitUntilPending(Client::Operation::Connect, 1);

  require(runtime->dispatch(voiceCommand(syrnike::desktop_native::NativeCommandType::DisconnectVoice, "disconnect-a", 2)),
    "runtime rejected disconnect A");
  require(sink->waitReply("disconnect-a", std::chrono::milliseconds(500)),
    "disconnect was blocked behind connect A");
  require(sink->waitFailedReply("connect-a", std::chrono::milliseconds(500)),
    "cancelled connect A did not settle its pending request");
  require(client->pending(Client::Operation::Connect) == 0,
    "disconnect did not cooperatively cancel connect A");

  client->setBlocked(Client::Operation::Connect, false);
  require(runtime->dispatch(voiceCommand(syrnike::desktop_native::NativeCommandType::ConnectVoice, "connect-b", 3)),
    "runtime rejected connect B");
  require(sink->waitReply("connect-b", std::chrono::seconds(2)),
    "connect B did not complete after stale A completion");
  require(syrnike::desktop_native::media::requireSessionPortValue(
      client->lifecycle().status(
        syrnike::desktop_native::media::SessionPortCall::current()
      )),
    "stale connect A completion disconnected or replaced Room B");

  std::chrono::steady_clock::duration longest_dispatch{};
  for (std::uint64_t reconnect = 0; reconnect < 50; ++reconnect) {
    const auto started = std::chrono::steady_clock::now();
    require(
      runtime->dispatch(voiceCommand(
        syrnike::desktop_native::NativeCommandType::ConnectVoice,
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
  auto& cleanup_supervisor =
    syrnike::desktop_native::CleanupSupervisor::instance();
  const auto cleanup_before_blocked_runtime = cleanup_supervisor.snapshot();
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
    [&] {
      if (subsystem_cleanup_launches.fetch_add(1) == 0) {
        throw std::runtime_error(
          "injected media runtime quarantine launch failure"
        );
      }
    },
    [&] {
      subsystem_cleanup_completions.fetch_add(1);
    }
  );
  blocked_runtime->waitUntilReady();
  syrnike::desktop_native::MediaCommand configure_microphone;
  configure_microphone.type = syrnike::desktop_native::NativeCommandType::ConfigureMicrophone;
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
      voiceCommand(syrnike::desktop_native::NativeCommandType::ConnectVoice, "blocked-voice-connect", 1)
    ),
    "runtime rejected blocked voice connect"
  );
  blocked_client->waitUntilPending(Client::Operation::Connect, 1);

  syrnike::desktop_native::MediaCommand shutdown_command;
  shutdown_command.type = syrnike::desktop_native::NativeCommandType::Shutdown;
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
  require(
    cleanup_supervisor.snapshot().owned_jobs >
      cleanup_before_blocked_runtime.owned_jobs,
    "blocked voice connect escaped CleanupSupervisor ownership"
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
  require(
    waitUntil(
      [&] {
        return cleanup_supervisor.snapshot().owned_jobs ==
          cleanup_before_blocked_runtime.owned_jobs;
      },
      std::chrono::seconds(2)
    ),
    "voice connect cleanup retained a supervised thread handle"
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
