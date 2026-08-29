#pragma once

#include <array>
#include <utility>

namespace syrnike::desktop_native::media {

enum class MediaRuntimeShutdownStep {
  JoinVoiceWorkers,
  JoinScreenWorker,
  JoinCameraWorker,
  JoinQueryWorker,
  JoinMicrophoneWorkers,
  ShutdownScreen,
  ShutdownCamera,
  ShutdownPreviewAndMicrophone,
  ShutdownVoice,
};

template <typename Visitor>
void forEachMediaRuntimeShutdownStep(Visitor&& visitor) {
  static constexpr std::array order{
      MediaRuntimeShutdownStep::ShutdownScreen,
      MediaRuntimeShutdownStep::ShutdownCamera,
      MediaRuntimeShutdownStep::ShutdownPreviewAndMicrophone,
      MediaRuntimeShutdownStep::ShutdownVoice,
      MediaRuntimeShutdownStep::JoinVoiceWorkers,
      MediaRuntimeShutdownStep::JoinScreenWorker,
      MediaRuntimeShutdownStep::JoinCameraWorker,
      MediaRuntimeShutdownStep::JoinQueryWorker,
      MediaRuntimeShutdownStep::JoinMicrophoneWorkers,
  };
  for (const auto step : order) std::forward<Visitor>(visitor)(step);
}

}  // namespace syrnike::desktop_native::media
