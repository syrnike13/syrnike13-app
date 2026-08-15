#include "windows_audio_session_policy.hpp"

#include <audiopolicy.h>
#include <wrl/client.h>

#include <utility>

namespace syrnike::desktop_native::media {
namespace {

using Microsoft::WRL::ComPtr;

WindowsAudioPolicyOutcome outcome(
    WindowsAudioSessionUse use,
    WindowsAudioPolicyStage stage,
    HRESULT result) noexcept {
  return {
    .use = use,
    .stage = stage,
    .status = SUCCEEDED(result)
      ? WindowsAudioPolicyStatus::Applied
      : WindowsAudioPolicyStatus::Failed,
    .category = windowsAudioCategory(use),
    .hresult = result,
  };
}

WindowsAudioPolicyOutcome unsupported(
    WindowsAudioSessionUse use,
    WindowsAudioPolicyStage stage,
    HRESULT result) noexcept {
  return {
    .use = use,
    .stage = stage,
    .status = WindowsAudioPolicyStatus::Unsupported,
    .category = windowsAudioCategory(use),
    .hresult = result,
  };
}

WindowsAudioPolicyOutcome interfaceResult(
    WindowsAudioSessionUse use,
    WindowsAudioPolicyStage stage,
    HRESULT result) noexcept {
  const auto effective_result = FAILED(result) ? result : E_NOINTERFACE;
  if (effective_result == E_NOINTERFACE || effective_result == E_NOTIMPL) {
    return unsupported(use, stage, effective_result);
  }
  return outcome(use, stage, effective_result);
}

}  // namespace

WindowsAudioSessionAttemptPolicy::WindowsAudioSessionAttemptPolicy(
    WindowsAudioSessionAttemptOperations operations,
    ObserveWindowsAudioAttempt observe)
    : operations_(std::move(operations)), observe_(std::move(observe)) {
  if (!operations_.category) {
    operations_.category = [](IAudioClient *client,
                              WindowsAudioSessionUse use,
                              AUDCLNT_STREAMOPTIONS options) {
      return applyWindowsAudioCategoryPolicy(client, use, options);
    };
  }
  if (!operations_.ducking) {
    operations_.ducking = [](IAudioClient *client,
                             WindowsAudioSessionUse use) {
      return applyWindowsAudioDuckingPolicy(client, use);
    };
  }
}

WindowsAudioSessionAttemptResult WindowsAudioSessionAttemptPolicy::run(
    IAudioClient *client, WindowsAudioSessionUse use,
    AUDCLNT_STREAMOPTIONS options,
    const std::function<HRESULT()> &initialize) const noexcept {
  WindowsAudioSessionAttemptResult result;
  const auto observe = [&](const WindowsAudioAttemptStep &step) noexcept {
    if (!observe_) return;
    try {
      observe_(step);
    } catch (...) {
      // Policy application must not fail because diagnostic observation did.
    }
  };
  try {
    result.category = operations_.category(client, use, options);
  } catch (...) {
    result.category = outcome(use, WindowsAudioPolicyStage::Category,
                              E_UNEXPECTED);
  }
  observe(WindowsAudioAttemptStep{
      .use = use,
      .phase = WindowsAudioAttemptPhase::BeforeInitialize,
      .status = result.category.status,
      .hresult = result.category.hresult,
      .reason_code = windowsAudioPolicyReasonCode(result.category),
  });

  HRESULT initialize_result = E_POINTER;
  try {
    initialize_result = initialize ? initialize() : E_POINTER;
  } catch (...) {
    initialize_result = E_UNEXPECTED;
  }
  result.initialize = WindowsAudioAttemptStep{
      .use = use,
      .phase = WindowsAudioAttemptPhase::Initialize,
      .status = SUCCEEDED(initialize_result)
          ? WindowsAudioPolicyStatus::Applied
          : WindowsAudioPolicyStatus::Failed,
      .hresult = initialize_result,
      .reason_code = SUCCEEDED(initialize_result)
          ? std::string_view{"audio_client_initialized"}
          : std::string_view{"audio_client_initialize_failed"},
  };
  observe(result.initialize);

  if (SUCCEEDED(initialize_result) &&
      windowsAudioRequiresDuckingOptOut(use)) {
    try {
      result.ducking = operations_.ducking(client, use);
    } catch (...) {
      result.ducking = outcome(
          use, WindowsAudioPolicyStage::DuckingPreference, E_UNEXPECTED);
    }
    observe(WindowsAudioAttemptStep{
        .use = use,
        .phase = WindowsAudioAttemptPhase::AfterInitialize,
        .status = result.ducking->status,
        .hresult = result.ducking->hresult,
        .reason_code = windowsAudioPolicyReasonCode(*result.ducking),
    });
  }
  return result;
}

std::shared_ptr<WindowsAudioSessionAttemptPolicy>
defaultWindowsAudioSessionAttemptPolicy() {
  static auto policy = std::make_shared<WindowsAudioSessionAttemptPolicy>();
  return policy;
}

WindowsAudioPolicyOutcome applyWindowsAudioCategoryPolicy(
    WindowsAudioSessionUse use,
    const SetAudioCategory& set_category) noexcept {
  if (!set_category) {
    return unsupported(use, WindowsAudioPolicyStage::Category, E_NOINTERFACE);
  }
  try {
    return outcome(
      use,
      WindowsAudioPolicyStage::Category,
      set_category(windowsAudioCategory(use))
    );
  } catch (...) {
    return outcome(use, WindowsAudioPolicyStage::Category, E_UNEXPECTED);
  }
}

WindowsAudioPolicyOutcome applyWindowsAudioDuckingPolicy(
    WindowsAudioSessionUse use,
    const SetDuckingPreference& set_ducking_preference) noexcept {
  if (!windowsAudioRequiresDuckingOptOut(use)) {
    return {
      .use = use,
      .stage = WindowsAudioPolicyStage::DuckingPreference,
      .status = WindowsAudioPolicyStatus::NotRequired,
      .category = windowsAudioCategory(use),
      .hresult = S_OK,
    };
  }
  if (!set_ducking_preference) {
    return unsupported(
      use,
      WindowsAudioPolicyStage::DuckingPreference,
      E_NOINTERFACE
    );
  }
  try {
    return outcome(
      use,
      WindowsAudioPolicyStage::DuckingPreference,
      set_ducking_preference(true)
    );
  } catch (...) {
    return outcome(
      use,
      WindowsAudioPolicyStage::DuckingPreference,
      E_UNEXPECTED
    );
  }
}

WindowsAudioPolicyOutcome applyWindowsAudioCategoryPolicy(
    IAudioClient* client,
    WindowsAudioSessionUse use,
    AUDCLNT_STREAMOPTIONS options) noexcept {
  if (!client) {
    return outcome(use, WindowsAudioPolicyStage::Category, E_POINTER);
  }
  ComPtr<IAudioClient2> client2;
  const auto query = client->QueryInterface(IID_PPV_ARGS(&client2));
  if (FAILED(query) || !client2) {
    return interfaceResult(use, WindowsAudioPolicyStage::Category, query);
  }
  return applyWindowsAudioCategoryPolicy(
    use,
    [client2, options](AUDIO_STREAM_CATEGORY category) noexcept {
      AudioClientProperties properties{};
      properties.cbSize = sizeof(properties);
      properties.bIsOffload = FALSE;
      properties.eCategory = category;
      properties.Options = options;
      return client2->SetClientProperties(&properties);
    }
  );
}

WindowsAudioPolicyOutcome applyWindowsAudioDuckingPolicy(
    IAudioClient* client,
    WindowsAudioSessionUse use) noexcept {
  if (!windowsAudioRequiresDuckingOptOut(use)) {
    return applyWindowsAudioDuckingPolicy(use, {});
  }
  if (!client) {
    return outcome(
      use,
      WindowsAudioPolicyStage::DuckingPreference,
      E_POINTER
    );
  }
  ComPtr<IAudioSessionControl> session_control;
  const auto service = client->GetService(IID_PPV_ARGS(&session_control));
  if (FAILED(service) || !session_control) {
    return interfaceResult(
      use,
      WindowsAudioPolicyStage::DuckingPreference,
      service
    );
  }
  ComPtr<IAudioSessionControl2> session_control2;
  const auto query = session_control.As(&session_control2);
  if (FAILED(query) || !session_control2) {
    return interfaceResult(
      use,
      WindowsAudioPolicyStage::DuckingPreference,
      query
    );
  }
  return applyWindowsAudioDuckingPolicy(
    use,
    [session_control2](bool opt_out) noexcept {
      return session_control2->SetDuckingPreference(opt_out ? TRUE : FALSE);
    }
  );
}

std::string_view windowsAudioSessionUseName(
    WindowsAudioSessionUse use) noexcept {
  switch (use) {
    case WindowsAudioSessionUse::MicrophoneCapture:
      return "microphone_capture";
    case WindowsAudioSessionUse::RemotePlayback:
      return "remote_playback";
    case WindowsAudioSessionUse::ScreenLoopbackCapture:
      return "screen_loopback_capture";
  }
  return "unknown";
}

std::string_view windowsAudioCategoryName(
    AUDIO_STREAM_CATEGORY category) noexcept {
  switch (category) {
    case AudioCategory_Other:
      return "other";
    case AudioCategory_Media:
      return "media";
    case AudioCategory_GameChat:
      return "game_chat";
    case AudioCategory_GameMedia:
      return "game_media";
    default:
      return "unexpected";
  }
}

std::string_view windowsAudioPolicyStageName(
    WindowsAudioPolicyStage stage) noexcept {
  switch (stage) {
    case WindowsAudioPolicyStage::Category:
      return "category";
    case WindowsAudioPolicyStage::DuckingPreference:
      return "ducking_preference";
  }
  return "unknown";
}

std::string_view windowsAudioPolicyStatusName(
    WindowsAudioPolicyStatus status) noexcept {
  switch (status) {
    case WindowsAudioPolicyStatus::Applied:
      return "applied";
    case WindowsAudioPolicyStatus::Unsupported:
      return "unsupported";
    case WindowsAudioPolicyStatus::Failed:
      return "failed";
    case WindowsAudioPolicyStatus::NotRequired:
      return "not_required";
  }
  return "unknown";
}

std::string_view windowsAudioPolicyReasonCode(
    const WindowsAudioPolicyOutcome& outcome_value) noexcept {
  if (outcome_value.status == WindowsAudioPolicyStatus::Applied) {
    return "audio_policy_applied";
  }
  if (outcome_value.status == WindowsAudioPolicyStatus::NotRequired) {
    return "audio_policy_not_required";
  }
  if (outcome_value.stage == WindowsAudioPolicyStage::Category) {
    return outcome_value.status == WindowsAudioPolicyStatus::Unsupported
      ? "audio_category_unsupported"
      : "audio_category_failed";
  }
  return outcome_value.status == WindowsAudioPolicyStatus::Unsupported
    ? "audio_ducking_opt_out_unsupported"
    : "audio_ducking_opt_out_failed";
}

std::string_view windowsAudioAttemptPhaseName(
    WindowsAudioAttemptPhase phase) noexcept {
  switch (phase) {
    case WindowsAudioAttemptPhase::BeforeInitialize:
      return "before_initialize";
    case WindowsAudioAttemptPhase::Initialize:
      return "initialize";
    case WindowsAudioAttemptPhase::AfterInitialize:
      return "after_initialize";
  }
  return "unknown";
}

}  // namespace syrnike::desktop_native::media
