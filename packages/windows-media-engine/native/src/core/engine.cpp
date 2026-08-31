#include "core/engine.hpp"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <exception>
#include <future>
#include <map>
#include <mutex>
#include <thread>
#include <utility>

#include "core/room_owner.hpp"

namespace syrnike::windows_media {

namespace {

EngineFailure failure(std::string code, std::string message, std::string stage,
                      bool retryable = false) {
  const auto bounded = [](std::string value, std::size_t maximum) {
    if (value.empty())
      value = "unknown";
    if (value.size() > maximum)
      value.resize(maximum);
    return value;
  };
  return EngineFailure{
      bounded(std::move(code), protocol::kMaximumFailureCodeLength),
      bounded(std::move(message), protocol::kMaximumFailureMessageLength),
      bounded(std::move(stage), protocol::kMaximumFailureStageLength),
      retryable,
  };
}

enum class CommandType {
  Start,
  InstallCredentialLease,
  ApplyDesiredState,
  QuerySnapshot,
  Ping,
  Shutdown,
};

struct ControlReply {
  EngineResult status;
  std::uint64_t accepted_revision = 0;
  bool duplicate = false;
  std::optional<EngineSnapshot> snapshot;
  std::string lease_id;
};

struct Command {
  explicit Command(CommandType value,
                   std::chrono::steady_clock::time_point expires,
                   std::optional<EngineDesiredState> state = std::nullopt,
                   std::optional<CredentialLease> credential = std::nullopt)
      : type(value), expires_at(expires), desired_state(std::move(state)),
        credential_lease(std::move(credential)) {}

  CommandType type;
  std::chrono::steady_clock::time_point expires_at;
  std::optional<EngineDesiredState> desired_state;
  std::optional<CredentialLease> credential_lease;
  std::promise<ControlReply> completion;
  std::mutex commit_mutex;
  bool cancelled = false;
  bool committed = false;
  std::optional<ControlReply> committed_reply;
};

struct ControlMailbox final {
  std::mutex mutex;
  std::condition_variable changed;
  std::deque<std::shared_ptr<Command>> commands;
  // Room completions are lossless ownership transitions. Keep them bounded
  // independently from commands so command saturation cannot discard a
  // disconnect acknowledgement required for shutdown.
  std::deque<RoomConnectionEvent> room_events;
  bool exited = false;
};

ControlReply controlReply(EngineResult status) {
  return ControlReply{std::move(status)};
}

bool validIdentifier(const std::string &value) {
  if (value.empty() || value.size() > kMaximumIdentifierLength)
    return false;
  for (const unsigned char character : value) {
    if (character < 0x21 || character > 0x7e)
      return false;
  }
  return true;
}

bool validServerUrl(const std::string &value) {
  return value.size() <= kMaximumServerUrlLength &&
         (value.starts_with("ws://") || value.starts_with("wss://"));
}

std::optional<EngineFailure>
validateDesiredState(const EngineDesiredState &desired_state) {
  if (desired_state.revision == 0 ||
      desired_state.revision > kMaximumProtocolInteger) {
    return failure("desired_state_invalid",
                   "Desired state revision must be positive",
                   "apply_desired_state");
  }
  if (desired_state.room &&
      (!validIdentifier(desired_state.room->room_id) ||
       !validIdentifier(desired_state.room->participant_identity) ||
       !validIdentifier(desired_state.room->credential_lease_id))) {
    return failure("desired_state_invalid",
                   "Room intent contains an invalid bounded identifier",
                   "apply_desired_state");
  }
  if (desired_state.remote_video_demand.size() > kMaximumRemoteVideoDemands) {
    return failure("desired_state_invalid",
                   "Remote video demand exceeds the bounded entry limit",
                   "apply_desired_state");
  }
  for (const auto &demand : desired_state.remote_video_demand) {
    if (!validIdentifier(demand.participant_identity) ||
        !validIdentifier(demand.publication_id)) {
      return failure(
          "desired_state_invalid",
          "Remote video demand contains an invalid bounded identifier",
          "apply_desired_state");
    }
  }
  return std::nullopt;
}

} // namespace

EngineResult EngineResult::success() {
  return EngineResult{true, std::nullopt};
}

EngineResult EngineResult::fail(EngineFailure value) {
  return EngineResult{false, std::move(value)};
}

const char *engineStateName(EngineState state) noexcept {
  switch (state) {
  case EngineState::Stopped:
    return "stopped";
  case EngineState::Starting:
    return "starting";
  case EngineState::Running:
    return "running";
  case EngineState::Stopping:
    return "stopping";
  case EngineState::Failed:
    return "failed";
  }
  return "failed";
}

const char *trackKindName(TrackKind track) noexcept {
  switch (track) {
  case TrackKind::Microphone:
    return "microphone";
  case TrackKind::Camera:
    return "camera";
  case TrackKind::Screen:
    return "screen";
  case TrackKind::Output:
    return "output";
  }
  return "microphone";
}

const char *roomPublicStateName(RoomStateChangedEvent::State state) noexcept {
  switch (state) {
  case RoomStateChangedEvent::State::Off:
    return "off";
  case RoomStateChangedEvent::State::Connecting:
    return "connecting";
  case RoomStateChangedEvent::State::Connected:
    return "connected";
  case RoomStateChangedEvent::State::Disconnecting:
    return "disconnecting";
  case RoomStateChangedEvent::State::Failed:
    return "failed";
  }
  return "failed";
}

class Engine::Implementation final {
public:
  explicit Implementation(EngineOptions options)
      : options_(std::move(options)),
        mailbox_(std::make_shared<ControlMailbox>()) {
    if (options_.room_transport) {
      const std::weak_ptr weak_mailbox(mailbox_);
      room_owner_ = std::make_unique<RoomOwner>(
          options_.room_transport,
          [weak_mailbox](const RoomConnectionEvent &event) {
            const auto mailbox = weak_mailbox.lock();
            if (!mailbox)
              return;
            {
              std::lock_guard lock(mailbox->mutex);
              if (mailbox->exited)
                return;
              if (mailbox->room_events.size() >= kControlQueueCapacity)
                std::terminate();
              mailbox->room_events.push_back(event);
            }
            mailbox->changed.notify_one();
          });
    }
    control_thread_ = std::thread([this] { controlLoop(); });
  }

