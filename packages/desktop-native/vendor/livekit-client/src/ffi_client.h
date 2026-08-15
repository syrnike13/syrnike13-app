/*
 * Copyright 2023 LiveKit
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an “AS IS” BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>

#include "data_track.pb.h"
#include "livekit/data_track_error.h"
#include "livekit/operation_cancellation.h"
#include "livekit/result.h"
#include "livekit/room_event_types.h"
#include "livekit/stats.h"
#include "livekit/visibility.h"
#include "lk_log.h"
#include "room.pb.h"

namespace livekit {

#ifdef LIVEKIT_TEST_ACCESS
namespace test {
class FfiClientTestAccess;
}
#endif

namespace proto {
class AudioFrameBufferInfo;
class ConnectCallback;
class FfiEvent;
class FfiResponse;
class FfiRequest;
class OwnedTrackPublication;
class OwnedLocalDataTrack;
class OwnedDataTrackStream;
class DataStream;

} // namespace proto

struct RoomOptions;
struct TrackPublishOptions;

enum class FfiOperationErrorCode : std::uint8_t {
  RequestFailed,
  ProtocolError,
  CallbackFailed,
  Timeout,
  Cancelled,
  Shutdown,
  InvalidState,
};

struct FfiOperationError {
  FfiOperationErrorCode code = FfiOperationErrorCode::InvalidState;
  std::string message;
};

template <typename T>
using FfiOperationResult = Result<T, FfiOperationError>;

// A single registered Rust FFI operation. The handle owns the pending
// registration until a callback, cancellation, or deadline wins. Destroying an
// unfinished handle removes that registration, so a late callback has nowhere
// to write and cannot fulfill a destroyed promise.
template <typename T>
class [[nodiscard]] FfiOperation {
public:
  using ResultType = FfiOperationResult<T>;
  using AsyncId = std::uint64_t;

  FfiOperation() = default;
  ~FfiOperation() { abandon(); }

  FfiOperation(const FfiOperation&) = delete;
  FfiOperation& operator=(const FfiOperation&) = delete;

  FfiOperation(FfiOperation&& other) noexcept
      : async_id_(std::exchange(other.async_id_, 0)),
        future_(std::move(other.future_)),
        cancel_(std::move(other.cancel_)) {}

  FfiOperation& operator=(FfiOperation&& other) noexcept {
    if (this != &other) {
      abandon();
      async_id_ = std::exchange(other.async_id_, 0);
      future_ = std::move(other.future_);
      cancel_ = std::move(other.cancel_);
    }
    return *this;
  }

  AsyncId asyncId() const noexcept { return async_id_; }
  bool valid() const noexcept { return future_.valid(); }

  ResultType wait() {
    if (!future_.valid()) {
      return invalidState();
    }
    future_.wait();
    return takeResult();
  }

  ResultType wait(const OperationCancellation& cancellation) {
    if (!future_.valid()) {
      return invalidState();
    }
    const auto cancel = cancel_;
    [[maybe_unused]] const auto cancellation_subscription = cancellation.subscribe([cancel] {
      if (cancel) {
        cancel(FfiOperationError{FfiOperationErrorCode::Cancelled, "FFI operation cancelled"});
      }
    });
    future_.wait();
    return takeResult();
  }

  template <typename Rep, typename Period>
  ResultType waitFor(const std::chrono::duration<Rep, Period>& timeout) {
    return waitUntil(std::chrono::steady_clock::now() + timeout);
  }

  template <typename Rep, typename Period>
  ResultType waitFor(
      const std::chrono::duration<Rep, Period>& timeout, const OperationCancellation& cancellation) {
    return waitUntil(std::chrono::steady_clock::now() + timeout, cancellation);
  }

  template <typename Clock, typename Duration>
  ResultType waitUntil(const std::chrono::time_point<Clock, Duration>& deadline) {
    if (!future_.valid()) {
      return invalidState();
    }
    if (future_.wait_until(deadline) == std::future_status::timeout && cancel_) {
      cancel_(FfiOperationError{FfiOperationErrorCode::Timeout, "FFI operation deadline expired"});
    }
    return takeResult();
  }

  template <typename Clock, typename Duration>
  ResultType waitUntil(
      const std::chrono::time_point<Clock, Duration>& deadline, const OperationCancellation& cancellation) {
    if (!future_.valid()) {
      return invalidState();
    }
    const auto cancel = cancel_;
    [[maybe_unused]] const auto cancellation_subscription = cancellation.subscribe([cancel] {
      if (cancel) {
        cancel(FfiOperationError{FfiOperationErrorCode::Cancelled, "FFI operation cancelled"});
      }
    });
    if (future_.wait_until(deadline) == std::future_status::timeout && cancel_) {
      cancel_(FfiOperationError{FfiOperationErrorCode::Timeout, "FFI operation deadline expired"});
    }
    return takeResult();
  }

  bool requestCancel() const {
    return cancel_ &&
      cancel_(FfiOperationError{FfiOperationErrorCode::Cancelled, "FFI operation cancelled"});
  }

  ResultType cancel() {
    if (!future_.valid()) {
      return invalidState();
    }
    requestCancel();
    return takeResult();
  }

private:
  using CancelFn = std::function<bool(FfiOperationError)>;

  FfiOperation(AsyncId async_id, std::future<ResultType> future, CancelFn cancel)
      : async_id_(async_id), future_(std::move(future)), cancel_(std::move(cancel)) {}

  static ResultType invalidState() {
    return ResultType::failure(
        FfiOperationError{FfiOperationErrorCode::InvalidState, "FFI operation has no pending result"});
  }

  ResultType takeResult() {
    try {
      return future_.get();
    } catch (const std::future_error& error) {
      return ResultType::failure(FfiOperationError{
          FfiOperationErrorCode::InvalidState, std::string("FFI operation result is unavailable: ") + error.what()});
    }
  }

  void abandon() noexcept {
    if (future_.valid() && cancel_) {
      try {
        cancel_(FfiOperationError{FfiOperationErrorCode::Cancelled, "FFI operation abandoned"});
      } catch (...) {
        // Destructors must not leak cancellation failures.
      }
    }
  }

  AsyncId async_id_ = 0;
  std::future<ResultType> future_;
  CancelFn cancel_;

  friend class FfiClient;
};

using FfiCallbackFn = void (*)(const uint8_t*, size_t);
extern "C" void livekit_ffi_initialize(FfiCallbackFn cb, bool capture_logs, const char* sdk, const char* sdk_version);

extern "C" void livekit_ffi_dispose();

extern "C" LIVEKIT_INTERNAL_API void ffiEventCallback(const uint8_t* buf, size_t len);

// The FfiClient is used to communicate with the FFI interface of the Rust SDK
// We use the generated protocol messages to facilitate the communication.
class LIVEKIT_INTERNAL_API FfiClient {
public:
  using ListenerId = int;
  using Listener = std::function<void(const proto::FfiEvent&)>;
  using AsyncId = std::uint64_t;

  ~FfiClient();
  FfiClient(const FfiClient&) = delete;
  FfiClient& operator=(const FfiClient&) = delete;
  FfiClient(FfiClient&&) = delete;
  FfiClient& operator=(FfiClient&&) = delete;

  // Access the singleton instance of the FfiClient
  // Note: lazily created, not thread safe
  static FfiClient& instance() noexcept;

  // Must be called before any other FFI usage
  bool initialize(bool capture_logs);

  // Called only once. After calling shutdown(), no further calls into FfiClient
  // are valid.
  void shutdown() noexcept;

  bool isInitialized() const noexcept;

  ListenerId addListener(const Listener& listener, std::string debug_name = "anonymous");
  void removeListener(ListenerId id);

  // Room APIs
  FfiOperation<proto::ConnectCallback> connectAsync(const std::string& url, const std::string& token,
                                                    const RoomOptions& options);

  FfiOperation<void> disconnectAsync(uintptr_t room_handle, DisconnectReason reason);

  // Track APIs
  std::future<std::vector<RtcStats>> getTrackStatsAsync(uintptr_t track_handle);

  std::future<SessionStats> getSessionStatsAsync(uintptr_t room_handle);

  // Participant APIs
  FfiOperation<proto::OwnedTrackPublication> publishTrackAsync(std::uint64_t local_participant_handle,
                                                               std::uint64_t track_handle,
                                                               const TrackPublishOptions& options);
  FfiOperation<void> unpublishTrackAsync(std::uint64_t local_participant_handle, const std::string& track_sid,
                                         bool stop_on_unpublish);
  std::future<void> publishDataAsync(std::uint64_t local_participant_handle, const std::uint8_t* data_ptr,
                                     std::uint64_t data_len, bool reliable,
                                     const std::vector<std::string>& destination_identities, const std::string& topic);
  std::future<void> publishSipDtmfAsync(std::uint64_t local_participant_handle, std::uint32_t code,
                                        const std::string& digit,
                                        const std::vector<std::string>& destination_identities);
  std::future<void> setLocalMetadataAsync(std::uint64_t local_participant_handle, const std::string& metadata);
  FfiOperation<void> captureAudioFrameAsync(std::uint64_t source_handle, const proto::AudioFrameBufferInfo& buffer);
  std::future<std::string> performRpcAsync(std::uint64_t local_participant_handle,
                                           const std::string& destination_identity, const std::string& method,
                                           const std::string& payload,
                                           std::optional<std::uint32_t> response_timeout_ms = std::nullopt);

  // Data Track APIs
  std::future<Result<proto::OwnedLocalDataTrack, PublishDataTrackError>> publishDataTrackAsync(
      std::uint64_t local_participant_handle, const std::string& track_name);

  Result<proto::OwnedDataTrackStream, SubscribeDataTrackError> subscribeDataTrack(
      std::uint64_t track_handle, std::optional<std::uint32_t> buffer_size = std::nullopt);

  // Data stream functionalities
  std::future<void> sendStreamHeaderAsync(std::uint64_t local_participant_handle,
                                          const proto::DataStream::Header& header,
                                          const std::vector<std::string>& destination_identities,
                                          const std::string& sender_identity);
  std::future<void> sendStreamChunkAsync(std::uint64_t local_participant_handle, const proto::DataStream::Chunk& chunk,
                                         const std::vector<std::string>& destination_identities,
                                         const std::string& sender_identity);
  std::future<void> sendStreamTrailerAsync(std::uint64_t local_participant_handle,
                                           const proto::DataStream::Trailer& trailer,
                                           const std::string& sender_identity);

  // Generic function for sending a request to the Rust FFI.
  // Note: For asynchronous requests, use the dedicated async functions instead
  // of sendRequest.
  proto::FfiResponse sendRequest(const proto::FfiRequest& request) const;

private:
  struct CancellationGate {
    std::mutex mutex;
    FfiClient* client = nullptr;
  };

  FfiClient();

  /// Lifecycle state of the FfiClient
  /// This is used to prevent race conditions/use-after-free scenarios
  enum class LifecycleState : std::uint8_t {
    Uninitialized,
    Initializing,
    Initialized,
    ShuttingDown,
  };

  // Base class for type-erased pending ops
  struct PendingBase {
    AsyncId async_id = 0; // Client-generated async ID for cancellation
    virtual ~PendingBase() = default;
    virtual bool matches(const proto::FfiEvent& event) const = 0;
    virtual void complete(const proto::FfiEvent& event) = 0;
    virtual void cancel(FfiOperationError error) = 0;
  };
  template <typename T>
  struct Pending : PendingBase {
    std::promise<T> promise;
    std::function<bool(const proto::FfiEvent&)> match;
    std::function<void(const proto::FfiEvent&, std::promise<T>&)> handler;

    bool matches(const proto::FfiEvent& event) const override { return match && match(event); }

    void complete(const proto::FfiEvent& event) override { handler(event, promise); }

    void cancel(FfiOperationError error) override {
      try {
        promise.set_exception(std::make_exception_ptr(std::runtime_error(std::move(error.message))));
      } catch (const std::future_error& e) {
        // Unlikely to throw here as the promise should be satisfied before
        // cancel() Logging a debug message to avoid clang empty catch warning
        LK_LOG_DEBUG("FfiClient::cancel: promise already satisfied: {}", e.what());
      }
    }
  };

  template <typename T>
  struct OperationPending : PendingBase {
    using ResultType = FfiOperationResult<T>;

    std::promise<ResultType> promise;
    std::function<bool(const proto::FfiEvent&)> match;
    std::function<ResultType(const proto::FfiEvent&)> handler;

    bool matches(const proto::FfiEvent& event) const override { return match && match(event); }

    void complete(const proto::FfiEvent& event) override {
      try {
        promise.set_value(handler(event));
      } catch (const std::exception& e) {
        promise.set_value(ResultType::failure(FfiOperationError{FfiOperationErrorCode::CallbackFailed, e.what()}));
      } catch (...) {
        promise.set_value(ResultType::failure(
            FfiOperationError{FfiOperationErrorCode::CallbackFailed, "Unknown FFI callback failure"}));
      }
    }

    void cancel(FfiOperationError error) override {
      try {
        promise.set_value(ResultType::failure(std::move(error)));
      } catch (const std::future_error& e) {
        LK_LOG_DEBUG("FfiClient::cancel: operation promise already satisfied: {}", e.what());
      }
    }
  };

  /// Additional data structure to track listener callbacks and their state.
  /// This is used to coordinate the FFI thread and the app thread, and prevent race conditions/use-after-free scenarios
  struct ListenerSlot {
    ListenerSlot(Listener cb, std::string name) : listener(std::move(cb)), debug_name(std::move(name)) {}

    /// The user-provided listener callback
    Listener listener;
    /// Temporary runtime diagnostic label for identifying a failing listener.
    std::string debug_name;
    /// Mutex to protect the listener slot
    std::mutex mutex;
    /// Condition variable to wait for the listener to finish
    std::condition_variable cv;
    /// Map of thread IDs to the number of active threads
    std::unordered_map<std::thread::id, int> active_threads;
    /// Number of active callbacks
    int active_callbacks = 0;
    /// Whether the listener has been removed (used for race mitigation before removal)
    bool removed = false;
  };

  template <typename T>
  std::future<T> registerAsync(AsyncId async_id, std::function<bool(const proto::FfiEvent&)> match,
                               std::function<void(const proto::FfiEvent&, std::promise<T>&)> handler);

  template <typename T>
  FfiOperation<T> registerOperation(AsyncId async_id, std::function<bool(const proto::FfiEvent&)> match,
                                    std::function<FfiOperationResult<T>(const proto::FfiEvent&)> handler);

  // Generate a unique client-side async ID for request correlation
  AsyncId generateAsyncId();

  // Cancel a pending async operation by its async_id. Returns true if found and
  // removed.
  bool cancelPendingByAsyncId(AsyncId async_id, FfiOperationError error = {FfiOperationErrorCode::Cancelled,
                                                                           "Async operation cancelled"});

#ifdef LIVEKIT_TEST_ACCESS
  using RequestSender = std::function<proto::FfiResponse(const proto::FfiRequest&)>;
  static bool dropHandleForTesting(std::uint64_t handle_id);
#endif

  /// Map of listener IDs to listener slots
  std::unordered_map<ListenerId, std::shared_ptr<ListenerSlot>> listeners_;
  /// Next listener ID to generate
  std::atomic<ListenerId> next_listener_id{1};
  mutable std::mutex lock_;
  std::shared_ptr<CancellationGate> cancellation_gate_;
  /// Map of async IDs to pending operations
  mutable std::unordered_map<AsyncId, std::unique_ptr<PendingBase>> pending_by_id_;
#ifdef LIVEKIT_TEST_ACCESS
  RequestSender request_sender_for_testing_;
#endif
  /// Next async ID to generate
  std::atomic<AsyncId> next_async_id_{1};

  void pushEvent(const proto::FfiEvent& event) const;
  friend void ffiEventCallback(const uint8_t* buf, size_t len);
#ifdef LIVEKIT_TEST_ACCESS
  friend class test::FfiClientTestAccess;
#endif
  std::atomic<LifecycleState> lifecycle_state_{LifecycleState::Uninitialized};
};
} // namespace livekit
