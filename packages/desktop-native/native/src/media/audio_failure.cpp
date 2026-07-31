#include "audio_failure.hpp"

#include <audioclient.h>

namespace syrnike::desktop_native::media {

AudioFailure::AudioFailure(
  AudioFailureKind kind,
  std::string message,
  HRESULT hresult
) : std::runtime_error(std::move(message)),
    kind_(kind),
    hresult_(hresult),
    code_(audioFailureCode(kind)),
    retryable_(audioFailureRetryable(kind)) {}

AudioFailureKind classifyAudioHresult(
  HRESULT result,
  AudioFailureKind fallback
) noexcept {
  if (result == AUDCLNT_E_DEVICE_INVALIDATED ||
      result == AUDCLNT_E_SERVICE_NOT_RUNNING ||
      result == AUDCLNT_E_ENDPOINT_CREATE_FAILED) {
    return AudioFailureKind::EndpointInvalidated;
  }
  if (result == E_ACCESSDENIED) return AudioFailureKind::AccessDenied;
  if (result == AUDCLNT_E_UNSUPPORTED_FORMAT) {
    return AudioFailureKind::FormatUnsupported;
  }
  if (result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) ||
      result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) {
    return AudioFailureKind::DeviceNotFound;
  }
  return fallback;
}

std::string_view audioFailureCode(AudioFailureKind kind) noexcept {
  switch (kind) {
    case AudioFailureKind::DeviceNotFound: return "audio_device_not_found";
    case AudioFailureKind::DefaultEndpointUnavailable:
      return "audio_default_endpoint_unavailable";
    case AudioFailureKind::EndpointInvalidated:
      return "audio_endpoint_invalidated";
    case AudioFailureKind::AccessDenied: return "audio_access_denied";
    case AudioFailureKind::FormatUnsupported:
      return "audio_format_unsupported";
    case AudioFailureKind::ClientStartFailed:
      return "audio_client_start_failed";
    case AudioFailureKind::IoFailed: return "audio_io_failed";
    case AudioFailureKind::OperationTimedOut:
      return "audio_operation_timeout";
    case AudioFailureKind::RollbackFailed:
      return "audio_output_rollback_failed";
    case AudioFailureKind::Unknown: return "audio_unknown";
  }
  return "audio_unknown";
}

bool audioFailureRetryable(AudioFailureKind kind) noexcept {
  return kind != AudioFailureKind::AccessDenied &&
    kind != AudioFailureKind::FormatUnsupported;
}

bool audioFailureAllowsDefaultFallback(AudioFailureKind kind) noexcept {
  return kind == AudioFailureKind::DeviceNotFound ||
    kind == AudioFailureKind::EndpointInvalidated;
}

bool audioFailureCodeAllowsDefaultFallback(std::string_view code) noexcept {
  return code == audioFailureCode(AudioFailureKind::DeviceNotFound) ||
    code == audioFailureCode(AudioFailureKind::EndpointInvalidated);
}

AudioFailureInfo describeAudioFailure(const std::exception& error) {
  if (const auto* audio = dynamic_cast<const AudioFailure*>(&error)) {
    return AudioFailureInfo{
      audio->kind(),
      audio->code(),
      audio->what(),
      audio->hresult(),
      audio->retryable(),
    };
  }
  return AudioFailureInfo{
    AudioFailureKind::Unknown,
    std::string(audioFailureCode(AudioFailureKind::Unknown)),
    error.what(),
    S_OK,
    true,
  };
}

[[noreturn]] void throwAudioFailure(
  HRESULT result,
  std::string message,
  AudioFailureKind fallback
) {
  throw AudioFailure(classifyAudioHresult(result, fallback), std::move(message), result);
}

}  // namespace syrnike::desktop_native::media