  ~Implementation() noexcept {
    if (!control_thread_.joinable())
      return;
    const auto result = shutdown(kShutdownDeadline);
    if (!result.ok && control_thread_.joinable()) {
      // A non-cooperative control thread cannot be safely abandoned. The
      // utility process is the escalation boundary, so fail immediately
      // instead of hiding an unbounded wait in the destructor.
      std::terminate();
    }
  }

  EngineResult registerEventCallback(PublicEventCallback callback) {
    if (!callback) {
      return EngineResult::fail(failure(
          "invalid_event_callback", "Lifecycle event callback must be callable",
          "register_event_callback"));
    }
    if (started_once_.load() || shutdown_requested_.load()) {
      return EngineResult::fail(
          failure("callback_registration_closed",
                  "Lifecycle callback must be registered before startup",
                  "register_event_callback"));
    }
    std::lock_guard lock(callback_mutex_);
    if (callback_) {
      return EngineResult::fail(
          failure("callback_already_registered",
                  "Only one lifecycle callback may be registered",
                  "register_event_callback"));
    }
    callback_ = std::move(callback);
    return EngineResult::success();
  }

  EngineResult
  registerDiagnosticEventCallback(DiagnosticEventCallback callback) {
    if (!callback) {
      return EngineResult::fail(
          failure("invalid_diagnostic_callback",
                  "Diagnostic event callback must be callable",
                  "register_diagnostic_callback"));
    }
    if (started_once_.load() || shutdown_requested_.load()) {
      return EngineResult::fail(
          failure("callback_registration_closed",
                  "Diagnostic callback must be registered before startup",
                  "register_diagnostic_callback"));
    }
    std::lock_guard lock(diagnostic_callback_mutex_);
    if (diagnostic_callback_) {
      return EngineResult::fail(
          failure("callback_already_registered",
                  "Only one diagnostic callback may be registered",
                  "register_diagnostic_callback"));
    }
    diagnostic_callback_ = std::move(callback);
    return EngineResult::success();
  }

  EngineResult start(std::chrono::milliseconds deadline) {
    if (started_once_.exchange(true)) {
      return EngineResult::fail(failure(
          "engine_instance_consumed",
          "A stopped Engine instance cannot be started again", "start"));
    }
    const auto result = submit(CommandType::Start, deadline, "start").status;
    if (!result.ok && result.failure &&
        result.failure->code == "control_deadline_exceeded") {
      shutdown_requested_.store(true);
      startup_gate_.notify_all();
    }
    return result;
  }

