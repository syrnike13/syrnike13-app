#include <chrono>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "common/event_sink.hpp"
#include "common/sequenced_emitter.hpp"
#include "media/generation_fence.hpp"
#include "media/livekit_publication_client.hpp"
#include "media/microphone_publication_controller.hpp"

namespace {

using namespace std::chrono_literals;

// Event predicates decide success; this deadline only terminates a stalled test.
constexpr auto kTestWatchdog = 15s;

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    {
      std::lock_guard lock(mutex_);
      events_.push_back(std::move(event));
    }
    changed_.notify_all();
    return true;
  }

  void close() override {}

  syrnike::desktop_native::RuntimeEvent waitReply(
      const std::string &request_id,
      std::chrono::milliseconds timeout = kTestWatchdog) {
    std::unique_lock lock(mutex_);
    const bool found = changed_.wait_for(lock, timeout, [&] {
      for (const auto &event : events_) {
        if (event.type == "reply" && event.request_id == request_id)
          return true;
      }
      return false;
    });
    if (!found) {
      throw std::runtime_error(
          "timed out waiting for runtime reply: " + request_id);
    }
    for (const auto &event : events_) {
      if (event.type == "reply" && event.request_id == request_id) return event;
    }
    throw std::runtime_error("runtime reply disappeared");
  }

  std::size_t countReplies(const std::string &request_id) {
    std::lock_guard lock(mutex_);
    std::size_t count = 0;
    for (const auto &event : events_) {
      if (event.type == "reply" && event.request_id == request_id) count += 1;
    }
    return count;
  }

  std::size_t countSessionStarted(const std::string &session_id,
                                  std::uint64_t generation) {
    std::lock_guard lock(mutex_);
    std::size_t count = 0;
    for (const auto &event : events_) {
      if (event.type == "sessionStarted" && event.session_id == session_id &&
          event.generation == generation) {
        count += 1;
      }
    }
    return count;
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

void require(bool condition, const char *message) {
  if (!condition) throw std::runtime_error(message);
}

syrnike::desktop_native::MediaCommand connectCommand(std::string request_id,
                                                     std::string session_id,
                                                     std::uint64_t generation) {
  syrnike::desktop_native::MediaCommand command;
  command.type = "connectMicrophone";
  command.request_id = std::move(request_id);
  command.session_id = std::move(session_id);
  command.generation = generation;
  command.livekit_url = "wss://livekit.example";
  command.livekit_token = "token";
  command.participant_identity = "user:desktop-native:microphone";
  command.audio_bitrate = 64'000;
  command.muted = false;
  return command;
}

class DeferredCommands {
 public:
  bool post(syrnike::desktop_native::MediaCommand command) {
    {
      std::lock_guard lock(mutex_);
      commands_.push_back(std::move(command));
    }
    changed_.notify_all();
    return true;
  }

  syrnike::desktop_native::MediaCommand waitTake(
      const std::string &type,
      std::chrono::milliseconds timeout = kTestWatchdog) {
    std::unique_lock lock(mutex_);
    const bool found = changed_.wait_for(lock, timeout, [&] {
      for (const auto &command : commands_) {
        if (command.type == type) return true;
      }
      return false;
    });
    if (!found) {
      throw std::runtime_error(
          "timed out waiting for deferred native command: " + type);
    }
    for (auto it = commands_.begin(); it != commands_.end(); ++it) {
      if (it->type != type) continue;
      auto command = std::move(*it);
      commands_.erase(it);
      return command;
    }
    throw std::runtime_error("deferred native command disappeared");
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<syrnike::desktop_native::MediaCommand> commands_;
};

}  // namespace

int main() try {
  using syrnike::desktop_native::MediaCommand;
  using syrnike::desktop_native::SequencedEmitter;
  using syrnike::desktop_native::media::
      DeterministicFakeLiveKitPublicationClient;
  using syrnike::desktop_native::media::GenerationFence;
  using syrnike::desktop_native::media::MicrophonePipelineSnapshot;
  using syrnike::desktop_native::media::MicrophonePublicationCapacityStatus;
  using syrnike::desktop_native::media::MicrophonePublicationController;

  require(livekit::initialize(livekit::LogLevel::Off),
          "failed to initialize LiveKit test runtime");

  {
    auto sink = std::make_shared<CollectingSink>();
    SequencedEmitter emitter(sink);
    DeferredCommands deferred;
    GenerationFence desired;
    auto livekit =
        std::make_shared<DeterministicFakeLiveKitPublicationClient>();
    MicrophonePublicationController controller(
        emitter,
        [&](MediaCommand command) { return deferred.post(std::move(command)); },
        [&](const std::string &session_id, std::uint64_t generation) {
          return desired.isCurrent(session_id, generation);
        },
        [](const auto &) {}, [](const auto &) {}, [] { return true; }, livekit);
    const auto handle_worker = [&](const std::string &type) {
      controller.handleWorkerCommand(deferred.waitTake(type));
    };

    auto connect_a = connectCommand("connect-a", "mic-a", 1);
    require(desired.advance("mic-a", 1),
            "initial microphone generation was rejected");
    controller.start(connect_a, MicrophonePipelineSnapshot{});
    handle_worker("__microphoneAttemptReady");
    const auto connect_a_reply = sink->waitReply("connect-a");
    require(connect_a_reply.ok, "initial microphone connect failed");

    livekit->setBlocked(
        DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);
    auto connect_b = connectCommand("connect-b", "mic-b", 2);
    require(desired.advance("mic-b", 2),
            "new microphone generation was rejected");
    controller.start(connect_b, MicrophonePipelineSnapshot{});
    livekit->waitUntilPending(
        DeterministicFakeLiveKitPublicationClient::Operation::Connect, 1,
        kTestWatchdog);

    require(!desired.advance("mic-a", 1),
            "generation fence accepted a stale disconnect");
    require(
        livekit->pending(
            DeterministicFakeLiveKitPublicationClient::Operation::Connect) == 1,
        "stale disconnect cancelled the newer connect worker");

    require(controller.capacityStatus() ==
                MicrophonePublicationCapacityStatus::ActorBusy,
            "blocked connect did not expose occupied microphone capacity");

    auto return_to_a = connectCommand("return-a-while-b-blocked", "mic-a", 3);
    require(desired.advance("mic-a", 3), "new return generation was rejected");
    controller.start(return_to_a, MicrophonePipelineSnapshot{});
    const auto return_reply = sink->waitReply("return-a-while-b-blocked");
    require(!return_reply.ok,
            "a second candidate started while B was still blocked");
    require(return_reply.error && return_reply.error->code == "actor_busy",
            "bounded candidate rejection did not report actor_busy");
    require(
        livekit->pending(
            DeterministicFakeLiveKitPublicationClient::Operation::Connect) == 1,
        "A to B to A spawned more than one blocking connect worker");

    livekit->releaseNext(
        DeterministicFakeLiveKitPublicationClient::Operation::Connect);
    handle_worker("__microphoneAttemptFailed");
    const auto reply_b = sink->waitReply("connect-b");
    require(!reply_b.ok, "superseded blocked connect resolved as success");
    require(reply_b.error && reply_b.error->code == "stale_generation",
            "superseded blocked connect did not fail as stale_generation");
    require(sink->countSessionStarted("mic-b", 2) == 0,
            "superseded blocked connect promoted a candidate session");

    livekit->setBlocked(
        DeterministicFakeLiveKitPublicationClient::Operation::Connect, false);
    livekit->setBlocked(
        DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
    auto connect_c = connectCommand("connect-c", "mic-c", 4);
    require(desired.advance("mic-c", 4),
            "blocked publish generation was rejected");
    controller.start(connect_c, MicrophonePipelineSnapshot{});
    livekit->waitUntilPending(
        DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1,
        kTestWatchdog);

    MediaCommand mute_a;
    mute_a.type = "setMicrophoneMuted";
    mute_a.request_id = "mute-a";
    mute_a.session_id = "mic-a";
    mute_a.generation = 1;
    mute_a.muted = true;
    controller.setMuted(mute_a);

    require(desired.advance("mic-c", 5),
            "publish invalidation generation was rejected");
    livekit->releaseNext(
        DeterministicFakeLiveKitPublicationClient::Operation::Publish);
    handle_worker("__microphoneAttemptFailed");
    const auto reply_c = sink->waitReply("connect-c");
    require(!reply_c.ok && reply_c.error &&
                reply_c.error->code == "stale_generation",
            "invalidated blocked publish did not fail as stale_generation");
    require(sink->countSessionStarted("mic-c", 4) == 0,
            "invalidated candidate promoted after its late publish completion");

    livekit->setBlocked(
        DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, true);
    MediaCommand disconnect_a;
    disconnect_a.type = "disconnectMicrophone";
    disconnect_a.request_id = "disconnect-a";
    disconnect_a.session_id = "mic-a";
    disconnect_a.generation = 6;
    require(desired.advance("mic-a", 6),
            "microphone disconnect generation was rejected");
    controller.disconnect(disconnect_a);
    livekit->waitUntilPending(
        DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, 1,
        kTestWatchdog);
    require(controller.capacityStatus() ==
                MicrophonePublicationCapacityStatus::ActorBusy,
            "blocked disconnect did not expose occupied microphone capacity");

    livekit->setBlocked(
        DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);
    auto connect_d = connectCommand("connect-d-during-retire", "mic-d", 7);
    require(desired.advance("mic-d", 7),
            "bounded retire generation was rejected");
    controller.start(connect_d, MicrophonePipelineSnapshot{});
    const auto reply_d = sink->waitReply("connect-d-during-retire");
    require(!reply_d.ok && reply_d.error && reply_d.error->code == "actor_busy",
            "new candidate was not rejected while disconnect capacity was "
            "occupied");
    require(
        livekit->pending(
            DeterministicFakeLiveKitPublicationClient::Operation::Connect) == 0,
        "blocked retirement spawned another LiveKit connect worker");

    livekit->releaseNext(
        DeterministicFakeLiveKitPublicationClient::Operation::Disconnect);
    handle_worker("__microphoneRetireDone");
    livekit->setBlocked(
        DeterministicFakeLiveKitPublicationClient::Operation::Connect, false);
    controller.shutdown();
  }

  {
      {
        auto terminal_sink = std::make_shared<CollectingSink>();
        SequencedEmitter terminal_emitter(terminal_sink);
        DeferredCommands terminal_deferred;
        GenerationFence terminal_desired;
        auto terminal_livekit =
            std::make_shared<DeterministicFakeLiveKitPublicationClient>();
        MicrophonePublicationController terminal_controller(
            terminal_emitter,
            [&](MediaCommand command) {
              return terminal_deferred.post(std::move(command));
            },
            [&](const std::string &session_id, std::uint64_t generation) {
              return terminal_desired.isCurrent(session_id, generation);
            },
            [](const auto &) {}, [](const auto &) {}, [] { return true; },
            terminal_livekit);

        terminal_desired.advance("mic-terminal", 1);
        terminal_livekit->setBlocked(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish,
            true);
        auto terminal_candidate =
            connectCommand("connect-terminal-candidate", "mic-terminal", 1);
        terminal_controller.start(terminal_candidate,
                                  MicrophonePipelineSnapshot{});
        terminal_livekit->waitUntilPending(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish,
            1,
            kTestWatchdog);

        MediaCommand terminal;
        terminal.type = "__microphoneTerminal";
        terminal.session_id = "mic-terminal";
        terminal.generation = 1;
        terminal.internal_message =
            "candidate disconnected while publish was blocked";
        terminal_controller.handleTerminal(terminal);
        const auto terminal_reply =
            terminal_sink->waitReply("connect-terminal-candidate");
        require(
            !terminal_reply.ok && terminal_reply.error &&
                terminal_reply.error->code == "microphone_runtime_lost",
            "candidate terminal did not emit an immediate terminal outcome");
        require(terminal_livekit->pending(
                    DeterministicFakeLiveKitPublicationClient::Operation::
                        Publish) == 1,
                "candidate terminal waited for blocked publish to return");

        terminal_livekit->releaseNext(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish);
        terminal_controller.handleWorkerCommand(
            terminal_deferred.waitTake("__microphoneAttemptFailed"));
        require(terminal_sink->countReplies("connect-terminal-candidate") == 1,
                "late terminal candidate completion emitted a duplicate reply");
        require(terminal_sink->countSessionStarted("mic-terminal", 1) == 0,
                "terminal candidate promoted after late publish completion");
        require(!terminal_controller.hasBlockedCapacity(),
                "terminal candidate retained attempt capacity");

        terminal_livekit->setBlocked(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish,
            false);
        terminal_desired.advance("mic-ready-before-newer-intent", 2);
        auto ready_before_newer =
            connectCommand("connect-ready-before-newer-intent",
                           "mic-ready-before-newer-intent", 2);
        terminal_controller.start(ready_before_newer,
                                  MicrophonePipelineSnapshot{});
        auto stale_ready =
            terminal_deferred.waitTake("__microphoneAttemptReady");
        terminal_desired.advance("mic-newer-intent", 3);
        terminal_controller.handleWorkerCommand(stale_ready);
        const auto stale_ready_reply = terminal_sink->waitReply(
            "connect-ready-before-newer-intent");
        require(
            !stale_ready_reply.ok && stale_ready_reply.error &&
                stale_ready_reply.error->code == "stale_generation",
            "actor promoted a candidate after the generation fence advanced");
        require(terminal_sink->countSessionStarted(
                    "mic-ready-before-newer-intent", 2) == 0,
                "stale ready completion emitted sessionStarted");
        terminal_controller.handleWorkerCommand(
            terminal_deferred.waitTake("__microphoneRetireDone"));
        terminal_controller.shutdown();
      }

      {
        auto tracking_sink = std::make_shared<CollectingSink>();
        SequencedEmitter tracking_emitter(tracking_sink);
        DeferredCommands tracking_deferred;
        GenerationFence tracking_desired;
        auto tracking_livekit =
            std::make_shared<DeterministicFakeLiveKitPublicationClient>();
        bool applied_muted = false;
        std::size_t mute_applications = 0;
        MicrophonePublicationController tracking_controller(
            tracking_emitter,
            [&](MediaCommand command) {
              return tracking_deferred.post(std::move(command));
            },
            [&](const std::string &session_id, std::uint64_t generation) {
              return tracking_desired.isCurrent(session_id, generation);
            },
            [](const auto &) {}, [](const auto &) {}, [] { return true; },
            tracking_livekit,
            [&](const auto &, bool muted) {
              applied_muted = muted;
              mute_applications += 1;
            });

        tracking_desired.advance("mic-mute-race", 1);
        tracking_livekit->setBlocked(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish,
            true);
        auto muted_candidate =
            connectCommand("connect-muted-candidate", "mic-mute-race", 1);
        tracking_controller.start(muted_candidate,
                                  MicrophonePipelineSnapshot{});
        tracking_livekit->waitUntilPending(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish,
            1,
            kTestWatchdog);
        tracking_livekit->releaseNext(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish);
        auto ready = tracking_deferred.waitTake("__microphoneAttemptReady");
        require(tracking_controller.hasBlockedCapacity(),
                "candidate slot was not reported as occupied");
        require(tracking_controller.capacityStatus() ==
                    MicrophonePublicationCapacityStatus::ActorBusy,
                "fresh candidate was not reported as actor_busy");
        require(
            tracking_controller.capacityStatus(
                std::chrono::steady_clock::now() + std::chrono::seconds(21)) ==
                MicrophonePublicationCapacityStatus::ActorUnresponsive,
            "expired candidate was not reported as actor_unresponsive");

        MediaCommand mute_candidate;
        mute_candidate.type = "setMicrophoneMuted";
        mute_candidate.session_id = "mic-mute-race";
        mute_candidate.generation = 1;
        mute_candidate.muted = true;
        tracking_controller.setMuted(mute_candidate);
        tracking_controller.handleWorkerCommand(ready);
        require(tracking_sink->waitReply("connect-muted-candidate").ok,
                "candidate did not promote after deferred ready handling");
        require(mute_applications == 1 && applied_muted,
                "latest candidate mute was lost at promotion");
        require(!tracking_controller.hasBlockedCapacity(),
                "promoted candidate kept attempt capacity occupied");

        tracking_desired.advance("mic-mute-race", 2);
        MediaCommand disconnect_muted;
        disconnect_muted.type = "disconnectMicrophone";
        disconnect_muted.session_id = "mic-mute-race";
        disconnect_muted.generation = 2;
        tracking_controller.disconnect(disconnect_muted, false);
        require(tracking_controller.hasBlockedCapacity(),
                "retirement slot was not reported as occupied");
        auto finished_retire =
            tracking_deferred.waitTake("__microphoneRetireDone");

        tracking_livekit->setBlocked(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish,
            false);
        tracking_desired.advance("mic-after-finished-retire", 3);
        auto after_retire = connectCommand("connect-after-finished-retire",
                                           "mic-after-finished-retire", 3);
        tracking_controller.start(after_retire, MicrophonePipelineSnapshot{});
        auto next_ready =
            tracking_deferred.waitTake("__microphoneAttemptReady");
        tracking_controller.handleWorkerCommand(next_ready);
        require(
            tracking_sink->waitReply("connect-after-finished-retire").ok,
            "finished retire slot was not reaped before the next candidate");
        tracking_controller.handleWorkerCommand(finished_retire);

        tracking_desired.advance("mic-after-finished-retire", 4);
        MediaCommand disconnect_next;
        disconnect_next.type = "disconnectMicrophone";
        disconnect_next.session_id = "mic-after-finished-retire";
        disconnect_next.generation = 4;
        tracking_controller.disconnect(disconnect_next, false);
        tracking_controller.handleWorkerCommand(
            tracking_deferred.waitTake("__microphoneRetireDone"));
        require(!tracking_controller.hasBlockedCapacity(),
                "finished controller retained blocked capacity");
        tracking_controller.shutdown();
      }

      {
        auto privacy_sink = std::make_shared<CollectingSink>();
        SequencedEmitter privacy_emitter(privacy_sink);
        DeferredCommands privacy_deferred;
        GenerationFence privacy_desired;
        auto privacy_livekit =
            std::make_shared<DeterministicFakeLiveKitPublicationClient>();
        std::size_t attached_sources = 0;
        std::size_t privacy_mute_applications = 0;
        bool latest_applied_mute = false;
        MicrophonePublicationController privacy_controller(
            privacy_emitter,
            [&](MediaCommand command) {
              return privacy_deferred.post(std::move(command));
            },
            [&](const std::string &session_id, std::uint64_t generation) {
              return privacy_desired.isCurrent(session_id, generation);
            },
            [&](const auto &) { attached_sources += 1; },
            [&](const auto &) { attached_sources -= 1; },
            [] { return true; }, privacy_livekit,
            [&](const auto &, bool muted) {
              latest_applied_mute = muted;
              privacy_mute_applications += 1;
            });

        privacy_desired.advance("mic-privacy", 1);
        auto initial = connectCommand("privacy-initial", "mic-privacy", 1);
        privacy_controller.start(initial, MicrophonePipelineSnapshot{});
        auto initial_ready =
            privacy_deferred.waitTake("__microphoneAttemptReady");
        require(attached_sources == 0,
                "candidate received PCM before publication acknowledgement");
        privacy_controller.handleWorkerCommand(initial_ready);
        require(privacy_sink->waitReply("privacy-initial").ok,
                "initial privacy microphone did not promote");
        require(attached_sources == 1,
                "promoted microphone source was not attached");
        require(privacy_mute_applications == 1 && !latest_applied_mute,
                "initial unmuted state was not applied to the published track");
        privacy_livekit->setBlocked(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish,
            true);
        privacy_desired.advance("mic-privacy", 2);
        auto candidate =
            connectCommand("privacy-candidate", "mic-privacy", 2);
        privacy_controller.start(candidate, MicrophonePipelineSnapshot{});
        privacy_livekit->waitUntilPending(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish,
            1,
            kTestWatchdog);
        require(attached_sources == 1,
                "make-before-break candidate received PCM before commit");

        MediaCommand stale_privacy_disconnect;
        stale_privacy_disconnect.type = "disconnectMicrophone";
        stale_privacy_disconnect.session_id = "mic-privacy";
        stale_privacy_disconnect.generation = 1;
        bool stale_disconnect_rejected = false;
        try {
          privacy_controller.disconnect(stale_privacy_disconnect, false);
        } catch (const std::exception &) {
          stale_disconnect_rejected = true;
        }
        require(stale_disconnect_rejected,
                "stale disconnect was allowed to cancel the newer candidate");

        MediaCommand mute_during_move;
        mute_during_move.type = "setMicrophoneMuted";
        mute_during_move.session_id = "mic-privacy";
        mute_during_move.generation = 1;
        mute_during_move.muted = true;
        privacy_controller.setMuted(mute_during_move);

        privacy_livekit->releaseNext(
            DeterministicFakeLiveKitPublicationClient::Operation::Publish);
        auto candidate_ready =
            privacy_deferred.waitTake("__microphoneAttemptReady");
        privacy_controller.handleWorkerCommand(candidate_ready);
        require(privacy_sink->waitReply("privacy-candidate").ok,
                "candidate did not promote after old-generation mute");
        require(latest_applied_mute,
                "old-generation logical mute was lost during promotion");
        require(privacy_mute_applications == 2,
                "candidate mute state was not applied exactly once at promotion");
        require(attached_sources == 1,
                "promotion left more than one PCM sink attached");

        privacy_controller.handleWorkerCommand(
            privacy_deferred.waitTake("__microphoneRetireDone"));
        privacy_desired.advance("mic-privacy", 3);
        MediaCommand privacy_disconnect;
        privacy_disconnect.type = "disconnectMicrophone";
        privacy_disconnect.session_id = "mic-privacy";
        privacy_disconnect.generation = 3;
        privacy_controller.disconnect(privacy_disconnect, false);
        privacy_controller.handleWorkerCommand(
            privacy_deferred.waitTake("__microphoneRetireDone"));
        require(privacy_livekit->unpublishedPublicationSids().size() == 2,
                "shared Room retained a microphone publication after retirement");
        privacy_controller.shutdown();
      }
    }

  livekit::shutdown();
  return 0;
} catch (const std::exception &error) {
  std::cerr << error.what() << '\n';
  livekit::shutdown();
  return 1;
}
