#pragma once

#include "audio/microphone_pipeline.hpp"
#include "audio/microphone_sender.hpp"

namespace syrnike::windows_media::audio {

struct MicrophoneOwnerSnapshot {
  MediaPathSnapshot path;
  MicrophonePipelineStats pipeline;
  MicrophoneSenderStats sender;
  bool publication_stopped = true;
  bool stopped = true;
};

// Product microphone control lane. One replaceable intent slot separates slow
// capture/publication transactions from Engine control and other media paths.
// The shared device registry and transport must outlive this joined owner.
class MicrophoneOwner final {
 public:
  MicrophoneOwner(AudioDeviceRegistry&, std::shared_ptr<LiveKitRoomTransport>);
  ~MicrophoneOwner();
  void apply(std::uint64_t revision, const MicrophoneIntent&,
             std::optional<std::uint64_t> room_generation,
             std::uint64_t device_revision, std::shared_ptr<EchoReferencePort>);
  void beginStop();
  void stop();
  MicrophoneOwnerSnapshot snapshot() const;
 private:
  struct Desired {
    std::uint64_t revision = 0, device_revision = 0, publication_epoch = 0;
    MicrophoneIntent intent;
    std::optional<std::uint64_t> room_generation;
    std::shared_ptr<EchoReferencePort> echo;
  };
  void run() noexcept;
  AudioDeviceRegistry& devices_;
  std::shared_ptr<LiveKitRoomTransport> transport_;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable changed_;
  Desired desired_;
  MicrophoneOwnerSnapshot snapshot_;
  // Only run() constructs/destroys the sender; apply() calls its thread-safe
  // cancellation signal under mutex_ so a superseded publish cannot commit.
  std::shared_ptr<MicrophoneSender> sender_;
  bool stopping_ = false, done_ = false;
  std::thread worker_;
};

}  // namespace syrnike::windows_media::audio