  EngineResult ping(std::chrono::milliseconds deadline) {
    if (shutdown_requested_.load()) {
      return EngineResult::fail(failure("engine_stopping",
                                        "Engine shutdown has already started",
                                        "ping", true));
    }
    return submit(CommandType::Ping, deadline, "ping").status;
  }

  InstallCredentialLeaseResult
  installCredentialLease(CredentialLease lease,
                         std::chrono::milliseconds deadline) {
    auto reply = submitCredential(std::move(lease), deadline);
    return InstallCredentialLeaseResult{
        reply.status.ok,
        std::move(reply.lease_id),
        std::move(reply.status.failure),
    };
  }

  ApplyDesiredStateResult
  applyDesiredState(EngineDesiredState desired_state,
                    std::chrono::milliseconds deadline) {
    auto reply = submit(CommandType::ApplyDesiredState, deadline,
                        "apply_desired_state", std::move(desired_state));
    return ApplyDesiredStateResult{
        reply.status.ok,
        reply.accepted_revision,
        reply.duplicate,
        std::move(reply.status.failure),
    };
  }

  QuerySnapshotResult querySnapshot(std::chrono::milliseconds deadline) {
    auto reply = submit(CommandType::QuerySnapshot, deadline, "query_snapshot");
    return QuerySnapshotResult{
        reply.status.ok,
        std::move(reply.snapshot),
        std::move(reply.status.failure),
    };
  }

  EngineResult shutdown(std::chrono::milliseconds deadline) {
    std::lock_guard shutdown_lock(shutdown_api_mutex_);
    if (shutdown_complete_.load()) {
      joinControlThread();
      return EngineResult::success();
    }
    shutdown_requested_.store(true);
    startup_gate_.notify_all();
    const auto result =
        submit(CommandType::Shutdown, deadline, "shutdown").status;
    if (result.ok)
      joinControlThread();
    return result;
  }

  EngineState state() const noexcept { return state_.load(); }

private:
  ControlReply
  submit(CommandType type, std::chrono::milliseconds deadline,
         const char *stage,
         std::optional<EngineDesiredState> desired_state = std::nullopt,
         std::optional<CredentialLease> credential_lease = std::nullopt) {
    try {
      auto command = std::make_shared<Command>(
          type, std::chrono::steady_clock::now() + deadline,
          std::move(desired_state), std::move(credential_lease));
      auto completed = command->completion.get_future();
      {
        std::lock_guard lock(mailbox_->mutex);
        if (type != CommandType::Shutdown && shutdown_requested_.load()) {
          return controlReply(EngineResult::fail(
              failure("engine_stopping", "Engine shutdown has already started",
                      stage, true)));
        }
        if (mailbox_->exited) {
          return type == CommandType::Shutdown
                     ? controlReply(EngineResult::success())
                     : controlReply(EngineResult::fail(failure(
                           "engine_stopped",
                           "Engine control thread has stopped", stage)));
        }
        const auto capacity = type == CommandType::Shutdown
                                  ? kControlQueueCapacity
                                  : kControlQueueCapacity - 1;
        if (mailbox_->commands.size() >= capacity) {
          return controlReply(EngineResult::fail(
              failure("control_queue_full", "Engine control queue is full",
                      stage, true)));
        }
        mailbox_->commands.push_back(command);
      }
      mailbox_->changed.notify_one();
      if (completed.wait_until(command->expires_at) !=
          std::future_status::ready) {
        if (type == CommandType::ApplyDesiredState ||
            type == CommandType::InstallCredentialLease) {
          std::unique_lock commit_lock(command->commit_mutex);
          if (command->committed_reply)
            return *command->committed_reply;
          command->cancelled = true;
        }
        return controlReply(EngineResult::fail(failure(
            "control_deadline_exceeded",
            "Engine control operation exceeded its deadline", stage, true)));
      }
      return completed.get();
    } catch (const std::exception &error) {
      return controlReply(EngineResult::fail(
          failure("control_submission_failed", error.what(), stage)));
    } catch (...) {
      return controlReply(EngineResult::fail(
          failure("control_submission_failed",
                  "Unknown control submission failure", stage)));
    }
  }

