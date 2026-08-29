#include <stdexcept>

#include "media/media_runtime_shutdown_order.hpp"
#include "media_contention_publication_teardown.hpp"

int main() try {
  using syrnike::desktop_native::media::MediaRuntimeShutdownStep;
  using syrnike::desktop_native::media::forEachMediaRuntimeShutdownStep;
  using syrnike::desktop_native::tests::ContentionPublicationTeardownGate;

  ContentionPublicationTeardownGate publication_gate;
  publication_gate.beginPublication();
  if (publication_gate.readyToShutdown(true)) {
    throw std::runtime_error(
        "held LiveKit publication allowed Room teardown");
  }

  ContentionPublicationTeardownGate start_ack_gate;
  if (!start_ack_gate.readyToShutdown(true) ||
      start_ack_gate.readyToShutdown(false)) {
    throw std::runtime_error(
        "publication teardown gate did not require start ACK and publish drain");
  }

  ContentionPublicationTeardownGate callback_gate;
  callback_gate.beginPublication();
  callback_gate.handoffPublicationToCallback();
  if (callback_gate.readyToShutdown(true)) {
    throw std::runtime_error(
        "publish-to-callback handoff exposed an unowned teardown window");
  }
  callback_gate.finishCallback();

  bool room_alive = true;
  bool screen_publication_active = true;
  bool screen_publication_cancelled = false;
  bool camera_stopped = false;
  bool microphone_stopped = false;
  bool blocked_microphone_worker = true;
  bool joined_after_owner_cancellation = false;

  forEachMediaRuntimeShutdownStep([&](MediaRuntimeShutdownStep step) {
    switch (step) {
      case MediaRuntimeShutdownStep::ShutdownScreen:
        if (!room_alive) {
          throw std::runtime_error(
              "screen publication cleanup ran after the shared Room closed");
        }
        if (publication_gate.pending(true) == 0) {
          throw std::runtime_error(
              "held publication disappeared before screen cancellation");
        }
        publication_gate.finishPublication();
        if (!publication_gate.readyToShutdown(true)) {
          throw std::runtime_error(
              "screen cancellation did not drain held publication ownership");
        }
        screen_publication_cancelled = true;
        screen_publication_active = false;
        break;
      case MediaRuntimeShutdownStep::ShutdownCamera:
        if (!room_alive) {
          throw std::runtime_error("camera cleanup ran after the shared Room closed");
        }
        camera_stopped = true;
        break;
      case MediaRuntimeShutdownStep::ShutdownPreviewAndMicrophone:
        if (!room_alive) {
          throw std::runtime_error(
              "microphone cleanup ran after the shared Room closed");
        }
        microphone_stopped = true;
        break;
      case MediaRuntimeShutdownStep::ShutdownVoice:
        if (screen_publication_active || !screen_publication_cancelled ||
            !camera_stopped || !microphone_stopped ||
            !publication_gate.readyToShutdown(true)) {
          throw std::runtime_error(
              "shared Room closed before dependent media owners drained");
        }
        room_alive = false;
        break;
      case MediaRuntimeShutdownStep::JoinMicrophoneWorkers:
        if (room_alive || !microphone_stopped) {
          throw std::runtime_error(
              "blocked microphone worker joined before Room gate closed");
        }
        blocked_microphone_worker = false;
        joined_after_owner_cancellation = true;
        break;
      default:
        if (step == MediaRuntimeShutdownStep::JoinVoiceWorkers ||
            step == MediaRuntimeShutdownStep::JoinScreenWorker ||
            step == MediaRuntimeShutdownStep::JoinCameraWorker ||
            step == MediaRuntimeShutdownStep::JoinQueryWorker) {
          if (room_alive) {
            throw std::runtime_error(
                "worker join ran before actor cancellation and Room shutdown");
          }
          joined_after_owner_cancellation = true;
        }
        break;
    }
  });

  if (room_alive) {
    throw std::runtime_error("shutdown plan did not close the shared Room");
  }
  if (blocked_microphone_worker || !joined_after_owner_cancellation) {
    throw std::runtime_error(
        "blocked worker was not joined after owner cancellation");
  }
  return 0;
} catch (const std::exception& error) {
  return error.what()[0] == '\0' ? 2 : 1;
}
