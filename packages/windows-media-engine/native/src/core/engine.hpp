#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include "core/protocol_limits.generated.hpp"

namespace syrnike::windows_media {

class RoomTransport;

inline constexpr std::size_t kControlQueueCapacity =
    protocol::kControlQueueCapacity;
inline constexpr std::size_t kEventQueueCapacity =
    protocol::kEventQueueCapacity;
inline constexpr std::size_t kMaximumCredentialLeases =
    protocol::kMaximumCredentialLeases;
inline constexpr std::size_t kMaximumIdentifierLength =
    protocol::kMaximumIdentifierLength;
inline constexpr std::size_t kMaximumServerUrlLength =
    protocol::kMaximumServerUrlLength;
inline constexpr std::size_t kMaximumAccessTokenLength =
    protocol::kMaximumAccessTokenLength;
inline constexpr std::size_t kMaximumRemoteVideoDemands =
    protocol::kMaximumRemoteVideoDemands;
inline constexpr std::uint32_t kMaximumRequestDeadlineMs =
    protocol::kMaximumRequestDeadlineMs;
inline constexpr std::uint64_t kMaximumProtocolInteger = 9007199254740991ULL;
inline constexpr int kProtocolVersion = protocol::kVersion;
inline constexpr auto kStartDeadline =
    std::chrono::milliseconds(protocol::kStartDeadlineMs);
inline constexpr auto kPingDeadline =
    std::chrono::milliseconds(protocol::kPingDeadlineMs);
inline constexpr auto kControlDeadline =
    std::chrono::milliseconds(protocol::kPingDeadlineMs);
inline constexpr auto kShutdownDeadline =
    std::chrono::milliseconds(protocol::kShutdownDeadlineMs);

enum class EngineState {
  Stopped,
  Starting,
  Running,
  Stopping,
  Failed,
};

struct EngineFailure {
  std::string code;
  std::string message;
  std::string stage;
  bool retryable = false;

  bool operator==(const EngineFailure &) const = default;
};

struct EngineResult {
  bool ok = false;
  std::optional<EngineFailure> failure;

  [[nodiscard]] static EngineResult success();
  [[nodiscard]] static EngineResult fail(EngineFailure failure);
};

struct LifecycleEvent {
  std::uint64_t sequence = 0;
  EngineState previous = EngineState::Stopped;
  EngineState state = EngineState::Stopped;
  std::optional<EngineFailure> failure;
};

struct RoomStateChangedEvent {
  std::uint64_t sequence = 0;
  std::uint64_t revision = 0;
  enum class State {
    Off,
    Connecting,
    Connected,
    Disconnecting,
    Failed,
  } state = State::Off;
  std::optional<EngineFailure> failure;
};

enum class TrackKind {
  Microphone,
  Camera,
  Screen,
  Output,
};

struct TrackStateChangedEvent {
  std::uint64_t sequence = 0;
  std::uint64_t revision = 0;
  TrackKind track = TrackKind::Microphone;
};

struct FatalEngineFailureEvent {
  std::uint64_t sequence = 0;
  EngineFailure failure;
};

using PublicEvent =
    std::variant<LifecycleEvent, RoomStateChangedEvent, TrackStateChangedEvent,
                 FatalEngineFailureEvent>;

struct RoomIntent {
  std::string room_id;
  std::string participant_identity;
  std::string credential_lease_id;

  bool operator==(const RoomIntent &) const = default;
};

struct RemoteVideoDemand {
  std::string participant_identity;
  std::string publication_id;

  bool operator==(const RemoteVideoDemand &) const = default;
};

struct TrackIntent {
  enum class State { Off } state = State::Off;

  bool operator==(const TrackIntent &) const = default;
};

struct EngineDesiredState {
  std::uint64_t revision = 0;
  std::optional<RoomIntent> room;
  TrackIntent microphone;
  TrackIntent camera;
  TrackIntent screen;
  TrackIntent output;
  std::vector<RemoteVideoDemand> remote_video_demand;

  bool operator==(const EngineDesiredState &) const = default;
};

struct CredentialLease {
  std::string lease_id;
  std::string server_url;
  std::string access_token;
};

struct InstallCredentialLeaseResult {
  bool ok = false;
  std::string lease_id;
  std::optional<EngineFailure> failure;
};

struct EngineSnapshot {
  EngineState engine_state = EngineState::Stopped;
  std::uint64_t accepted_revision = 0;
  std::optional<EngineDesiredState> desired_state;
  RoomStateChangedEvent::State room_state = RoomStateChangedEvent::State::Off;
  std::optional<EngineFailure> room_failure;
};

struct ApplyDesiredStateResult {
  bool ok = false;
  std::uint64_t accepted_revision = 0;
  bool duplicate = false;
  std::optional<EngineFailure> failure;
};

struct QuerySnapshotResult {
  bool ok = false;
  std::optional<EngineSnapshot> snapshot;
  std::optional<EngineFailure> failure;
};

struct DiagnosticMetric {
  std::string name;
  double value = 0;
};

struct DiagnosticEvent {
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_ms = 0;
  std::string component;
  std::string operation;
  std::string code;
  std::vector<DiagnosticMetric> metrics;
};

using PublicEventCallback = std::function<void(const PublicEvent &)>;
using DiagnosticEventCallback = std::function<void(const DiagnosticEvent &)>;

struct EngineOptions {
  bool fail_start = false;
  bool test_block_start_until_shutdown = false;
  bool test_hang_on_shutdown = false;
  std::function<void()> test_before_apply_commit;
  std::function<void()> test_before_credential_commit;
  std::shared_ptr<RoomTransport> room_transport;
};

class Engine final {
public:
  explicit Engine(EngineOptions options = {});
  ~Engine() noexcept;

  Engine(const Engine &) = delete;
  Engine &operator=(const Engine &) = delete;

  [[nodiscard]] EngineResult
  registerEventCallback(PublicEventCallback callback);
  [[nodiscard]] EngineResult
  registerDiagnosticEventCallback(DiagnosticEventCallback callback);
  [[nodiscard]] EngineResult
  start(std::chrono::milliseconds deadline = kStartDeadline);
  [[nodiscard]] EngineResult
  ping(std::chrono::milliseconds deadline = kPingDeadline);
  [[nodiscard]] InstallCredentialLeaseResult
  installCredentialLease(CredentialLease lease,
                         std::chrono::milliseconds deadline = kControlDeadline);
  [[nodiscard]] ApplyDesiredStateResult
  applyDesiredState(EngineDesiredState desired_state,
                    std::chrono::milliseconds deadline = kControlDeadline);
  [[nodiscard]] QuerySnapshotResult
  querySnapshot(std::chrono::milliseconds deadline = kControlDeadline);
  [[nodiscard]] EngineResult
  shutdown(std::chrono::milliseconds deadline = kShutdownDeadline);
  [[nodiscard]] EngineState state() const noexcept;

private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

[[nodiscard]] const char *engineStateName(EngineState state) noexcept;
[[nodiscard]] const char *trackKindName(TrackKind track) noexcept;
[[nodiscard]] const char *
roomPublicStateName(RoomStateChangedEvent::State state) noexcept;

} // namespace syrnike::windows_media