  ControlReply submitCredential(CredentialLease lease,
                                std::chrono::milliseconds deadline) {
    return submit(CommandType::InstallCredentialLease, deadline,
                  "install_credential_lease", std::nullopt, std::move(lease));
  }

  void controlLoop() noexcept {
    while (true) {
      std::shared_ptr<Command> command;
      std::optional<RoomConnectionEvent> room_event;
      {
        std::unique_lock lock(mailbox_->mutex);
        mailbox_->changed.wait(lock, [this] {
          return !mailbox_->commands.empty() || !mailbox_->room_events.empty();
        });
        if (!mailbox_->room_events.empty()) {
          room_event = std::move(mailbox_->room_events.front());
          mailbox_->room_events.pop_front();
        } else {
          command = std::move(mailbox_->commands.front());
          mailbox_->commands.pop_front();
        }
      }

      try {
        if (room_event) {
          handleRoomEvent(*room_event);
        } else {
          auto result = handle(*command);
          if (result) {
            command->completion.set_value(std::move(*result));
            if (command->type == CommandType::Shutdown)
              break;
          } else {
            pending_shutdown_command_ = std::move(command);
          }
        }
      } catch (const std::exception &error) {
        transition(
            EngineState::Failed,
            failure("control_exception", error.what(), "control_thread"));
        const auto result = controlReply(EngineResult::fail(
            failure("control_exception", error.what(), "control_thread")));
        if (command)
          command->completion.set_value(result);
      } catch (...) {
        transition(EngineState::Failed,
                   failure("control_exception",
                           "Unknown exception on the Engine control thread",
                           "control_thread"));
        const auto result = controlReply(EngineResult::fail(
            failure("control_exception",
                    "Unknown exception on the Engine control thread",
                    "control_thread")));
        if (command)
          command->completion.set_value(result);
      }
      if (shutdown_complete_.load())
        break;
    }
    {
      std::lock_guard lock(mailbox_->mutex);
      mailbox_->exited = true;
    }
  }

  std::optional<ControlReply> handle(Command &command) {
    if (command.type != CommandType::Shutdown &&
        std::chrono::steady_clock::now() >= command.expires_at) {
      return controlReply(EngineResult::fail(
          failure("control_deadline_exceeded",
                  "Expired control operation was not executed",
                  "control_thread", true)));
    }
    switch (command.type) {
    case CommandType::Start:
      return controlReply(handleStart());
    case CommandType::InstallCredentialLease:
      return handleInstallCredentialLease(command);
    case CommandType::ApplyDesiredState:
      return handleApplyDesiredState(command);
    case CommandType::QuerySnapshot:
      return handleQuerySnapshot();
    case CommandType::Ping:
      return controlReply(handlePing());
    case CommandType::Shutdown:
      if (auto result = handleShutdown())
        return controlReply(*result);
      return std::nullopt;
    }
    return controlReply(EngineResult::fail(failure(
        "unknown_control_command", "Engine received an unknown control command",
        "control_thread")));
  }

  ControlReply handleApplyDesiredState(Command &command) {
    const auto &desired_state = command.desired_state;
    if (state_.load() != EngineState::Running) {
      return controlReply(EngineResult::fail(
          failure("engine_not_running",
                  "Applying desired state requires the Running state",
                  "apply_desired_state", true)));
    }
    if (!desired_state) {
      return controlReply(EngineResult::fail(
          failure("desired_state_invalid", "Desired state payload is missing",
                  "apply_desired_state")));
    }
    if (auto invalid = validateDesiredState(*desired_state)) {
      return controlReply(EngineResult::fail(std::move(*invalid)));
    }
    if (options_.test_before_apply_commit) {
      options_.test_before_apply_commit();
    }
    std::lock_guard commit_lock(command.commit_mutex);
    if (command.cancelled ||
        std::chrono::steady_clock::now() >= command.expires_at) {
      return controlReply(
          EngineResult::fail(failure("control_deadline_exceeded",
                                     "Expired desired state was not committed",
                                     "apply_desired_state", true)));
    }
    if (accepted_desired_state_) {
      if (desired_state->revision < accepted_desired_state_->revision) {
        return controlReply(EngineResult::fail(failure(
            "stale_revision",
            "Desired state revision is older than the accepted revision",
            "apply_desired_state")));
      }
      if (desired_state->revision == accepted_desired_state_->revision) {
        if (*desired_state != *accepted_desired_state_) {
          return controlReply(EngineResult::fail(failure(
              "revision_conflict",
              "Desired state revision was reused with different content",
              "apply_desired_state")));
        }
        return ControlReply{
            EngineResult::success(),
            accepted_desired_state_->revision,
            true,
        };
      }
    }
    const auto previous = accepted_desired_state_;
    accepted_desired_state_ = *desired_state;
    ControlReply accepted_reply{
        EngineResult::success(),
        accepted_desired_state_->revision,
        false,
    };
    command.committed = true;
    command.committed_reply = accepted_reply;
    emitDesiredStateEvents(previous, *desired_state);
    reconcileRoom(previous, *desired_state);
    emitDiagnostic("desired_state_accepted",
                   static_cast<double>(accepted_desired_state_->revision));
    return accepted_reply;
  }

