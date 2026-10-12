#include "audio/audio_device_registry.hpp"
#include <iostream>
#include <future>
#include <functional>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
class FakeEnumerator final : public AudioDeviceEnumerator {
 public:
  std::optional<std::vector<AudioEndpoint>> devices = std::vector<AudioEndpoint>{};
  std::function<void()> before_enumerate;
  std::optional<std::vector<AudioEndpoint>> enumerate() override {
    if (before_enumerate) before_enumerate();
    return devices;
  }
  bool changed() const noexcept override { return true; }
};
void identityAndDefaults() {
  auto fake = std::make_unique<FakeEnumerator>();
  auto& source = *fake;
  source.devices = std::vector<AudioEndpoint>{{L"input-a", AudioDirection::input, "Same label", true},
                                             {L"input-b", AudioDirection::input, "Same label", false},
                                             {L"out", AudioDirection::output, "Speakers", true}};
  AudioDeviceRegistry registry(std::move(fake));
  const auto initial = registry.refresh();
  require(initial.devices.size() == 3 && initial.events.size() == 5, "Initial registry projection");
  const auto first_id = initial.devices[0].id;
  const auto second_id = initial.devices[1].id;
  require(first_id != second_id, "Display label was used as identity");
  auto restarted_enumerator = std::make_unique<FakeEnumerator>();
  restarted_enumerator->devices = std::vector<AudioEndpoint>{
      {L"out", AudioDirection::output, "Renamed speakers", true},
      {L"input-b", AudioDirection::input, "Same label", true}};
  AudioDeviceRegistry restarted(std::move(restarted_enumerator));
  const auto restarted_snapshot = restarted.refresh();
  require(restarted_snapshot.devices[0].id == initial.devices[2].id &&
      restarted_snapshot.devices[1].id == second_id, "Restart/reordering changed endpoint IDs");
  require(!restarted.resolve({AudioDirection::input, first_id}), "Restart rebound a removed microphone selection");
  require(restarted.resolve({AudioDirection::input, second_id})->endpoint_id == L"input-b",
      "Restart lost the selected microphone");
  require(registry.refresh().events.empty(), "Unchanged snapshot repeated events");
  source.devices->erase(source.devices->begin());
  source.devices->front().is_default = true;
  const auto removed = registry.refresh();
  require(removed.events.size() == 2 && removed.events[0].change == AudioDeviceChange::removed,
          "Removal/default transition missing");
  require(!registry.resolve({AudioDirection::input, first_id}), "Removed explicit device resolved");
  require(registry.resolve({AudioDirection::input, {}})->endpoint_id == L"input-b", "Default did not move");
  require(!registry.resolve({AudioDirection::output, second_id}), "Direction identity crossed");
  source.devices->push_back({L"input-a", AudioDirection::input, "Renamed", false});
  const auto replugged = registry.refresh();
  require(replugged.devices.back().id == first_id, "Replug changed opaque identity");
  source.devices.reset();
  const auto failed = registry.refresh();
  require(failed.status == AudioRegistryStatus::enumeration_failed && failed.revision > replugged.revision,
          "Enumeration failure disappeared");
  require(registry.refresh().revision == failed.revision, "Repeated failure advanced revision");
  require(!registry.resolve({AudioDirection::input, {}}), "Failed refresh resolved stale default");
}
void boundsAndRollback() {
  auto fake = std::make_unique<FakeEnumerator>();
  auto& source = *fake;
  AudioDeviceRegistry registry(std::move(fake));
  AudioDeviceId first_id = 0;
  for (std::size_t index = 0; index < kAudioIdentityCapacity; ++index) {
    source.devices = std::vector<AudioEndpoint>{{std::to_wstring(index), AudioDirection::input, "Mic", true}};
    const auto snapshot = registry.refresh();
    require(snapshot.status == AudioRegistryStatus::ready, "Identity admission failed early");
    if (index == 0) first_id = snapshot.devices.front().id;
  }
  source.devices = std::vector<AudioEndpoint>{{L"overflow", AudioDirection::input, "Mic", true}};
  require(registry.refresh().status == AudioRegistryStatus::capacity_exceeded, "Identity storage unbounded");
  source.devices = std::vector<AudioEndpoint>{{L"0", AudioDirection::input, "Mic", true}};
  require(registry.refresh().devices.front().id == first_id, "Capacity failure corrupted existing identity");
  source.devices = std::vector<AudioEndpoint>(kAudioDeviceCapacity + 1);
  require(registry.refresh().status == AudioRegistryStatus::capacity_exceeded, "Snapshot storage unbounded");
}
void concurrentMediaOwners() {
  auto fake = std::make_unique<FakeEnumerator>();
  auto& source = *fake;
  source.devices = std::vector<AudioEndpoint>{
      {L"input-a", AudioDirection::input, "Microphone", true},
      {L"output-a", AudioDirection::output, "Speakers", true}};
  AudioDeviceRegistry registry(std::move(fake));
  const auto initial = registry.refresh();
  // Resolve from both media owners while enumeration is still in progress.
  // Neither COM enumeration nor the enumerator itself may escape this owner.
  source.before_enumerate = [&] {
    auto input = std::async(std::launch::async, [&] {
      return registry.resolve({AudioDirection::input, initial.devices[0].id});
    });
    auto output = std::async(std::launch::async, [&] {
      return registry.resolve({AudioDirection::output, {}});
    });
    require(input.get()->endpoint_id == L"input-a", "Concurrent microphone resolution failed");
    require(output.get()->endpoint_id == L"output-a", "Concurrent output resolution failed");
  };
  source.devices->back().endpoint_id = L"output-b";
  registry.refresh();
  source.before_enumerate = {};
  auto updated = std::async(std::launch::async, [&] {
    return registry.resolve({AudioDirection::output, {}});
  });
  require(updated.get()->endpoint_id == L"output-b", "Committed default was not visible to output owner");
  source.devices.reset();
  registry.refresh();
  auto failed = std::async(std::launch::async, [&] {
    return registry.resolve({AudioDirection::input, {}});
  });
  require(!failed.get(), "Failed catalog resolved stale endpoint on media owner");
}
}  // namespace
int main() try {
  identityAndDefaults();
  boundsAndRollback();
  concurrentMediaOwners();
  std::cout << "Audio registry contracts passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
