#include <audioclient.h>

#include <iostream>
#include <stdexcept>
#include <vector>

#include "media/windows_audio_session_policy.hpp"

namespace {

void require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

} // namespace

int main() try {
  using namespace syrnike::desktop_native::media;

  require(windowsAudioCategory(WindowsAudioSessionUse::MicrophoneCapture) ==
              AudioCategory_Other,
          "microphone capture entered a communications audio category");
  require(
      windowsAudioCategory(WindowsAudioSessionUse::RemotePlayback) ==
              AudioCategory_GameChat &&
          windowsAudioCategory(WindowsAudioSessionUse::ScreenLoopbackCapture) ==
              AudioCategory_Other,
      "remote playback must use non-attenuating GameChat while loopback stays Other");
  require(windowsAudioCategoryName(AudioCategory_GameChat) == "game_chat",
          "GameChat category lost its diagnostic contract name");

  int category_calls = 0;
  AUDIO_STREAM_CATEGORY observed_category = AudioCategory_Communications;
  const auto microphone =
      applyWindowsAudioCategoryPolicy(WindowsAudioSessionUse::MicrophoneCapture,
                                      [&](AUDIO_STREAM_CATEGORY category) {
                                        ++category_calls;
                                        observed_category = category;
                                        return S_OK;
                                      });
  require(category_calls == 1 && observed_category == AudioCategory_Other &&
              microphone.status == WindowsAudioPolicyStatus::Applied,
          "microphone category policy was not applied exactly once");

  int ducking_calls = 0;
  bool observed_opt_out = false;
  const auto playback = applyWindowsAudioDuckingPolicy(
      WindowsAudioSessionUse::RemotePlayback, [&](bool opt_out) {
        ++ducking_calls;
        observed_opt_out = opt_out;
        return S_OK;
      });
  require(ducking_calls == 1 && observed_opt_out &&
              playback.status == WindowsAudioPolicyStatus::Applied &&
              playback.category == AudioCategory_GameChat,
          "remote playback did not opt out of Windows communications ducking");

  const auto capture_ducking = applyWindowsAudioDuckingPolicy(
      WindowsAudioSessionUse::ScreenLoopbackCapture, [&](bool) {
        ++ducking_calls;
        return E_UNEXPECTED;
      });
  require(ducking_calls == 1 &&
              capture_ducking.status == WindowsAudioPolicyStatus::NotRequired,
          "capture-only session created an unnecessary ducking control");

  const auto failed_category = applyWindowsAudioCategoryPolicy(
      WindowsAudioSessionUse::RemotePlayback,
      [](AUDIO_STREAM_CATEGORY) { return E_ACCESSDENIED; });
  require(failed_category.status == WindowsAudioPolicyStatus::Failed &&
              failed_category.hresult == E_ACCESSDENIED &&
              windowsAudioPolicyReasonCode(failed_category) ==
                  "audio_category_failed",
          "category failure lost its typed capability outcome");

  const auto unsupported_ducking = applyWindowsAudioDuckingPolicy(
      WindowsAudioSessionUse::RemotePlayback, SetDuckingPreference{});
  require(unsupported_ducking.status == WindowsAudioPolicyStatus::Unsupported &&
              windowsAudioPolicyReasonCode(unsupported_ducking) ==
                  "audio_ducking_opt_out_unsupported",
          "unsupported ducking control lost its typed capability outcome");

  const auto invalid_client = applyWindowsAudioCategoryPolicy(
      static_cast<IAudioClient *>(nullptr),
      WindowsAudioSessionUse::MicrophoneCapture);
  require(invalid_client.status == WindowsAudioPolicyStatus::Failed &&
              invalid_client.hresult == E_POINTER &&
              windowsAudioPolicyReasonCode(invalid_client) ==
                  "audio_category_failed",
          "invalid audio client was mislabeled as an unsupported capability");

  std::vector<WindowsAudioAttemptPhase> phases;
  WindowsAudioSessionAttemptPolicy deterministic_policy(
      WindowsAudioSessionAttemptOperations{
          .category = [&](IAudioClient *, WindowsAudioSessionUse use,
                          AUDCLNT_STREAMOPTIONS) {
            return applyWindowsAudioCategoryPolicy(
                use, [](AUDIO_STREAM_CATEGORY) { return S_OK; });
          },
          .ducking = [&](IAudioClient *, WindowsAudioSessionUse use) {
            return applyWindowsAudioDuckingPolicy(
                use, [](bool) { return S_OK; });
          },
      },
      [&](const WindowsAudioAttemptStep &step) { phases.push_back(step.phase); });
  const auto deterministic_attempt = deterministic_policy.run(
      nullptr, WindowsAudioSessionUse::RemotePlayback,
      AUDCLNT_STREAMOPTIONS_NONE, [] { return S_OK; });
  require(
      phases == std::vector<WindowsAudioAttemptPhase>{
                    WindowsAudioAttemptPhase::BeforeInitialize,
                    WindowsAudioAttemptPhase::Initialize,
                    WindowsAudioAttemptPhase::AfterInitialize} &&
          deterministic_attempt.category.status ==
              WindowsAudioPolicyStatus::Applied &&
          deterministic_attempt.initialize.status ==
              WindowsAudioPolicyStatus::Applied &&
          deterministic_attempt.ducking.has_value() &&
          deterministic_attempt.ducking->status ==
              WindowsAudioPolicyStatus::Applied,
      "remote attempt policy did not own category -> Initialize -> ducking order");

  phases.clear();
  const auto failed_attempt = deterministic_policy.run(
      nullptr, WindowsAudioSessionUse::RemotePlayback,
      AUDCLNT_STREAMOPTIONS_NONE, [] { return E_ACCESSDENIED; });
  require(
      phases == std::vector<WindowsAudioAttemptPhase>{
                    WindowsAudioAttemptPhase::BeforeInitialize,
                    WindowsAudioAttemptPhase::Initialize} &&
          failed_attempt.initialize.status == WindowsAudioPolicyStatus::Failed &&
          failed_attempt.initialize.hresult == E_ACCESSDENIED &&
          failed_attempt.initialize.reason_code ==
              "audio_client_initialize_failed" &&
          !failed_attempt.ducking,
      "failed Initialize was not typed or incorrectly attempted duck opt-out");

  int recreation_categories = 0;
  int recreation_ducking = 0;
  int recreation_policy_successes = 0;
  for (int generation = 0; generation < 8; ++generation) {
    const auto category = applyWindowsAudioCategoryPolicy(
        WindowsAudioSessionUse::RemotePlayback,
        [&](AUDIO_STREAM_CATEGORY category) {
          ++recreation_categories;
          return category == AudioCategory_GameChat ? S_OK : E_INVALIDARG;
        });
    const auto ducking = applyWindowsAudioDuckingPolicy(
        WindowsAudioSessionUse::RemotePlayback, [&](bool opt_out) {
          ++recreation_ducking;
          return opt_out ? S_OK : E_INVALIDARG;
        });
    if (category.status == WindowsAudioPolicyStatus::Applied &&
        ducking.status == WindowsAudioPolicyStatus::Applied) {
      ++recreation_policy_successes;
    }
  }
  require(recreation_categories == 8 && recreation_ducking == 8 &&
              recreation_policy_successes == 8,
          "endpoint recreation did not reapply both audio policies");

  std::cout << "Windows audio session policy tests passed\n";
  return 0;
} catch (const std::exception &error) {
  std::cerr << error.what() << '\n';
  return 1;
}