  ControlReply handleInstallCredentialLease(Command &command) {
    if (state_.load() != EngineState::Running) {
      return controlReply(EngineResult::fail(
          failure("engine_not_running",
                  "Installing a credential lease requires the Running state",
                  "install_credential_lease", true)));
    }
    if (!command.credential_lease ||
        !validIdentifier(command.credential_lease->lease_id) ||
        !validServerUrl(command.credential_lease->server_url) ||
        command.credential_lease->access_token.empty() ||
        command.credential_lease->access_token.size() >
            kMaximumAccessTokenLength) {
      return controlReply(EngineResult::fail(failure(
          "credential_lease_invalid",
          "Credential lease fields are missing or exceed protocol limits",
          "install_credential_lease")));
    }
    if (options_.test_before_credential_commit) {
      options_.test_before_credential_commit();
    }
    std::lock_guard commit_lock(command.commit_mutex);
    if (command.cancelled ||
        std::chrono::steady_clock::now() >= command.expires_at) {
      return controlReply(EngineResult::fail(
          failure("control_deadline_exceeded",
                  "Expired credential lease was not committed",
                  "install_credential_lease", true)));
    }
    if (credential_leases_.size() >= kMaximumCredentialLeases &&
        !credential_leases_.contains(command.credential_lease->lease_id)) {
      return controlReply(
          EngineResult::fail(failure("credential_lease_capacity_exceeded",
                                     "Credential lease capacity is exhausted",
                                     "install_credential_lease", true)));
    }
    const auto lease_id = command.credential_lease->lease_id;
    credential_leases_.insert_or_assign(lease_id,
                                        std::move(*command.credential_lease));
    if (accepted_desired_state_ && accepted_desired_state_->room &&
        accepted_desired_state_->room->credential_lease_id == lease_id &&
        room_public_state_ == RoomStateChangedEvent::State::Failed &&
        room_owner_ &&
        room_owner_->state() == RoomConnectionState::Disconnected) {
      startDesiredRoom(*accepted_desired_state_);
    }
    ControlReply reply{EngineResult::success()};
    reply.lease_id = lease_id;
    command.committed = true;
    command.committed_reply = reply;
    return reply;
  }

  ControlReply handleQuerySnapshot() const {
    if (state_.load() != EngineState::Running) {
      return controlReply(EngineResult::fail(
          failure("engine_not_running",
                  "Querying the snapshot requires the Running state",
                  "query_snapshot", true)));
    }
    ControlReply reply{EngineResult::success()};
    reply.snapshot = EngineSnapshot{
        state_.load(),
        accepted_desired_state_ ? accepted_desired_state_->revision : 0,
        accepted_desired_state_,
        room_public_state_,
        room_failure_,
    };
    return reply;
  }

  EngineResult handleStart() {
    transition(EngineState::Starting);
    if (options_.test_block_start_until_shutdown) {
      std::unique_lock lock(startup_mutex_);
      startup_gate_.wait(lock, [this] { return shutdown_requested_.load(); });
    }
    if (shutdown_requested_.load()) {
      auto cancelled =
          failure("startup_cancelled",
                  "Engine startup was cancelled by shutdown", "start", true);
      transition(EngineState::Failed, cancelled);
      return EngineResult::fail(std::move(cancelled));
    }
    if (options_.fail_start) {
      auto start_failure = failure(
          "startup_failed",
          "Deterministic Engine startup failure was requested", "start");
      transition(EngineState::Failed, start_failure);
      return EngineResult::fail(std::move(start_failure));
    }
    transition(EngineState::Running);
    return EngineResult::success();
  }

