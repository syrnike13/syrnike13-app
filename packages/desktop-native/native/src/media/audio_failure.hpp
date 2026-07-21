#pragma once

#include <windows.h>

#include <stdexcept>
#include <string>
#include <string_view>

namespace syrnike::desktop_native::media {

enum class AudioFailureKind {
  DeviceNotFound,
  DefaultEndpointUnavailable,
  EndpointInvalidated,
  AccessDenied,
  FormatUnsupported,
  ClientStartFailed,
  IoFailed,
  OperationTimedOut,
  RollbackFailed,
  Unknown,
};

struct AudioFailureInfo {
  AudioFailureKind kind = AudioFailureKind::Unknown;
  std::string code;
  std::string message;
  HRESULT hresult = S_OK;
  bool retryable = true;
};

class AudioFailure final : public std::runtime_error {
 public:
  AudioFailure(AudioFailureKind kind, std::string message, HRESULT hresult);

  [[nodiscard]] AudioFailureKind kind() const noexcept { return kind_; }
  [[nodiscard]] HRESULT hresult() const noexcept { return hresult_; }
  [[nodiscard]] const std::string& code() const noexcept { return code_; }
  [[nodiscard]] bool retryable() const noexcept { return retryable_; }

 private:
  AudioFailureKind kind_;
  HRESULT hresult_;
  std::string code_;
  bool retryable_;
};

[[nodiscard]] AudioFailureKind classifyAudioHresult(
  HRESULT result,
  AudioFailureKind fallback = AudioFailureKind::Unknown
) noexcept;
[[nodiscard]] std::string_view audioFailureCode(AudioFailureKind kind) noexcept;
[[nodiscard]] bool audioFailureRetryable(AudioFailureKind kind) noexcept;
[[nodiscard]] bool audioFailureAllowsDefaultFallback(
  AudioFailureKind kind
) noexcept;
[[nodiscard]] bool audioFailureCodeAllowsDefaultFallback(
  std::string_view code
) noexcept;
[[nodiscard]] AudioFailureInfo describeAudioFailure(const std::exception& error);

[[noreturn]] void throwAudioFailure(
  HRESULT result,
  std::string message,
  AudioFailureKind fallback = AudioFailureKind::Unknown
);

}  // namespace syrnike::desktop_native::media
