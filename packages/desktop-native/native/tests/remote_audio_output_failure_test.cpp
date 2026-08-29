#include <chrono>
#include <audioclient.h>
#include <atomic>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

#include <livekit/audio_source.h>
#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>

#include "media/audio_devices.hpp"
#include "media/remote_audio_output.hpp"

namespace {

struct AsyncOutputOwner {
  explicit AsyncOutputOwner(
    syrnike::desktop_native::CleanupStartProbe cleanup_start_probe
  ) : output({}, {}, {}, std::move(cleanup_start_probe)) {}

  syrnike::desktop_native::media::RemoteAudioOutput output;
};

}  // namespace

int main() try {
  if (!livekit::initialize(livekit::LogLevel::Off)) return 1;
  std::mutex mutex;
  std::condition_variable changed;
  std::optional<syrnike::desktop_native::media::RemoteAudioOutputState>
    output_state;
  int state_deliveries = 0;
  using syrnike::desktop_native::media::AudioFailureKind;
  using syrnike::desktop_native::media::audioFailureRetryable;
  using syrnike::desktop_native::media::audioFailureAllowsDefaultFallback;
  using syrnike::desktop_native::media::audioFailureCodeAllowsDefaultFallback;
  using syrnike::desktop_native::media::classifyAudioHresult;
  using syrnike::desktop_native::media::AudioEndpointChange;
  using syrnike::desktop_native::media::AudioEndpointChangeKind;
  using syrnike::desktop_native::media::audioEndpointChangeRequiresDefaultRetry;
  using syrnike::desktop_native::media::RemoteAudioOutputPhase;
  using syrnike::desktop_native::media::remoteAudioEndpointChangeCanRearmRecovery;
  using syrnike::desktop_native::media::startAudioOutputWithRollback;
  if (classifyAudioHresult(AUDCLNT_E_DEVICE_INVALIDATED) !=
      AudioFailureKind::EndpointInvalidated) {
    throw std::runtime_error("device invalidation HRESULT lost its typed cause");
  }
  if (classifyAudioHresult(E_ACCESSDENIED) != AudioFailureKind::AccessDenied ||
      audioFailureRetryable(AudioFailureKind::AccessDenied)) {
    throw std::runtime_error("access denied audio failure became retryable");
  }
  if (classifyAudioHresult(AUDCLNT_E_UNSUPPORTED_FORMAT) !=
      AudioFailureKind::FormatUnsupported) {
    throw std::runtime_error("unsupported format HRESULT lost its typed cause");
  }
  if (!audioFailureAllowsDefaultFallback(AudioFailureKind::DeviceNotFound) ||
      !audioFailureAllowsDefaultFallback(AudioFailureKind::EndpointInvalidated) ||
      audioFailureAllowsDefaultFallback(AudioFailureKind::AccessDenied) ||
      audioFailureAllowsDefaultFallback(AudioFailureKind::FormatUnsupported) ||
      audioFailureAllowsDefaultFallback(AudioFailureKind::IoFailed) ||
      !audioFailureCodeAllowsDefaultFallback("audio_endpoint_invalidated") ||
      audioFailureCodeAllowsDefaultFallback("audio_access_denied")) {
    throw std::runtime_error("audio default fallback escaped endpoint-loss policy");
  }
  bool restored_previous = false;
  try {
    startAudioOutputWithRollback(
      [] {
        throw syrnike::desktop_native::media::AudioFailure(
          AudioFailureKind::AccessDenied,
          "candidate denied",
          E_ACCESSDENIED
        );
      },
      [&] { restored_previous = true; },
      [] {}
    );
    throw std::runtime_error("candidate failure disappeared after rollback");
  } catch (const syrnike::desktop_native::media::AudioFailure& failure) {
    if (!restored_previous || failure.kind() != AudioFailureKind::AccessDenied) {
      throw std::runtime_error("successful output rollback lost the candidate failure");
    }
  }
  try {
    startAudioOutputWithRollback(
      [] { throw std::runtime_error("candidate start failed"); },
      [] {},
      [] { throw std::runtime_error("previous start failed"); }
    );
    throw std::runtime_error("double renderer failure was swallowed");
  } catch (const syrnike::desktop_native::media::AudioFailure& failure) {
    if (failure.kind() != AudioFailureKind::RollbackFailed ||
        failure.code() != "audio_output_rollback_failed") {
      throw std::runtime_error("double renderer failure did not become terminal");
    }
  }
  const auto generic = syrnike::desktop_native::media::describeAudioFailure(
    std::runtime_error("generic sink failure")
  );
  if (generic.hresult != S_OK || generic.code != "audio_unknown") {
    throw std::runtime_error("generic C++ failure invented a Windows HRESULT");
  }
  const AudioEndpointChange removed_a{
    eRender, AudioEndpointChangeKind::Removed, "explicit-a"
  };
  const AudioEndpointChange default_changed{
    eRender, AudioEndpointChangeKind::DefaultChanged, "default-b"
  };
  const AudioEndpointChange communications_default_changed{
    eRender,
    AudioEndpointChangeKind::DefaultChanged,
    "communications-default",
    eCommunications
  };
  if (!audioEndpointChangeRequiresDefaultRetry("explicit-a", false, removed_a) ||
      !audioEndpointChangeRequiresDefaultRetry("explicit-a", true, default_changed) ||
      audioEndpointChangeRequiresDefaultRetry("explicit-b", false, removed_a) ||
      audioEndpointChangeRequiresDefaultRetry(
        "default",
        false,
        communications_default_changed
      )) {
    throw std::runtime_error("endpoint fallback policy regressed selected/stale handling");
  }
  const AudioEndpointChange added{
    eRender, AudioEndpointChangeKind::Added, "available-output"
  };
  const AudioEndpointChange active{
    eRender, AudioEndpointChangeKind::Active, "available-output"
  };
  const AudioEndpointChange capture_added{
    eCapture, AudioEndpointChangeKind::Added, "capture-endpoint"
  };
  if (!remoteAudioEndpointChangeCanRearmRecovery(default_changed) ||
      !remoteAudioEndpointChangeCanRearmRecovery(added) ||
      !remoteAudioEndpointChangeCanRearmRecovery(active) ||
      remoteAudioEndpointChangeCanRearmRecovery(removed_a) ||
      remoteAudioEndpointChangeCanRearmRecovery(capture_added) ||
      remoteAudioEndpointChangeCanRearmRecovery(
        communications_default_changed
      )) {
    throw std::runtime_error("failed output recovery lost endpoint-return policy");
  }
  // LiveKit-owned tracks and streams must be destroyed before the process-wide
  // SDK shutdown. Release builds expose this ordering contract more reliably.
  {
  syrnike::desktop_native::media::RemoteAudioOutput output(
    [&](syrnike::desktop_native::media::RemoteAudioOutputState state) {
      {
        std::lock_guard lock(mutex);
        output_state = std::move(state);
        state_deliveries += 1;
      }
      changed.notify_all();
    }
  );

  try {
    output.setOutputDevice("__syrnike_missing_audio_output__");
  } catch (const std::exception&) {}
  std::unique_lock lock(mutex);
  if (!changed.wait_for(lock, std::chrono::seconds(2), [&] {
        return output_state.has_value();
      })) {
    throw std::runtime_error("renderer state was not surfaced");
  }
  if (output_state->phase != RemoteAudioOutputPhase::Running &&
      output_state->phase != RemoteAudioOutputPhase::Failed) {
    throw std::runtime_error("renderer ended in an invalid output state");
  }
  if (output_state->phase == RemoteAudioOutputPhase::Running &&
      (!output_state->using_fallback || !output_state->failure ||
       output_state->failure->code != "audio_output_fallback_default")) {
    throw std::runtime_error("renderer fallback lost its typed output state");
  }
  if (state_deliveries != 1) {
    throw std::runtime_error("renderer configuration had more than one state owner");
  }
  lock.unlock();
  output.stop();

  syrnike::desktop_native::media::RemoteAudioOutput concurrent_output;
  std::thread switcher([&] {
    try {
      concurrent_output.setOutputDevice("default");
    } catch (...) {}
  });
  std::thread stopper([&] { concurrent_output.stop(); });
  switcher.join();
  stopper.join();
  concurrent_output.stop();
  std::optional<syrnike::desktop_native::media::AudioFailureInfo>
    direct_sink_failure;
  syrnike::desktop_native::media::RemoteAudioOutput duplicate_output(
    {},
    [&](auto info, std::string, std::uint64_t) {
      direct_sink_failure = std::move(info);
    }
  );
  auto source = std::make_shared<livekit::AudioSource>(48'000, 2);
  auto track = livekit::LocalAudioTrack::createLocalAudioTrack(
    "direct-sink",
    source
  );
  duplicate_output.addTrack("duplicate", "user:one", false, track);
  duplicate_output.addTrack("duplicate", "user:two", false, track);
  duplicate_output.stop();
  if (direct_sink_failure) {
    throw std::runtime_error(
      "direct decoded-audio sink registration failed: " +
      direct_sink_failure->message
    );
  }

  std::atomic_bool release_cleanup{false};
  std::atomic_int cleanup_launches{0};
  auto blocked_owner = std::make_shared<AsyncOutputOwner>(
    [&] {
      if (cleanup_launches.fetch_add(1) == 0) {
        throw std::runtime_error(
          "injected remote audio quarantine launch failure"
        );
      }
      while (!release_cleanup.load()) std::this_thread::yield();
    }
  );
  const auto blocked_stop_started = std::chrono::steady_clock::now();
  blocked_owner->output.stop(blocked_owner);
  if (std::chrono::steady_clock::now() - blocked_stop_started >=
      std::chrono::milliseconds(100)) {
    throw std::runtime_error("remote audio quarantine blocked Room shutdown");
  }
  std::weak_ptr<AsyncOutputOwner> blocked_owner_lifetime = blocked_owner;
  blocked_owner.reset();
  if (blocked_owner_lifetime.expired()) {
    throw std::runtime_error("queued remote audio cleanup lost its lifetime owner");
  }
  release_cleanup = true;
  const auto owner_release_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (
    !blocked_owner_lifetime.expired() &&
    std::chrono::steady_clock::now() < owner_release_deadline
  ) {
    std::this_thread::yield();
  }
  if (!blocked_owner_lifetime.expired()) {
    throw std::runtime_error("remote audio quarantine retained its owner after completion");
  }
  if (cleanup_launches.load() < 2) {
    throw std::runtime_error(
      "remote audio quarantine did not retry its failed cleanup launch"
    );
  }
  }
  livekit::shutdown();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  livekit::shutdown();
  return 1;
}