  EngineResult handlePing() {
    if (state_.load() != EngineState::Running) {
      return EngineResult::fail(
          failure("engine_not_running",
                  "Engine ping requires the Running state", "ping", true));
    }
    return EngineResult::success();
  }

  std::optional<EngineResult> handleShutdown() {
    transition(EngineState::Stopping);
    if (options_.test_hang_on_shutdown) {
      std::unique_lock lock(hang_mutex_);
      hang_gate_.wait(lock, [] { return false; });
    }
    if (room_owner_) {
      const auto result = room_owner_->beginTeardown();
      if (!result.ok)
        return result;
      if (room_owner_->state() != RoomConnectionState::Disconnected) {
        setRoomPublicState(RoomStateChangedEvent::State::Disconnecting);
        return std::nullopt;
      }
    }
    finishShutdown();
    return EngineResult::success();
  }

  void finishShutdown() {
    transition(EngineState::Stopped);
    credential_leases_.clear();
    accepted_desired_state_.reset();
    active_room_intent_.reset();
    {
      std::lock_guard lock(callback_mutex_);
      callback_ = {};
    }
    {
      std::lock_guard lock(diagnostic_callback_mutex_);
      diagnostic_callback_ = {};
    }
    shutdown_complete_.store(true);
  }

  void completeDeferredShutdown(EngineResult result) {
    if (!pending_shutdown_command_)
      return;
    if (result.ok)
      finishShutdown();
    pending_shutdown_command_->completion.set_value(
        controlReply(std::move(result)));
    pending_shutdown_command_.reset();
  }

  void handleRoomEvent(const RoomConnectionEvent &event) {
    if (room_owner_ && (event.generation != room_owner_->generation() ||
                        event.state != room_owner_->state())) {
      return;
    }
    if (state_.load() == EngineState::Stopping) {
      if (event.state == RoomConnectionState::Disconnected) {
        active_room_intent_.reset();
        setRoomPublicState(RoomStateChangedEvent::State::Off);
        completeDeferredShutdown(EngineResult::success());
        return;
      }
      if (event.state == RoomConnectionState::Connected && !event.failure) {
        const auto teardown = room_owner_->beginTeardown();
        if (!teardown.ok) {
          setRoomPublicState(RoomStateChangedEvent::State::Failed,
                             teardown.failure);
          completeDeferredShutdown(teardown);
        } else {
          setRoomPublicState(RoomStateChangedEvent::State::Disconnecting);
        }
        return;
      }
      if (event.failure) {
        setRoomPublicState(RoomStateChangedEvent::State::Failed, event.failure);
        completeDeferredShutdown(EngineResult::fail(*event.failure));
        return;
      }
      setRoomPublicState(RoomStateChangedEvent::State::Off);
      completeDeferredShutdown(EngineResult::success());
      return;
    }
    if (event.state == RoomConnectionState::Disconnected &&
        (!accepted_desired_state_ || !accepted_desired_state_->room)) {
      // RoomOwner state changes before its callback enters this mailbox. An
      // accepted off intent can therefore settle Off while an older failed
      // connect completion is between those two operations. Disconnected is
      // already the authoritative target state, so that stale failure must not
      // overwrite Off for the same generation.
      active_room_intent_.reset();
      setRoomPublicState(RoomStateChangedEvent::State::Off);
      return;
    }
    const bool cancelled = event.state == RoomConnectionState::Disconnected &&
                           event.failure &&
                           event.failure->code == "room_connect_cancelled";
    if (event.failure && !cancelled) {
      setRoomPublicState(RoomStateChangedEvent::State::Failed, event.failure);
      return;
    }
    if (event.state == RoomConnectionState::Connected) {
      const bool active_room_is_desired =
          accepted_desired_state_ && accepted_desired_state_->room &&
          active_room_intent_ == accepted_desired_state_->room;
      if (active_room_is_desired) {
        setRoomPublicState(RoomStateChangedEvent::State::Connected);
      } else {
        const auto teardown = room_owner_->beginTeardown();
        if (!teardown.ok)
          setRoomPublicState(RoomStateChangedEvent::State::Failed,
                             teardown.failure);
        else
          setRoomPublicState(RoomStateChangedEvent::State::Disconnecting);
      }
      return;
    }
    if (event.state != RoomConnectionState::Disconnected)
      return;
    if (accepted_desired_state_ && accepted_desired_state_->room) {
      if (active_room_intent_ != accepted_desired_state_->room) {
        startDesiredRoom(*accepted_desired_state_);
      } else {
        setRoomPublicState(RoomStateChangedEvent::State::Off);
      }
    } else {
      active_room_intent_.reset();
      setRoomPublicState(RoomStateChangedEvent::State::Off);
    }
  }

