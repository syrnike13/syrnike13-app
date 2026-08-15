#pragma once

#include <audioclient.h>
#include <audiosessiontypes.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string_view>

namespace syrnike::desktop_native::media {

enum class WindowsAudioSessionUse : std::uint8_t {
  MicrophoneCapture,
  RemotePlayback,
  ScreenLoopbackCapture,
};

enum class WindowsAudioPolicyStage : std::uint8_t {
  Category,
  DuckingPreference,
};

enum class WindowsAudioPolicyStatus : std::uint8_t {
  Applied,
  Unsupported,
  Failed,
  NotRequired,
};

struct WindowsAudioPolicyOutcome {
  WindowsAudioSessionUse use = WindowsAudioSessionUse::MicrophoneCapture;
  WindowsAudioPolicyStage stage = WindowsAudioPolicyStage::Category;
  WindowsAudioPolicyStatus status = WindowsAudioPolicyStatus::Unsupported;
  AUDIO_STREAM_CATEGORY category = AudioCategory_Other;
  HRESULT hresult = S_OK;
};

using SetAudioCategory = std::function<HRESULT(AUDIO_STREAM_CATEGORY)>;
using SetDuckingPreference = std::function<HRESULT(bool)>;

enum class WindowsAudioAttemptPhase : std::uint8_t {
  BeforeInitialize,
  Initialize,
  AfterInitialize,
};

struct WindowsAudioAttemptStep {
  WindowsAudioSessionUse use = WindowsAudioSessionUse::MicrophoneCapture;
  WindowsAudioAttemptPhase phase = WindowsAudioAttemptPhase::BeforeInitialize;
  WindowsAudioPolicyStatus status = WindowsAudioPolicyStatus::Unsupported;
  HRESULT hresult = S_OK;
  std::string_view reason_code;
};

struct WindowsAudioSessionAttemptResult {
  WindowsAudioPolicyOutcome category;
  WindowsAudioAttemptStep initialize;
  std::optional<WindowsAudioPolicyOutcome> ducking;
};

using ApplyWindowsAudioCategory = std::function<WindowsAudioPolicyOutcome(
    IAudioClient *, WindowsAudioSessionUse, AUDCLNT_STREAMOPTIONS)>;
using ApplyWindowsAudioDucking = std::function<WindowsAudioPolicyOutcome(
    IAudioClient *, WindowsAudioSessionUse)>;
using ObserveWindowsAudioAttempt =
    std::function<void(const WindowsAudioAttemptStep &)>;

struct WindowsAudioSessionAttemptOperations {
  ApplyWindowsAudioCategory category;
  ApplyWindowsAudioDucking ducking;
};

// Owns the only valid ordering for a Windows audio-client attempt. Category
// policy runs before IAudioClient::Initialize, while render duck opt-out runs
// only after a successful Initialize. Actors share this dependency so every
// endpoint recreation repeats the same typed sequence.
class WindowsAudioSessionAttemptPolicy final {
 public:
  explicit WindowsAudioSessionAttemptPolicy(
      WindowsAudioSessionAttemptOperations operations = {},
      ObserveWindowsAudioAttempt observe = {});

  [[nodiscard]] WindowsAudioSessionAttemptResult run(
      IAudioClient *client, WindowsAudioSessionUse use,
      AUDCLNT_STREAMOPTIONS options,
      const std::function<HRESULT()> &initialize) const noexcept;

 private:
  WindowsAudioSessionAttemptOperations operations_;
  ObserveWindowsAudioAttempt observe_;
};

[[nodiscard]] std::shared_ptr<WindowsAudioSessionAttemptPolicy>
defaultWindowsAudioSessionAttemptPolicy();

[[nodiscard]] constexpr AUDIO_STREAM_CATEGORY
windowsAudioCategory(WindowsAudioSessionUse use) noexcept {
  switch (use) {
  case WindowsAudioSessionUse::MicrophoneCapture:
    return AudioCategory_Other;
  case WindowsAudioSessionUse::RemotePlayback:
    // GameChat retains real-time chat treatment without taking the Media
    // priority that can attenuate a competing GameMedia stream.
    return AudioCategory_GameChat;
  case WindowsAudioSessionUse::ScreenLoopbackCapture:
    // Windows rejects a Media client property on some loopback endpoints
    // with E_INVALIDARG during IAudioClient::Initialize. Other is still a
    // non-communications category and keeps loopback initialization valid.
    return AudioCategory_Other;
  }
  return AudioCategory_Other;
}

[[nodiscard]] constexpr bool
windowsAudioRequiresDuckingOptOut(WindowsAudioSessionUse use) noexcept {
  return use == WindowsAudioSessionUse::RemotePlayback;
}

[[nodiscard]] WindowsAudioPolicyOutcome
applyWindowsAudioCategoryPolicy(WindowsAudioSessionUse use,
                                const SetAudioCategory &set_category) noexcept;

[[nodiscard]] WindowsAudioPolicyOutcome applyWindowsAudioDuckingPolicy(
    WindowsAudioSessionUse use,
    const SetDuckingPreference &set_ducking_preference) noexcept;

[[nodiscard]] WindowsAudioPolicyOutcome applyWindowsAudioCategoryPolicy(
    IAudioClient *client, WindowsAudioSessionUse use,
    AUDCLNT_STREAMOPTIONS options = AUDCLNT_STREAMOPTIONS_NONE) noexcept;

[[nodiscard]] WindowsAudioPolicyOutcome
applyWindowsAudioDuckingPolicy(IAudioClient *client,
                               WindowsAudioSessionUse use) noexcept;

[[nodiscard]] std::string_view
windowsAudioSessionUseName(WindowsAudioSessionUse use) noexcept;
[[nodiscard]] std::string_view
windowsAudioCategoryName(AUDIO_STREAM_CATEGORY category) noexcept;
[[nodiscard]] std::string_view
windowsAudioPolicyStageName(WindowsAudioPolicyStage stage) noexcept;
[[nodiscard]] std::string_view
windowsAudioPolicyStatusName(WindowsAudioPolicyStatus status) noexcept;
[[nodiscard]] std::string_view
windowsAudioPolicyReasonCode(const WindowsAudioPolicyOutcome &outcome) noexcept;
[[nodiscard]] std::string_view
windowsAudioAttemptPhaseName(WindowsAudioAttemptPhase phase) noexcept;

} // namespace syrnike::desktop_native::media
