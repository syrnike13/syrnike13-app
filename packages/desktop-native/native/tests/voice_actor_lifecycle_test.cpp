#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "common/event_sink.hpp"
#include "media/livekit_publication_client.hpp"
#include "media/media_runtime.hpp"

namespace {

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

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
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
  using Client = syrnike::desktop_native::media::DeterministicFakeLiveKitPublicationClient;
  using syrnike::desktop_native::media::MediaRuntime;

  auto sink = std::make_shared<CollectingSink>();
  auto client = std::make_shared<Client>();
  client->setBlocked(Client::Operation::Connect, true);
  MediaRuntime runtime(sink, client);

  require(runtime.dispatch(voiceCommand("connectVoice", "connect-a", 1)),
    "runtime rejected connect A");
  client->waitUntilPending(Client::Operation::Connect, 1);

  require(runtime.dispatch(voiceCommand("disconnectVoice", "disconnect-a", 2)),
    "runtime rejected disconnect A");
  require(sink->waitReply("disconnect-a", std::chrono::milliseconds(500)),
    "disconnect was blocked behind connect A");
  require(sink->waitFailedReply("connect-a", std::chrono::milliseconds(500)),
    "cancelled connect A did not settle its pending request");
  require(client->pending(Client::Operation::Connect) == 0,
    "disconnect did not cooperatively cancel connect A");

  client->setBlocked(Client::Operation::Connect, false);
  require(runtime.dispatch(voiceCommand("connectVoice", "connect-b", 3)),
    "runtime rejected connect B");
  require(sink->waitReply("connect-b", std::chrono::seconds(2)),
    "connect B did not complete after stale A completion");
  require(client->isVoiceConnected(),
    "stale connect A completion disconnected or replaced Room B");

  runtime.requestShutdown();
  runtime.shutdownAndWait();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