  void reconcileRoom(const std::optional<EngineDesiredState> &previous,
                     const EngineDesiredState &desired) {
    if (previous && previous->room == desired.room)
      return;
    if (!room_owner_) {
      if (desired.room) {
        setRoomPublicState(RoomStateChangedEvent::State::Failed,
                           failure("room_transport_unavailable",
                                   "Room transport is unavailable",
                                   "room_connect"));
      } else {
        setRoomPublicState(RoomStateChangedEvent::State::Off);
      }
      return;
    }
    const auto state = room_owner_->state();
    if (!desired.room) {
      active_room_intent_.reset();
      const auto result = room_owner_->beginTeardown();
      if (!result.ok) {
        setRoomPublicState(RoomStateChangedEvent::State::Failed,
                           result.failure);
      } else if (room_owner_->state() == RoomConnectionState::Disconnected) {
        setRoomPublicState(RoomStateChangedEvent::State::Off);
      } else {
        setRoomPublicState(RoomStateChangedEvent::State::Disconnecting);
      }
      return;
    }
    if (state != RoomConnectionState::Disconnected) {
      const auto result = room_owner_->beginTeardown();
      if (!result.ok)
        setRoomPublicState(RoomStateChangedEvent::State::Failed,
                           result.failure);
      else
        setRoomPublicState(RoomStateChangedEvent::State::Disconnecting);
      return;
    }
    if (state == RoomConnectionState::Disconnected)
      startDesiredRoom(desired);
  }

  void startDesiredRoom(const EngineDesiredState &desired) {
    if (!room_owner_ || !desired.room)
      return;
    const auto lease =
        credential_leases_.find(desired.room->credential_lease_id);
    if (lease == credential_leases_.end()) {
      setRoomPublicState(
          RoomStateChangedEvent::State::Failed,
          failure("credential_lease_missing",
                  "Desired room references an unavailable credential lease",
                  "room_connect"));
      return;
    }
    auto credential = std::move(lease->second);
    credential_leases_.erase(lease);
    active_room_intent_ = desired.room;
    setRoomPublicState(RoomStateChangedEvent::State::Connecting);
    const auto result = room_owner_->beginConnect(RoomConnectRequest{
        std::move(credential.server_url),
        std::move(credential.access_token),
    });
    if (!result.ok)
      setRoomPublicState(RoomStateChangedEvent::State::Failed, result.failure);
  }

  void setRoomPublicState(
      RoomStateChangedEvent::State state,
      std::optional<EngineFailure> state_failure = std::nullopt) {
    if (room_public_state_ == state && room_failure_ == state_failure)
      return;
    room_public_state_ = state;
    room_failure_ = std::move(state_failure);
    PublicEventCallback callback;
    {
      std::lock_guard lock(callback_mutex_);
      callback = callback_;
    }
    if (!callback)
      return;
    callback(PublicEvent{RoomStateChangedEvent{
        ++event_sequence_,
        accepted_desired_state_ ? accepted_desired_state_->revision : 0,
        room_public_state_,
        room_failure_,
    }});
  }

  void
  transition(EngineState next,
             std::optional<EngineFailure> transition_failure = std::nullopt) {
    const auto previous = state_.exchange(next);
    PublicEventCallback callback;
    {
      std::lock_guard lock(callback_mutex_);
      callback = callback_;
    }
    if (!callback)
      return;
    callback(PublicEvent{LifecycleEvent{
        ++event_sequence_,
        previous,
        next,
        transition_failure,
    }});
    if (next == EngineState::Failed && transition_failure &&
        transition_failure->code != "startup_cancelled") {
      callback(PublicEvent{FatalEngineFailureEvent{
          ++event_sequence_,
          std::move(*transition_failure),
      }});
    }
  }

