#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace syrnike::voice {

struct MicrophoneEchoReferenceStatus {
  bool available = false;
  std::string reason;
};

class MicrophoneEchoReferenceBuffer {
public:
  explicit MicrophoneEchoReferenceBuffer(std::size_t max_frames);

  void pushInterleavedFloatStereo(const float* samples, std::size_t frames, bool silent);
  std::optional<std::vector<std::int16_t>> popFrame();
  std::size_t queuedFrames() const;

private:
  std::size_t max_frames_;
  std::vector<float> pending_mono_;
  std::vector<std::vector<std::int16_t>> frames_;
  mutable std::mutex mutex_;
};

class MicrophoneEchoReference {
public:
  MicrophoneEchoReference();
  ~MicrophoneEchoReference();

  void start();
  void stop();
  std::optional<std::vector<std::int16_t>> popFrame();
  MicrophoneEchoReferenceStatus status() const;

private:
  void captureLoop();
  void setStatus(bool available, std::string reason);

  std::atomic_bool running_{false};
  std::thread thread_;
  MicrophoneEchoReferenceBuffer buffer_;
  mutable std::mutex status_mutex_;
  MicrophoneEchoReferenceStatus status_;
};

}  // namespace syrnike::voice
