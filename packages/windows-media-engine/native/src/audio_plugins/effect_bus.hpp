#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

namespace syrnike::windows_media::audio_plugins {
inline constexpr std::size_t kEffectBusFrameSamples = 480;  // 10 ms at 48 kHz, mono
inline constexpr std::uint32_t kEffectBusMagic = 0x53465842;  // "SFXB"
inline constexpr std::uint32_t kEffectBusVersion = 1;
// The DSP worker waits at most this long for the plugin host; a later frame
// goes through dry. One 10 ms frame leaves room for capture and send.
inline constexpr std::chrono::microseconds kEffectBusDeadline{4000};

// One request/response slot in a named section shared by the microphone DSP
// worker (client) and the plugin host audio thread (server). The client writes
// input only when the server has answered the previous request, so a late host
// never reads a frame that is being overwritten.
struct EffectBusShared {
  std::uint32_t magic = 0;
  std::uint32_t version = 0;
  std::atomic<std::uint64_t> request_sequence{0};
  std::atomic<std::uint64_t> response_sequence{0};
  // The host clears this while its chain is empty or bypassed; the client then
  // skips the round trip entirely.
  std::atomic<std::uint32_t> active{0};
  std::atomic<std::uint32_t> latency_samples{0};
  std::array<float, kEffectBusFrameSamples> input{};
  std::array<float, kEffectBusFrameSamples> output{};
};
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);

// Bus IDs are opaque printable tokens; names stay in the session namespace.
bool validEffectBusId(std::string_view) noexcept;
std::wstring effectBusSectionName(std::string_view id);
std::wstring effectBusRequestEventName(std::string_view id);
std::wstring effectBusResponseEventName(std::string_view id);

struct EffectBusClientStats {
  std::uint64_t processed = 0;
  std::uint64_t timeouts = 0;
  std::uint64_t busy = 0;
};

// Microphone DSP side. Opened on the control thread, used only by the DSP
// worker. process() never allocates and returns false when the frame stays dry.
class EffectBusClient final {
 public:
  static std::unique_ptr<EffectBusClient> open(std::string_view id);
  ~EffectBusClient();
  EffectBusClient(const EffectBusClient&) = delete;
  EffectBusClient& operator=(const EffectBusClient&) = delete;
  bool process(std::array<std::int16_t, kEffectBusFrameSamples>&) noexcept;
  const std::string& id() const noexcept { return id_; }
  EffectBusClientStats stats() const noexcept;
 private:
  EffectBusClient() = default;
  std::string id_;
  void* mapping_ = nullptr;
  void* request_ = nullptr;
  void* response_ = nullptr;
  EffectBusShared* shared_ = nullptr;
  std::atomic<std::uint64_t> processed_{0}, timeouts_{0}, busy_{0};
};

// Plugin host side. Creates the section and both events; one audio thread
// calls serve().
class EffectBusServer final {
 public:
  static std::unique_ptr<EffectBusServer> create(std::string_view id);
  ~EffectBusServer();
  EffectBusServer(const EffectBusServer&) = delete;
  EffectBusServer& operator=(const EffectBusServer&) = delete;
  // Waits up to `wait` for a request. The callback rewrites the frame in place.
  template <typename Process>
  bool serve(std::chrono::milliseconds wait, Process&& process) noexcept {
    if (!waitRequest(wait)) return false;
    const auto sequence = shared_->request_sequence.load(std::memory_order_acquire);
    if (sequence == shared_->response_sequence.load(std::memory_order_relaxed)) return false;
    shared_->output = shared_->input;
    process(shared_->output);
    shared_->response_sequence.store(sequence, std::memory_order_release);
    signalResponse();
    return true;
  }
  void setActive(bool active, std::uint32_t latency_samples) noexcept;
 private:
  EffectBusServer() = default;
  bool waitRequest(std::chrono::milliseconds) noexcept;
  void signalResponse() noexcept;
  void* mapping_ = nullptr;
  void* request_ = nullptr;
  void* response_ = nullptr;
  EffectBusShared* shared_ = nullptr;
};
}  // namespace syrnike::windows_media::audio_plugins