  void emitDesiredStateEvents(const std::optional<EngineDesiredState> &previous,
                              const EngineDesiredState &desired_state) {
    PublicEventCallback callback;
    {
      std::lock_guard lock(callback_mutex_);
      callback = callback_;
    }
    if (!callback)
      return;
    const bool first_snapshot = !previous.has_value();
    if (first_snapshot) {
      for (const auto track : {
               TrackKind::Microphone,
               TrackKind::Camera,
               TrackKind::Screen,
               TrackKind::Output,
           }) {
        callback(PublicEvent{TrackStateChangedEvent{
            ++event_sequence_,
            desired_state.revision,
            track,
        }});
      }
    }
  }

  void emitDiagnostic(const char *code, double revision) {
    DiagnosticEventCallback callback;
    {
      std::lock_guard lock(diagnostic_callback_mutex_);
      callback = diagnostic_callback_;
    }
    if (!callback)
      return;
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    callback(DiagnosticEvent{
        ++diagnostic_sequence_,
        static_cast<std::uint64_t>(now),
        "engine",
        "apply_desired_state",
        code,
        {DiagnosticMetric{"revision", revision}},
    });
  }

  void joinControlThread() noexcept {
    if (control_thread_.joinable() &&
        control_thread_.get_id() != std::this_thread::get_id()) {
      control_thread_.join();
    }
  }

  EngineOptions options_;
  std::atomic<EngineState> state_{EngineState::Stopped};
  std::atomic_bool started_once_{false};
  std::atomic_bool shutdown_requested_{false};
  std::atomic_bool shutdown_complete_{false};
  std::shared_ptr<ControlMailbox> mailbox_;
  std::thread control_thread_;
  std::shared_ptr<Command> pending_shutdown_command_;
  std::mutex shutdown_api_mutex_;
  std::mutex callback_mutex_;
  PublicEventCallback callback_;
  std::uint64_t event_sequence_ = 0;
  std::mutex diagnostic_callback_mutex_;
  DiagnosticEventCallback diagnostic_callback_;
  std::uint64_t diagnostic_sequence_ = 0;
  std::optional<EngineDesiredState> accepted_desired_state_;
  std::map<std::string, CredentialLease> credential_leases_;
  std::unique_ptr<RoomOwner> room_owner_;
  std::optional<RoomIntent> active_room_intent_;
  RoomStateChangedEvent::State room_public_state_ =
      RoomStateChangedEvent::State::Off;
  std::optional<EngineFailure> room_failure_;
  std::mutex startup_mutex_;
  std::condition_variable startup_gate_;
  std::mutex hang_mutex_;
  std::condition_variable hang_gate_;
};

Engine::Engine(EngineOptions options)
    : implementation_(std::make_unique<Implementation>(options)) {}

Engine::~Engine() noexcept = default;

EngineResult Engine::registerEventCallback(PublicEventCallback callback) {
  return implementation_->registerEventCallback(std::move(callback));
}

EngineResult
Engine::registerDiagnosticEventCallback(DiagnosticEventCallback callback) {
  return implementation_->registerDiagnosticEventCallback(std::move(callback));
}

EngineResult Engine::start(std::chrono::milliseconds deadline) {
  return implementation_->start(deadline);
}

EngineResult Engine::ping(std::chrono::milliseconds deadline) {
  return implementation_->ping(deadline);
}

InstallCredentialLeaseResult
Engine::installCredentialLease(CredentialLease lease,
                               std::chrono::milliseconds deadline) {
  return implementation_->installCredentialLease(std::move(lease), deadline);
}

ApplyDesiredStateResult
Engine::applyDesiredState(EngineDesiredState desired_state,
                          std::chrono::milliseconds deadline) {
  return implementation_->applyDesiredState(std::move(desired_state), deadline);
}

QuerySnapshotResult Engine::querySnapshot(std::chrono::milliseconds deadline) {
  return implementation_->querySnapshot(deadline);
}

EngineResult Engine::shutdown(std::chrono::milliseconds deadline) {
  return implementation_->shutdown(deadline);
}

EngineState Engine::state() const noexcept { return implementation_->state(); }

} // namespace syrnike::windows_media
