#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <thread>

namespace syrnike::windows_media::screen {

namespace detail {
struct ProductionScreenSenderState;
}

inline constexpr std::size_t kScreenPublicationEventCapacity = 16;
inline constexpr std::size_t kScreenPublicationVideoCapacity = 2;

struct ScreenTrackDescriptor {
  std::string name;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t frames_per_second = 0;
  std::uint32_t bitrate = 0;
};

// The pointed-to access unit remains owned by the caller's fixed slot pool.
// Ownership transfers on Accepted and returns in exactly one SlotReleased event.
struct EncodedScreenFrame {
  std::uint64_t generation = 0;
  std::uint32_t slot = 0;
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_us = 0;
  bool key_frame = false;
  const std::uint8_t* data = nullptr;
  std::size_t size = 0;
};

struct ScreenPublicationFailure {
  std::string code;
  std::string message;
  std::string stage;
  bool retryable = false;
  bool utility_epoch_retirement_required = false;
};

struct ScreenOperationResult {
  bool ok = true;
  std::optional<ScreenPublicationFailure> failure;

  [[nodiscard]] static ScreenOperationResult success();
  [[nodiscard]] static ScreenOperationResult fail(
      ScreenPublicationFailure failure);
};

using ScreenOperationCompletion =
    std::function<void(std::uint64_t, ScreenOperationResult)>;

// Adapter methods enqueue work onto the Room owner's serialized SDK lane and
// must return without calling LiveKit or waiting for native completion.
class ScreenPublicationAdapter {
 public:
  virtual ~ScreenPublicationAdapter() = default;
  virtual void startPublish(std::uint64_t generation,
                            ScreenTrackDescriptor descriptor,
                            ScreenOperationCompletion completion) = 0;
  virtual void startSubmit(std::uint64_t generation,
                           EncodedScreenFrame frame,
                           ScreenOperationCompletion completion) = 0;
  virtual void startUnpublish(std::uint64_t generation,
                              ScreenOperationCompletion completion) = 0;
};

enum class ScreenPublicationState { Idle, Publishing, Published, Stopping, Failed };

enum class ScreenPublicationEventKind {
  Published,
  SlotReleased,
  Unpublished,
  TerminalFailure,
};

enum class ScreenSlotReleaseReason { Consumed, Superseded, Aborted, Failed };

struct ScreenPublicationEvent {
  ScreenPublicationEventKind kind = ScreenPublicationEventKind::Published;
  std::uint64_t generation = 0;
  std::uint32_t slot = 0;
  ScreenSlotReleaseReason release_reason = ScreenSlotReleaseReason::Consumed;
  std::optional<ScreenPublicationFailure> failure;
};

struct ScreenPublicationDeadlines {
  std::chrono::milliseconds publish{10'000};
  std::chrono::milliseconds submit{2'000};
  std::chrono::milliseconds unpublish{10'000};
};

struct ScreenStartResult {
  bool ok = false;
  std::uint64_t generation = 0;
  std::optional<ScreenPublicationFailure> failure;
};

struct ScreenCommandResult {
  bool ok = false;
  std::optional<ScreenPublicationFailure> failure;
};

enum class ScreenSubmitResult {
  Accepted,
  InvalidState,
  StaleGeneration,
  InvalidFrame,
  EventBackpressure,
};

struct ProductionScreenSenderStats {
  std::uint64_t accepted = 0;
  std::uint64_t consumed = 0;
  std::uint64_t superseded = 0;
  std::uint64_t rejected = 0;
  std::uint64_t terminal_failures = 0;
  std::size_t video_depth = 0;
  std::size_t event_depth = 0;
  std::size_t maximum_video_depth = 0;
};

// Thread-safe bounded command/event port. It never calls LiveKit directly.
class ProductionScreenSender final {
 public:
  explicit ProductionScreenSender(
      std::shared_ptr<ScreenPublicationAdapter> adapter,
      ScreenPublicationDeadlines deadlines = {});
  ~ProductionScreenSender();
  ProductionScreenSender(const ProductionScreenSender&) = delete;
  ProductionScreenSender& operator=(const ProductionScreenSender&) = delete;

  [[nodiscard]] ScreenStartResult start(ScreenTrackDescriptor descriptor);
  [[nodiscard]] ScreenSubmitResult submit(EncodedScreenFrame frame);
  [[nodiscard]] ScreenCommandResult stop(std::uint64_t generation);
  [[nodiscard]] std::optional<ScreenPublicationEvent> waitForEvent(
      std::chrono::milliseconds timeout);
  [[nodiscard]] ScreenPublicationState state() const noexcept;
  [[nodiscard]] std::uint64_t generation() const noexcept;
 [[nodiscard]] ProductionScreenSenderStats stats() const noexcept;

 private:
  void runDeadlineWatchdog() noexcept;

  std::shared_ptr<detail::ProductionScreenSenderState> state_;
  ScreenPublicationDeadlines deadlines_;
  std::thread deadline_watchdog_;
};

}  // namespace syrnike::windows_media::screen
