#pragma once

#include "audio/audio_device_registry.hpp"
#include "audio/remote_audio_mix.hpp"
#include "audio/remote_speaker_activity.hpp"
#include "audio/rendered_echo_reference.hpp"
#include "livekit/livekit_room_transport.hpp"

#include <array>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace syrnike::windows_media::audio {
struct RemoteAudioPlayoutStats {
  std::uint64_t decoded = 0, sdk_dropped = 0, sdk_stale = 0, sdk_discontinuities = 0;
  std::uint64_t jitter_underruns = 0, jitter_overruns = 0, jitter_trimmed = 0;
  std::uint64_t rendered_frames = 0, device_starved = 0, late_wakes = 0, device_opens = 0;
  std::uint32_t reading = 0, latency_ms = 0;
  bool device_open = false;
};
struct RemoteAudioPlayoutSnapshot {
  MediaPathSnapshot path;
  RemoteAudioPlayoutStats stats;
  // Reference for the microphone's echo canceller while a device renders.
  std::shared_ptr<RenderedEchoReference> echo;
  bool stopped = true;
};

// Everything that turns remote LiveKit audio into sound, on one thread:
// subscriptions, SDK readers, per-track jitter buffers, the mix, the WASAPI
// render client and the echo reference. The device event clocks the loop, so
// reading, mixing and rendering share the device clock instead of three
// independent timers. The thread is MMCSS "Pro Audio" when available.
// attachRoom precedes connect; detachRoom acknowledges reader release before
// the Room is destroyed. Mix controls survive Room and device replacement.
class RemoteAudioPlayout final : public LiveKitRoomObserver {
 public:
  explicit RemoteAudioPlayout(AudioDeviceRegistry&);
  ~RemoteAudioPlayout() override;
  RemoteAudioPlayout(const RemoteAudioPlayout&) = delete;
  RemoteAudioPlayout& operator=(const RemoteAudioPlayout&) = delete;

  void apply(std::uint64_t revision, const OutputIntent&, bool room_connected, std::uint64_t device_revision);
  bool setScreenDemand(std::span<const RemoteVideoDemand> demand);
  RemoteAudioPlayoutSnapshot snapshot() const;
  // Derived from fresh decoded remote microphone PCM, never from room speaker signaling.
  std::vector<std::string> activeSpeakerIdentities() const;
  void beginStop();
  void stop() override;

  bool attachRoom(const std::shared_ptr<livekit::Room>& room) override;
  bool seedConnectedRoom() override;
  bool detachRoom() override;
  void onConnectionStateChanged(livekit::Room&, const livekit::ConnectionStateChangedEvent&) override;
  void onTrackPublished(livekit::Room&, const livekit::TrackPublishedEvent&) override;
  void onTrackUnpublished(livekit::Room&, const livekit::TrackUnpublishedEvent&) override;
  void onTrackSubscribed(livekit::Room&, const livekit::TrackSubscribedEvent&) override;
  void onTrackUnsubscribed(livekit::Room&, const livekit::TrackUnsubscribedEvent&) override;
  void onTrackSubscriptionFailed(livekit::Room&, const livekit::TrackSubscriptionFailedEvent&) override;
  void onParticipantDisconnected(livekit::Room&, const livekit::ParticipantDisconnectedEvent&) override;

 private:
  static constexpr std::size_t kPublicationCapacity = 64;
  static constexpr std::size_t kAudioTrackCapacity = 32;
  struct Publication {
    std::string participant;
    std::shared_ptr<livekit::RemoteTrackPublication> publication;
    std::shared_ptr<livekit::Track> track;
    std::uint64_t generation = 0;
    bool failed = false;
  };
  struct Desired {
    std::uint64_t revision = 0, device_revision = 0;
    OutputIntent intent;
    bool room_connected = false;
  };
  struct Device;
  bool isDesired(const Publication&) const;
  void addPublication(std::string_view participant, const std::shared_ptr<livekit::RemoteTrackPublication>&);
  void clearRoom();
  void changed();
  void run() noexcept;

  AudioDeviceRegistry& devices_;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable acknowledged_changed_;
  void* control_event_ = nullptr;
  std::shared_ptr<livekit::Room> room_;
  std::array<Publication, kPublicationCapacity> publications_{};
  std::array<RemoteVideoDemand, kAudioTrackCapacity> demand_{};
  std::size_t demand_count_ = 0;
  Desired desired_;
  std::uint64_t next_generation_ = 0, revision_ = 0, acknowledged_ = 0;
  bool connected_ = false, stopping_ = false, done_ = false;
  std::array<std::pair<std::string, std::chrono::steady_clock::time_point>, kAudioTrackCapacity> speakers_{};
  RemoteAudioPlayoutSnapshot snapshot_;
  std::uint64_t rejected_ = 0;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
