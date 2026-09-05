#pragma once

#include "audio/screen_audio_pcm.hpp"
#include "sources/source_registry.hpp"
#include <windows.h>
#include <memory>
#include <string>
#include <thread>

namespace syrnike::windows_media::audio {
enum class ScreenAudioMode { system_exclude_client, include_process_tree };
enum class ScreenAudioState { idle, starting, running, stopping, stopped, failed };
enum class ScreenAudioFailureCode {
  unsupported,
  invalid_target,
  target_exited,
  activation_failed,
  activation_timeout,
  device_lost,
  format_unavailable,
  capture_failed,
  stop_timeout,
  invalid_state,
  publication_failed,
  publication_timeout,
  cancelled,
};
struct ScreenAudioFailure {
  ScreenAudioFailureCode code;
  HRESULT result = S_OK;
  bool utility_retirement_required = false;
};

// A retained process handle and creation time prevent PID-reuse aliasing.
class AudioProcessIdentity final {
 public:
  AudioProcessIdentity(const AudioProcessIdentity&) = delete;
  AudioProcessIdentity& operator=(const AudioProcessIdentity&) = delete;
  ~AudioProcessIdentity();
  static std::shared_ptr<AudioProcessIdentity> fromProcess(std::uint32_t pid,
                                                           std::uint64_t expected_creation_time);
  static std::shared_ptr<AudioProcessIdentity> fromWindow(sources::SourceRegistry&,
                                                          const std::string& source_id);
  static std::shared_ptr<AudioProcessIdentity> current();
  HANDLE handle() const noexcept { return process_; }
  std::uint32_t pid() const noexcept { return pid_; }
  std::uint64_t creationTime() const noexcept { return creation_; }
  bool alive() const noexcept;

 private:
  AudioProcessIdentity(HANDLE process, std::uint32_t pid, std::uint64_t creation)
      : process_(process), pid_(pid), creation_(creation) {}
  HANDLE process_ = nullptr;
  std::uint32_t pid_ = 0;
  std::uint64_t creation_ = 0;
};
struct LoopbackStats {
  std::uint64_t generation = 0, capture_packets = 0, silent_packets = 0;
  std::uint64_t discontinuities = 0, invalid_timestamps = 0;
  std::uint32_t audio_clients = 0, capture_threads = 0, event_handles = 0;
};

// Owns only Windows capture and the PCM port, never Room or screen video.
class ProcessLoopback final {
 public:
  explicit ProcessLoopback(std::shared_ptr<PcmQueue> queue);
  ~ProcessLoopback();
  std::optional<ScreenAudioFailure> start(ScreenAudioMode,
                                          std::shared_ptr<AudioProcessIdentity> target);
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  ScreenAudioState state() const noexcept;
  std::optional<ScreenAudioFailure> failure() const noexcept;
  LoopbackStats stats() const noexcept;

 private:
  void run(ScreenAudioMode, std::shared_ptr<AudioProcessIdentity>, std::uint64_t) noexcept;
  void fail(ScreenAudioFailure) noexcept;
  std::shared_ptr<PcmQueue> queue_;
  HANDLE stop_event_ = nullptr;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  ScreenAudioState state_ = ScreenAudioState::idle;
  std::optional<ScreenAudioFailure> failure_;
  LoopbackStats stats_;
  bool done_ = true;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
