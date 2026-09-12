#pragma once

#include "audio/remote_audio_output.hpp"
#include "audio/remote_audio_tracks.hpp"

namespace syrnike::windows_media::audio {
struct OutputOwnerSnapshot {
  MediaPathSnapshot path;
  RemoteOutputStats output;
  std::shared_ptr<RenderedEchoReference> echo;
  bool stopped = true;
};

// Output device transactions have a separate control lane from microphone,
// Room and subscriptions. The mixer/track reader are shared lifetime ports.
class OutputOwner final {
 public:
  OutputOwner(AudioDeviceRegistry&, RemoteAudioMixerWorker&, RemoteAudioTracks&);
  ~OutputOwner();
  void apply(std::uint64_t revision, const OutputIntent&, bool room_connected,
             std::uint64_t device_revision);
  void beginStop();
  void stop();
  OutputOwnerSnapshot snapshot() const;
 private:
  struct Desired {
    std::uint64_t revision = 0, device_revision = 0;
    OutputIntent intent;
    bool room_connected = false;
  };
  void run() noexcept;
  AudioDeviceRegistry& devices_;
  RemoteAudioMixerWorker& mixer_;
  RemoteAudioTracks& tracks_;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable changed_;
  Desired desired_;
  std::stop_source selection_cancellation_;
  OutputOwnerSnapshot snapshot_;
  bool stopping_ = false, done_ = false;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
