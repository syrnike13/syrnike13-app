#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "common/event_sink.hpp"
#include "common/sequenced_emitter.hpp"
#include "media/microphone_actor.hpp"
#include "media/generation_fence.hpp"
#include "media/preview_actor.hpp"
#include "media/screen_actor.hpp"

namespace {

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    std::lock_guard lock(mutex_);
    events_.push_back(std::move(event));
    return true;
  }

  void close() override {}

  std::size_t size() const {
    std::lock_guard lock(mutex_);
    return events_.size();
  }

 private:
  mutable std::mutex mutex_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

template <typename Action>
void requireThrows(Action action, const char* message) {
  try {
    action();
  } catch (const std::exception&) {
    return;
  }
  throw std::runtime_error(message);
}

}  // namespace

int main() try {
  using namespace syrnike::desktop_native;
  using namespace syrnike::desktop_native::media;

  auto sink = std::make_shared<CollectingSink>();
  SequencedEmitter emitter(sink);
  auto post = [](MediaCommand) { return true; };
  GenerationFence microphone_intent;
  microphone_intent.advance("mic", 1);
  auto microphone_current = [&](const std::string& session_id, std::uint64_t generation) {
    return microphone_intent.isCurrent(session_id, generation);
  };
  MicrophoneActor microphone(emitter, post, microphone_current);
  MediaCommand invalid_microphone;
  invalid_microphone.type = "connectMicrophone";
  invalid_microphone.session_id = "mic";
  invalid_microphone.generation = 1;
  requireThrows(
    [&] { static_cast<void>(microphone.connect(invalid_microphone)); },
    "microphone actor accepted missing LiveKit credentials"
  );

  microphone_intent.advance("mic", 2);
  MediaCommand stale_disconnect;
  stale_disconnect.type = "disconnectMicrophone";
  stale_disconnect.session_id = "mic";
  stale_disconnect.generation = 1;
  requireThrows(
    [&] { microphone.disconnect(stale_disconnect); },
    "stale microphone disconnect reached actor state"
  );

  MediaCommand partial;
  partial.type = "configureMicrophone";
  partial.session_id = "mic";
  partial.generation = 2;
  partial.input_volume = 0.5f;
  partial.has_input_volume = true;
  microphone.configure(partial);
  microphone.disconnect(partial);
  microphone.disconnect(partial);
  microphone.handleTerminal(partial);
  microphone.shutdown();
  microphone.shutdown();

  GenerationFence screen_intent;
  screen_intent.advance("screen", 1);
  auto screen_current = [&](const std::string& session_id, std::uint64_t generation) {
    return screen_intent.isCurrent(session_id, generation);
  };
  ScreenActor screen(emitter, post, screen_current);
  MediaCommand invalid_screen;
  invalid_screen.type = "connectScreen";
  invalid_screen.session_id = "screen";
  invalid_screen.generation = 1;
  requireThrows(
    [&] { static_cast<void>(screen.connect(invalid_screen)); },
    "screen actor accepted missing LiveKit credentials"
  );
  screen_intent.advance("screen", 2);
  MediaCommand stale_screen_stop;
  stale_screen_stop.type = "stopScreenCapture";
  stale_screen_stop.session_id = "screen";
  stale_screen_stop.generation = 1;
  requireThrows(
    [&] { screen.stopCapture(stale_screen_stop); },
    "stale screen stop reached actor state"
  );
  MediaCommand idle_screen;
  idle_screen.type = "stopScreenCapture";
  idle_screen.session_id = "screen";
  idle_screen.generation = 2;
  screen.stopCapture(idle_screen);
  screen.stopCapture(idle_screen);
  screen.disconnect(invalid_screen);
  screen.handleTerminal(invalid_screen);
  screen.shutdown();
  screen.shutdown();

  PreviewActor preview(emitter);
  MediaCommand no_preview;
  preview.stop(no_preview);
  preview.stop(no_preview);
  preview.shutdown();
  preview.shutdown();

  if (sink->size() != 0) {
    throw std::runtime_error("idle actor lifecycle emitted phantom events");
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
