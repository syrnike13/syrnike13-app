#include "audio/audio_device_registry.hpp"

#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::audio {
AudioDeviceRegistry::AudioDeviceRegistry(std::unique_ptr<AudioDeviceEnumerator> enumerator)
    : enumerator_(std::move(enumerator)) {
  if (!enumerator_) throw std::invalid_argument("Audio registry requires an enumerator");
  identities_.reserve(kAudioIdentityCapacity);
}
void AudioDeviceRegistry::requireOwner() const {
  if (owner_ != std::this_thread::get_id())
    throw std::logic_error("Audio registry called outside its control owner");
}
bool AudioDeviceRegistry::changed() const {
  requireOwner();
  return enumerator_->changed();
}
AudioDeviceSnapshot AudioDeviceRegistry::refresh() {
  requireOwner();
  auto endpoints = enumerator_->enumerate();
  snapshot_.events.clear();
  const auto fail = [&](AudioRegistryStatus status) {
    if (snapshot_.status != status) ++snapshot_.revision;
    snapshot_.status = status;
    return snapshot_;
  };
  if (!endpoints || endpoints->size() > kAudioDeviceCapacity) {
    return fail(endpoints ? AudioRegistryStatus::capacity_exceeded : AudioRegistryStatus::enumeration_failed);
  }
  auto next_identities = identities_;
  std::vector<AudioDevice> next;
  next.reserve(endpoints->size());
  for (const auto& endpoint : *endpoints) {
    if (endpoint.endpoint_id.empty() || endpoint.endpoint_id.size() > 4096 ||
        endpoint.label.size() > 1024) {
      return fail(AudioRegistryStatus::enumeration_failed);
    }
    auto identity = std::find_if(next_identities.begin(), next_identities.end(),
                                [&](const Identity& value) {
      return value.endpoint_id == endpoint.endpoint_id && value.direction == endpoint.direction;
    });
    if (identity == next_identities.end()) {
      if (next_identities.size() == kAudioIdentityCapacity) {
        return fail(AudioRegistryStatus::capacity_exceeded);
      }
      next_identities.push_back({endpoint.endpoint_id, endpoint.direction,
                                 next_identities.size() + 1});
      identity = std::prev(next_identities.end());
    }
    if (std::any_of(next.begin(), next.end(), [&](const AudioDevice& value) {
          return value.id == identity->id ||
                 (value.direction == endpoint.direction && value.is_default && endpoint.is_default);
        })) {
      return fail(AudioRegistryStatus::enumeration_failed);
    }
    next.push_back({identity->id, endpoint.direction, endpoint.label, endpoint.is_default});
  }
  for (const auto& old : snapshot_.devices) {
    if (std::none_of(next.begin(), next.end(), [&](const AudioDevice& value) { return value.id == old.id; }))
      snapshot_.events.push_back({AudioDeviceChange::removed, old.id, old.direction});
  }
  for (const auto& device : next) {
    if (std::none_of(snapshot_.devices.begin(), snapshot_.devices.end(),
                     [&](const AudioDevice& value) { return value.id == device.id; }))
      snapshot_.events.push_back({AudioDeviceChange::added, device.id, device.direction});
  }
  for (const auto direction : {AudioDirection::input, AudioDirection::output}) {
    const auto default_id = [direction](const std::vector<AudioDevice>& devices) {
      const auto found = std::find_if(devices.begin(), devices.end(), [&](const AudioDevice& device) {
        return device.direction == direction && device.is_default;
      });
      return found == devices.end() ? AudioDeviceId{0} : found->id;
    };
    if (default_id(next) != default_id(snapshot_.devices))
      snapshot_.events.push_back({AudioDeviceChange::default_changed, default_id(next), direction});
  }
  if (next != snapshot_.devices || snapshot_.status != AudioRegistryStatus::ready)
    ++snapshot_.revision;
  snapshot_.devices = std::move(next);
  identities_ = std::move(next_identities);
  endpoints_ = std::move(*endpoints);
  snapshot_.status = AudioRegistryStatus::ready;
  return snapshot_;
}
std::optional<AudioEndpoint> AudioDeviceRegistry::resolve(const AudioDeviceIntent& intent) const {
  requireOwner();
  // A failed refresh cannot safely resolve a removed/default endpoint from a
  // stale snapshot. The current capture can continue independently.
  if (snapshot_.status != AudioRegistryStatus::ready) return {};
  for (std::size_t index = 0; index < snapshot_.devices.size(); ++index) {
    const auto& device = snapshot_.devices[index];
    if (device.direction == intent.direction &&
        (intent.explicit_id ? device.id == *intent.explicit_id : device.is_default))
      return endpoints_[index];
  }
  return {};
}
}  // namespace syrnike::windows_media::audio
