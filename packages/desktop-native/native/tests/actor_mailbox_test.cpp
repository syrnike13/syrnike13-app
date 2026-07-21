#include <atomic>
#include <barrier>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <string>
#include <thread>

#include "media/actor_mailbox.hpp"
#include "media/lifetime_safe_frame_release.hpp"

namespace {

using syrnike::desktop_native::MediaCommand;
using syrnike::desktop_native::RuntimeEvent;
using syrnike::desktop_native::media::ActorCommandResourceGuard;
using syrnike::desktop_native::media::ActorMailbox;
using syrnike::desktop_native::media::LifetimeSafeFrameRelease;

void require(bool condition, const char* message) {
  if (condition) return;
  std::cerr << message << '\n';
  std::exit(1);
}

MediaCommand frame(
  std::string type,
  std::string session,
  std::uint64_t generation,
  std::string track,
  std::uint64_t sequence,
  std::function<void()> on_drop
) {
  MediaCommand command;
  command.type = std::move(type);
  command.session_id = std::move(session);
  command.generation = generation;
  command.track_id = std::move(track);
  command.frame_sequence = sequence;
  command.on_drop = std::move(on_drop);
  return command;
}

}  // namespace

int main() {
  {
    ActorMailbox<4, 2> mailbox;
    int released = 0;
    require(mailbox.tryPush(frame(
      "__remoteVideoFrame", "voice", 7, "track-a", 1, [&] { ++released; }
    )), "first remote frame should be accepted");
    require(mailbox.tryPush(frame(
      "__remoteVideoFrame", "voice", 7, "track-a", 2, [&] { ++released; }
    )), "replacement remote frame should be accepted");
    require(released == 1, "displaced frame must be released exactly once");

    require(mailbox.tryPush(frame(
      "__remoteVideoFrame", "voice", 7, "track-b", 3, [&] { ++released; }
    )), "second media key should be accepted");
    MediaCommand terminal;
    terminal.type = "__voiceTerminal";
    require(mailbox.tryPush(std::move(terminal)), "terminal must not compete with media capacity");

    auto first = mailbox.waitPop();
    require(first && first->type == "__voiceTerminal", "control must have priority over saturated media");
    auto second = mailbox.waitPop();
    auto third = mailbox.waitPop();
    require(second && third, "latest frame for every media key must remain queued");
    require(
      second->frame_sequence + third->frame_sequence == 5,
      "mailbox must retain only the latest frame per remote track"
    );
    second->on_drop();
    third->on_drop();
    require(released == 3, "consumed frame ownership must remain exact");
    mailbox.closeAndDiscard();
    require(released == 3, "close must not release already-consumed frames");
  }

  {
    ActorMailbox<2, 2> mailbox;
    int released = 0;
    require(mailbox.tryPush(frame(
      "__localScreenPreviewFrame", "screen-a", 1, {}, 1, [&] { ++released; }
    )), "first screen preview should be accepted");
    require(mailbox.tryPush(frame(
      "__localScreenPreviewFrame", "screen-b", 1, {}, 2, [&] { ++released; }
    )), "second screen preview should be accepted");
    require(mailbox.tryPush(frame(
      "__localCameraPreviewFrame", "camera", 3, "old-track", 3, [&] { ++released; }
    )), "new preview key should evict the oldest media key");
    require(released == 1, "media-key eviction must release its frame once");
    require(mailbox.tryPush(frame(
      "__localCameraPreviewFrame", "camera", 3, "new-track", 4, [&] { ++released; }
    )), "camera preview should coalesce by session and generation");
    require(released == 2, "replaced camera preview must release the prior handle");
    require(mailbox.closeAndDiscard() == 2, "close must discard the remaining media slots");
    require(released == 4, "close must release every accepted queued handle exactly once");
  }

  {
    ActorMailbox<1, 1> mailbox;
    MediaCommand control;
    control.type = "connectVoice";
    require(mailbox.tryPush(control), "control capacity should accept its first command");
    MediaCommand terminal;
    terminal.type = "__voiceTerminal";
    require(!mailbox.tryPush(terminal), "control overflow must be visible to fail-closed caller");

    int released = 0;
    require(mailbox.tryPush(frame(
      "__remoteVideoFrame", "voice", 1, "track", 1, [&] { ++released; }
    )), "media lane must remain independent from full control lane");
    require(mailbox.closeAndDiscard() == 2, "close should discard queued control and media");
    require(released == 1, "close must release accepted media with full control lane");

    auto rejected = frame(
      "__remoteVideoFrame", "voice", 1, "track", 2, [&] { ++released; }
    );
    require(!mailbox.tryPush(std::move(rejected)), "closed mailbox must reject new media");
    require(released == 1, "rejected post must leave ownership with producer");
    ++released;
    require(released == 2, "producer can release a rejected frame exactly once");
  }

  {
    constexpr std::uint64_t frame_count = 10'000;
    ActorMailbox<8, 2> mailbox;
    std::atomic_uint64_t released{0};
    std::barrier start{3};
    std::thread media_producer([&] {
      start.arrive_and_wait();
      for (std::uint64_t sequence = 1; sequence <= frame_count; ++sequence) {
        const auto track = sequence % 2 == 0 ? "track-a" : "track-b";
        require(mailbox.tryPush(frame(
          "__remoteVideoFrame",
          "voice",
          9,
          track,
          sequence,
          [&] { released.fetch_add(1); }
        )), "frame flood should coalesce without filling the control lane");
      }
    });
    std::thread control_producer([&] {
      start.arrive_and_wait();
      MediaCommand terminal;
      terminal.type = "__voiceTerminal";
      require(mailbox.tryPush(std::move(terminal)), "terminal must survive concurrent frame flood");
      MediaCommand disconnect;
      disconnect.type = "disconnectVoice";
      require(mailbox.tryPush(std::move(disconnect)), "disconnect must survive concurrent frame flood");
    });
    start.arrive_and_wait();
    media_producer.join();
    control_producer.join();

    std::atomic_int in_handler{0};
    std::atomic_int max_handler_concurrency{0};
    std::thread actor_worker([&] {
      for (int index = 0; index < 4; ++index) {
        auto command = mailbox.waitPop();
        require(command.has_value(), "actor worker lost a queued command");
        const auto current = in_handler.fetch_add(1) + 1;
        auto observed = max_handler_concurrency.load();
        while (
          observed < current &&
          !max_handler_concurrency.compare_exchange_weak(observed, current)
        ) {}
        if (index == 0) {
          require(command->type == "__voiceTerminal", "terminal must run before coalesced frames");
        } else if (index == 1) {
          require(command->type == "disconnectVoice", "control FIFO must remain ordered");
        } else {
          require(command->on_drop != nullptr, "only latest media frames should remain after controls");
          command->on_drop();
        }
        in_handler.fetch_sub(1);
      }
    });
    actor_worker.join();
    require(max_handler_concurrency.load() == 1, "one actor worker must serialize every handler");
    require(
      released.load() == frame_count,
      "concurrent coalescing must release every displaced and consumed frame exactly once"
    );
    mailbox.closeAndDiscard();
  }

  {
    ActorMailbox<2, 1> mailbox;
    int released = 0;
    require(mailbox.tryPush(frame(
      "__remoteVideoFrame", "voice", 2, "track", 1, [&] { ++released; }
    )), "throw-path frame should be accepted");
    auto throwing = mailbox.waitPop();
    try {
      ActorCommandResourceGuard guard(*throwing);
      throw std::runtime_error("synthetic handler failure");
    } catch (const std::runtime_error&) {}
    require(released == 1, "handler exception must release the popped frame once");

    require(mailbox.tryPush(frame(
      "__remoteVideoFrame", "voice", 2, "track", 2, [&] { ++released; }
    )), "success-path frame should be accepted");
    auto successful = mailbox.waitPop();
    RuntimeEvent event;
    {
      ActorCommandResourceGuard guard(*successful);
      event.on_drop = std::move(successful->on_drop);
    }
    require(released == 1, "successful transfer must disarm the command guard");
    event.on_drop();
    event.on_drop = {};
    require(released == 2, "event drop must release transferred ownership once");
    mailbox.closeAndDiscard();
  }

  {
    ActorMailbox<4, 4> mailbox;
    int released = 0;
    require(mailbox.tryPush(frame(
      "__remoteVideoFrame", "voice", 11, "track", 1, [&] { ++released; }
    )), "pre-terminal frame should be accepted");
    MediaCommand speakers;
    speakers.type = "__voiceActiveSpeakers";
    speakers.session_id = "voice";
    speakers.generation = 11;
    require(mailbox.tryPush(std::move(speakers)), "pre-terminal telemetry should be accepted");
    MediaCommand terminal;
    terminal.type = "__voiceTerminal";
    terminal.session_id = "voice";
    terminal.generation = 11;
    require(mailbox.tryPush(std::move(terminal)), "terminal should be accepted");
    auto observed_terminal = mailbox.waitPop();
    require(
      observed_terminal && observed_terminal->type == "__voiceTerminal",
      "terminal must be observed before media from its epoch"
    );
    require(
      mailbox.discardMedia("voice", 11) == 2,
      "terminal retirement must purge every pending media item for its epoch"
    );
    require(released == 1, "terminal purge must release the queued frame exactly once");
    require(mailbox.size() == 0, "no media from a terminal epoch may remain observable");
    mailbox.closeAndDiscard();
  }

  {
    std::atomic_int releases{0};
    std::barrier handler_entered{2};
    std::barrier handler_may_return{2};
    auto router = std::make_shared<LifetimeSafeFrameRelease>(
      [&](const std::string&, std::uint64_t) {
        releases.fetch_add(1);
        handler_entered.arrive_and_wait();
        handler_may_return.arrive_and_wait();
      }
    );
    auto late_release = [router] { router->release("track", 7); };
    std::thread active_release(late_release);
    handler_entered.arrive_and_wait();
    std::thread detach([&] { router->detach(); });
    handler_may_return.arrive_and_wait();
    active_release.join();
    detach.join();
    late_release();
    require(releases.load() == 1, "release after bridge detach must be a safe no-op");
  }

  return 0;
}
