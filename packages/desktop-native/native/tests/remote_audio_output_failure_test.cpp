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

int main() try {
  if (!livekit::initialize(livekit::LogLevel::Off)) return 1;
  std::mutex mutex;
  std::condition_variable changed;
  std::optional<syrnike::desktop_native::media::AudioFailureInfo> failure;
  int failure_deliveries = 0;
  using syrnike::desktop_native::media::AudioFailureKind;
  using syrnike::desktop_native::media::audioFailureRetryable;
  using syrnike::desktop_native::media::audioFailureAllowsDefaultFallback;
  using syrnike::desktop_native::media::audioFailureCodeAllowsDefaultFallback;
  using syrnike::desktop_native::media::classifyAudioHresult;
  using syrnike::desktop_native::media::AudioEndpointChange;
  using syrnike::desktop_native::media::AudioEndpointChangeKind;
  using syrnike::desktop_native::media::AudioOutputDeviceIntent;
  using syrnike::desktop_native::media::audioEndpointChangeRequiresDefaultRetry;
  using syrnike::desktop_native::media::configuredAudioOutputEndpointChangeRequiresDefaultRetry;
  using syrnike::desktop_native::media::retainAudioOutputEndpointRetry;
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
  if (retainAudioOutputEndpointRetry(
        AudioOutputDeviceIntent::UserConfiguration,
        AudioFailureKind::EndpointInvalidated) ||
      !retainAudioOutputEndpointRetry(
        AudioOutputDeviceIntent::EndpointRecovery,
        AudioFailureKind::EndpointInvalidated) ||
      retainAudioOutputEndpointRetry(
        AudioOutputDeviceIntent::EndpointRecovery,
        AudioFailureKind::AccessDenied)) {
    throw std::runtime_error("output endpoint retry escaped its owning intent");
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
  if (!audioEndpointChangeRequiresDefaultRetry("explicit-a", false, removed_a) ||
      !audioEndpointChangeRequiresDefaultRetry("explicit-a", true, default_changed) ||
      audioEndpointChangeRequiresDefaultRetry("explicit-b", false, removed_a)) {
    throw std::runtime_error("endpoint fallback policy regressed selected/stale handling");
  }
  if (configuredAudioOutputEndpointChangeRequiresDefaultRetry(
        false, "default", false, default_changed)) {
    throw std::runtime_error("cold endpoint notification started the output renderer");
  }
  // LiveKit-owned tracks and streams must be destroyed before the process-wide
  // SDK shutdown. Release builds expose this ordering contract more reliably.
  {
  syrnike::desktop_native::media::RemoteAudioOutput output(
    [&](syrnike::desktop_native::media::AudioFailureInfo info, std::string, std::uint64_t) {
      {
        std::lock_guard lock(mutex);
        failure = std::move(info);
        failure_deliveries += 1;
      }
      changed.notify_all();
    }
  );

  try {
    output.setOutputDevice(
      "__syrnike_missing_audio_output__",
      AudioOutputDeviceIntent::UserConfiguration
    );
  } catch (const std::exception& error) {
    std::lock_guard lock(mutex);
    failure = syrnike::desktop_native::media::describeAudioFailure(error);
    failure_deliveries += 1;
    changed.notify_all();
  }
  std::unique_lock lock(mutex);
  if (!changed.wait_for(lock, std::chrono::seconds(2), [&] {
        return failure.has_value();
      })) {
    throw std::runtime_error("renderer failure was not surfaced");
  }
  if (failure->code.empty() || failure->hresult >= 0 ||
      failure->message.find("unavailable") == std::string::npos) {
    throw std::runtime_error("renderer failure lost its diagnostic message");
  }
  if (failure_deliveries != 1) {
    throw std::runtime_error("renderer startup failure had more than one owner");
  }
  lock.unlock();
  output.stop();

  syrnike::desktop_native::media::RemoteAudioOutput concurrent_output;
  std::thread switcher([&] {
    try {
      concurrent_output.setOutputDevice(
        "default",
        AudioOutputDeviceIntent::UserConfiguration
      );
    } catch (...) {}
  });
  std::thread stopper([&] { concurrent_output.stop(); });
  switcher.join();
  stopper.join();
  concurrent_output.stop();
  bool worker_failure_delivered = false;
  syrnike::desktop_native::media::RemoteAudioOutput worker_failure_output(
    [&](auto info, std::string, std::uint64_t) {
      worker_failure_delivered = info.code == "audio_output_stream_start_failed";
    },
    {},
    [](auto) -> std::jthread {
      throw std::runtime_error("injected audio worker construction failure");
    }
  );
  auto source = std::make_shared<livekit::AudioSource>(48'000, 1);
  auto track = livekit::LocalAudioTrack::createLocalAudioTrack("worker-failure", source);
  worker_failure_output.addTrack("worker-failure", "user:test", false, track);
  worker_failure_output.stop();
  if (!worker_failure_delivered) {
    throw std::runtime_error("audio worker construction failure was not typed and surfaced");
  }
  std::atomic_int duplicate_workers{0};
  syrnike::desktop_native::media::RemoteAudioOutput duplicate_output(
    {},
    {},
    [&](auto) {
      duplicate_workers.fetch_add(1);
      return std::jthread([](std::stop_token token) {
        while (!token.stop_requested()) std::this_thread::yield();
      });
    }
  );
  duplicate_output.addTrack("duplicate", "user:one", false, track);
  duplicate_output.addTrack("duplicate", "user:two", false, track);
  duplicate_output.stop();
  if (duplicate_workers.load() != 2) {
    throw std::runtime_error("replacement remote audio SID did not retire and restart cleanly");
  }
  }
  livekit::shutdown();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  livekit::shutdown();
  return 1;
}
