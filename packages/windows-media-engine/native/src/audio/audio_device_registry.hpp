#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace syrnike::windows_media::audio {
enum class AudioDirection { input, output };
enum class AudioRegistryStatus { ready, enumeration_failed, capacity_exceeded };
enum class AudioDeviceChange { added, removed, default_changed };
using AudioDeviceId = std::uint64_t;
inline constexpr std::size_t kAudioDeviceCapacity = 128;
inline constexpr std::size_t kAudioIdentityCapacity = 512;

struct AudioDevice {
  AudioDeviceId id = 0;
  AudioDirection direction = AudioDirection::input;
  std::string label;
  bool is_default = false;
  bool operator==(const AudioDevice&) const = default;
};
struct AudioDeviceEvent {
  AudioDeviceChange change;
  AudioDeviceId id;
  AudioDirection direction;
};
struct AudioDeviceSnapshot {
  AudioRegistryStatus status = AudioRegistryStatus::ready;
  std::uint64_t revision = 0;
  std::vector<AudioDevice> devices;
  std::vector<AudioDeviceEvent> events;
};
struct AudioDeviceIntent {
  AudioDirection direction = AudioDirection::input;
  // An absent ID means follow the multimedia default, never communications.
  std::optional<AudioDeviceId> explicit_id;
};

// Native-only value passed to the capture/render owner. Endpoint strings never
// cross the public protocol; no COM pointer crosses this boundary.
struct AudioEndpoint {
  std::wstring endpoint_id;
  AudioDirection direction;
  std::string label;
  bool is_default = false;
};
class AudioDeviceEnumerator {
 public:
  virtual ~AudioDeviceEnumerator() = default;
  virtual std::optional<std::vector<AudioEndpoint>> enumerate() = 0;
  virtual bool changed() const noexcept = 0;
};
std::unique_ptr<AudioDeviceEnumerator> makeWindowsAudioDeviceEnumerator();

// Construct, refresh, resolve and destroy on one control thread. Notifications
// are coalesced by the adapter; snapshots have at most 128 devices/258 events.
// Retain at most 512 identities for this process registry's lifetime. Exhaustion
// fails explicitly instead of reusing an ID or evicting a disconnected device.
class AudioDeviceRegistry final {
 public:
  explicit AudioDeviceRegistry(std::unique_ptr<AudioDeviceEnumerator>);
  AudioDeviceSnapshot refresh();
  bool changed() const;
  std::optional<AudioEndpoint> resolve(const AudioDeviceIntent&) const;

 private:
  void requireOwner() const;
  struct Identity {
    std::wstring endpoint_id;
    AudioDirection direction;
    AudioDeviceId id;
  };
  const std::thread::id owner_ = std::this_thread::get_id();
  std::unique_ptr<AudioDeviceEnumerator> enumerator_;
  std::vector<Identity> identities_;
  std::vector<AudioEndpoint> endpoints_;
  AudioDeviceSnapshot snapshot_;
};
}  // namespace syrnike::windows_media::audio
