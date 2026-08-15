#include <memory>
#include <stdexcept>
#include <string_view>

#include "common/native_message_bindings.hpp"
#include "common/native_message_policy.hpp"
#include "common/runtime_types.hpp"

namespace {

void require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

template <typename Type, std::size_t Size, typename Parse>
void requireExhaustiveRoundTrip(
    const std::array<syrnike::desktop_native::NativeMessagePolicy<Type>, Size>
        &policies,
    Parse &&parse) {
  for (std::size_t index = 0; index < policies.size(); ++index) {
    const auto &policy = policies[index];
    require(!policy.wire_name.empty(), "native message has no wire name");
    require(static_cast<std::size_t>(policy.type) == index,
            "native message table is not enum-exhaustive");
    require(policy.schema !=
                syrnike::desktop_native::NativeMessageSchema::Count,
            "native message has no typed schema");
    require(policy.action !=
                syrnike::desktop_native::NativeMessageAction::Count,
            "native message has no typed action");
    require(parse(policy.wire_name) == policy.type,
            "native message wire round-trip failed");
    for (std::size_t other = index + 1; other < policies.size(); ++other) {
      require(policy.wire_name != policies[other].wire_name,
              "native message wire name is duplicated");
    }
  }
}

} // namespace

int main() try {
  using namespace syrnike::desktop_native;
  requireExhaustiveRoundTrip(kNativeCommandPolicies, [](std::string_view wire) {
    return parseNativeCommandType(wire);
  });
  requireExhaustiveRoundTrip(kNativeEventPolicies, [](std::string_view wire) {
    return parseNativeEventType(wire);
  });

  auto command_with_unbound_row =
      std::array<NativeMessagePolicy<NativeCommandType>,
                 kNativeCommandPolicies.size() + 1>{};
  for (std::size_t index = 0; index < kNativeCommandPolicies.size(); ++index) {
    command_with_unbound_row[index] = kNativeCommandPolicies[index];
  }
  command_with_unbound_row.back() = kNativeCommandPolicies.front();
  require(!nativeImplementationBindingsAreExhaustive(
              command_with_unbound_row, kNativeEventPolicies),
          "an unbound command row passed implementation coverage");

  auto event_with_unbound_row =
      std::array<NativeMessagePolicy<NativeEventType>,
                 kNativeEventPolicies.size() + 1>{};
  for (std::size_t index = 0; index < kNativeEventPolicies.size(); ++index) {
    event_with_unbound_row[index] = kNativeEventPolicies[index];
  }
  event_with_unbound_row.back() = kNativeEventPolicies.front();
  require(!nativeImplementationBindingsAreExhaustive(
              kNativeCommandPolicies, event_with_unbound_row),
          "an unbound event row passed implementation coverage");

  for (const auto &policy : kNativeCommandPolicies) {
    const auto *binding = nativeCommandDispatchBinding(policy.type);
    require(binding && binding->schema == policy.schema &&
                binding->action == policy.action &&
                binding->destination == policy.destination,
            "command has no concrete dispatch binding");
    require(policy.destination != NativeMessageDestination::Node,
            "native command has no runtime destination");
    if (policy.resource_drop != NativeResourceDropPolicy::RequiredExactOnce) {
      continue;
    }
    require(policy.owner == NativeMessageOwner::RendererLease &&
                policy.lane == NativeMessageLane::Media &&
                policy.loss == NativeMessageLoss::CoalescedLatest &&
                policy.payload == NativePayloadProfile::VideoFrame,
            "resource command policy is not ownership-complete");
  }
  for (const auto &policy : kNativeEventPolicies) {
    const auto *binding = nativeEventCodecBinding(policy.type);
    require(binding && binding->schema == policy.schema &&
                binding->action == policy.action &&
                binding->payload == policy.payload,
            "event has no concrete Node codec binding");
    require(policy.destination == NativeMessageDestination::Node,
            "native event bypasses the Node delivery destination");
    if (policy.resource_drop != NativeResourceDropPolicy::RequiredExactOnce) {
      continue;
    }
    require(policy.owner == NativeMessageOwner::RendererLease &&
                policy.lane == NativeMessageLane::Media &&
                policy.loss == NativeMessageLoss::CoalescedLatest &&
                policy.payload == NativePayloadProfile::VideoFrame,
            "resource event policy is not ownership-complete");
  }

  for (const auto type :
       {syrnike::desktop_native::NativeCommandType::RemoteVideoFrame,
        syrnike::desktop_native::NativeCommandType::LocalScreenPreviewFrame,
        syrnike::desktop_native::NativeCommandType::LocalCameraPreviewFrame}) {
    const auto &policy = nativeCommandPolicy(type);
    require(policy.lane == NativeMessageLane::Media &&
                policy.loss == NativeMessageLoss::CoalescedLatest &&
                policy.resource_drop ==
                    NativeResourceDropPolicy::RequiredExactOnce,
            "resource-bearing command lacks exact-once media policy");
  }
  require(
      nativeCommandPolicy(syrnike::desktop_native::NativeCommandType::Shutdown)
              .destination == NativeMessageDestination::Runtime,
      "shutdown is assigned to the wrong destination");
  require(nativeCommandPolicy(
              syrnike::desktop_native::NativeCommandType::ListDevices)
                  .destination == NativeMessageDestination::Query,
          "device enumeration is assigned to the wrong destination");
  require(nativeCommandPolicy(
              syrnike::desktop_native::NativeCommandType::ConnectVoice)
                  .destination == NativeMessageDestination::Voice,
          "voice connect is assigned to the wrong destination");
  require(nativeCommandPolicy(syrnike::desktop_native::NativeCommandType::
                                  LocalMicrophoneUnpublished)
                  .destination == NativeMessageDestination::Voice,
          "LiveKit microphone loss bypasses the voice owner");
  require(nativeCommandPolicy(
              syrnike::desktop_native::NativeCommandType::ConnectMicrophone)
                  .destination == NativeMessageDestination::Microphone,
          "microphone connect is assigned to the wrong destination");
  require(nativeCommandPolicy(
              syrnike::desktop_native::NativeCommandType::ConnectScreen)
                  .destination == NativeMessageDestination::Screen,
          "screen connect is assigned to the wrong destination");
  require(nativeCommandPolicy(
              syrnike::desktop_native::NativeCommandType::ConnectCamera)
                  .destination == NativeMessageDestination::Camera,
          "camera connect is assigned to the wrong destination");
  for (const auto type :
       {syrnike::desktop_native::NativeEventType::RemoteVideoFrame,
        syrnike::desktop_native::NativeEventType::LocalScreenPreviewFrame,
        syrnike::desktop_native::NativeEventType::LocalCameraPreviewFrame}) {
    const auto &policy = nativeEventPolicy(type);
    require(policy.lane == NativeMessageLane::Media &&
                policy.loss == NativeMessageLoss::CoalescedLatest &&
                policy.resource_drop ==
                    NativeResourceDropPolicy::RequiredExactOnce &&
                policy.payload == NativePayloadProfile::VideoFrame,
            "resource-bearing event lacks exact-once serialization policy");
  }
  for (const auto type :
       {syrnike::desktop_native::NativeCommandType::ReleaseRemoteVideoFrame,
        syrnike::desktop_native::NativeCommandType::
            ReleaseLocalScreenPreviewFrame,
        syrnike::desktop_native::NativeCommandType::
            ReleaseLocalCameraPreviewFrame,
        syrnike::desktop_native::NativeCommandType::SetRemoteVideoDemand,
        syrnike::desktop_native::NativeCommandType::RetryRemoteVideo,
        syrnike::desktop_native::NativeCommandType::ConfigureVoiceOutput,
        syrnike::desktop_native::NativeCommandType::ConfigureRemoteAudio,
        syrnike::desktop_native::NativeCommandType::SetLocalScreenPreviewDemand,
        syrnike::desktop_native::NativeCommandType::SetLocalCameraPreviewDemand,
        syrnike::desktop_native::NativeCommandType::RetryLocalCameraPreview,
        syrnike::desktop_native::NativeCommandType::ProbeVoiceControl}) {
    require(nativeCommandPolicy(type).lane == NativeMessageLane::VoiceControl,
            "voice control command is assigned to the wrong lane");
  }
  require(!parseNativeCommandType("__unsupportedInternalCommand"),
          "unsupported command entered the typed registry");
  require(parseNativeCommandType("releaseRemoteVideoFrame") ==
                  syrnike::desktop_native::NativeCommandType::
                      ReleaseRemoteVideoFrame &&
              nativeCommandName(syrnike::desktop_native::NativeCommandType::
                                    ReleaseRemoteVideoFrame) ==
                  "releaseRemoteVideoFrame",
          "command boundary did not preserve its enum/wire round trip");
  require(nativeCommandName(
              syrnike::desktop_native::NativeCommandType::ConnectVoice) ==
              "connectVoice",
          "command enum did not recover its canonical wire identity");
  require(nativeCommandName(syrnike::desktop_native::NativeCommandType::Count)
              .empty(),
          "invalid command enum escaped through the wire boundary");
  require(parseNativeEventType("remoteVideoFrame") ==
                  syrnike::desktop_native::NativeEventType::RemoteVideoFrame &&
              nativeEventName(
                  syrnike::desktop_native::NativeEventType::RemoteVideoFrame) ==
                  "remoteVideoFrame",
          "event boundary did not preserve its enum/wire round trip");
  require(
      nativeEventName(syrnike::desktop_native::NativeEventType::Count).empty(),
      "invalid event enum escaped through the wire boundary");

  int releases = 0;
  auto resource_command = makeNativeResourceCommand(
      syrnike::desktop_native::NativeCommandType::RemoteVideoFrame,
      [&] { ++releases; });
  auto copied_release = resource_command.on_drop;
  resource_command.on_drop();
  copied_release();
  require(releases == 1,
          "copied native resource callbacks released ownership more than once");

  auto retained_until_release = std::make_shared<int>(42);
  std::weak_ptr<int> retained_probe = retained_until_release;
  auto prompt_release = exactOnceNativeRelease(
      [retained = retained_until_release] { static_cast<void>(retained); });
  auto lingering_release_copy = prompt_release;
  retained_until_release.reset();
  require(!retained_probe.expired(),
          "release ownership was discarded before the terminal callback");
  prompt_release();
  require(retained_probe.expired(),
          "completed exact-once state retained release captures");
  lingering_release_copy();

  int event_releases = 0;
  auto resource_event = makeNativeResourceEvent(
      syrnike::desktop_native::NativeEventType::RemoteVideoFrame,
      [&] { ++event_releases; });
  auto copied_event_release = resource_event.on_drop;
  resource_event.on_drop();
  copied_event_release();
  require(event_releases == 1,
          "copied native event callbacks released ownership more than once");

  bool non_resource_rejected = false;
  try {
    static_cast<void>(makeNativeResourceCommand(
        syrnike::desktop_native::NativeCommandType::ConnectVoice, [] {}));
  } catch (const std::invalid_argument &) {
    non_resource_rejected = true;
  }
  require(non_resource_rejected,
          "non-resource command entered the exact-once resource factory");
  bool non_resource_event_rejected = false;
  try {
    static_cast<void>(makeNativeResourceEvent(
        syrnike::desktop_native::NativeEventType::RuntimeError, [] {}));
  } catch (const std::invalid_argument &) {
    non_resource_event_rejected = true;
  }
  require(non_resource_event_rejected,
          "non-resource event entered the exact-once resource factory");
  return 0;
} catch (...) {
  return 1;
}
