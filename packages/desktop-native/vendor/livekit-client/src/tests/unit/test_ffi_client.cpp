/*
 * Copyright 2026 LiveKit
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <gtest/gtest.h>
#include <livekit/audio_source.h>
#include <livekit/d3d11_h264_video_source.h>
#include <livekit/livekit.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <condition_variable>
#include <cstdlib>
#include <functional>
#include <future>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>

#include "ffi.pb.h"
#include "ffi_client.h"

namespace cancellation_allocation_probe {

thread_local bool enabled = false;
std::atomic_size_t allocations{0};

class Scope {
public:
  Scope() {
    allocations.store(0, std::memory_order_relaxed);
    enabled = true;
  }

  ~Scope() { enabled = false; }

  Scope(const Scope&) = delete;
  Scope& operator=(const Scope&) = delete;
};

} // namespace cancellation_allocation_probe

void* operator new(std::size_t size) {
  if (cancellation_allocation_probe::enabled) {
    cancellation_allocation_probe::allocations.fetch_add(1, std::memory_order_relaxed);
  }
  if (void* memory = std::malloc(size == 0 ? 1 : size)) {
    return memory;
  }
  throw std::bad_alloc{};
}

void* operator new[](std::size_t size) { return ::operator new(size); }

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { ::operator delete(memory); }
void operator delete(void* memory, std::size_t) noexcept { ::operator delete(memory); }
void operator delete[](void* memory, std::size_t) noexcept { ::operator delete(memory); }

namespace livekit::test {

class FfiClientTestAccess {
public:
  using RequestSender = std::function<proto::FfiResponse(const proto::FfiRequest&)>;

  static void setRequestSender(FfiClient& client, RequestSender sender) {
    const std::scoped_lock<std::mutex> guard(client.lock_);
    client.request_sender_for_testing_ = std::move(sender);
  }

  static std::size_t pendingOperationCount(const FfiClient& client) {
    const std::scoped_lock<std::mutex> guard(client.lock_);
    return client.pending_by_id_.size();
  }

  static std::size_t listenerCount(const FfiClient& client) {
    const std::scoped_lock<std::mutex> guard(client.lock_);
    return client.listeners_.size();
  }

  static bool dropHandle(std::uint64_t handle_id) { return FfiClient::dropHandleForTesting(handle_id); }
};

namespace {

volatile bool g_sigterm_received = false;

// Waits for listener entry or drain completion should finish in milliseconds
// This is a generous anti-hang bound for CI thread scheduling, not expected latency
constexpr auto kListenerSyncTimeout = std::chrono::seconds(5);

// Has to be registered globally per csignal API
void handleSignal(int signal) {
  if (signal == SIGTERM) {
    g_sigterm_received = true;
  }
}

// Simple helper to emit a test event
void emitEvent() {
  proto::FfiEvent event;
  auto* record = event.mutable_logs()->add_records();
  record->set_level(proto::LOG_INFO);
  record->set_target("test");
  record->set_message("listener event");

  std::string bytes;
  ASSERT_TRUE(event.SerializeToString(&bytes));
  ffiEventCallback(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
}

void emitConnectCompletion(FfiClient::AsyncId async_id, std::uint64_t room_handle = 0,
                           std::uint64_t participant_handle = 0) {
  proto::FfiEvent event;
  auto* callback = event.mutable_connect();
  callback->set_async_id(async_id);
  auto* result = callback->mutable_result();
  auto* room = result->mutable_room();
  room->mutable_handle()->set_id(room_handle);
  auto* room_info = room->mutable_info();
  room_info->set_name("test-room");
  room_info->set_metadata("");
  room_info->set_lossy_dc_buffered_amount_low_threshold(0);
  room_info->set_reliable_dc_buffered_amount_low_threshold(0);
  room_info->set_empty_timeout(0);
  room_info->set_departure_timeout(0);
  room_info->set_max_participants(0);
  room_info->set_creation_time(0);
  room_info->set_num_participants(1);
  room_info->set_num_publishers(0);
  room_info->set_active_recording(false);
  auto* participant = result->mutable_local_participant();
  participant->mutable_handle()->set_id(participant_handle);
  auto* participant_info = participant->mutable_info();
  participant_info->set_sid("PA_test");
  participant_info->set_name("test");
  participant_info->set_identity("test");
  participant_info->set_state(proto::PARTICIPANT_STATE_JOINED);
  participant_info->set_metadata("");
  participant_info->set_kind(proto::PARTICIPANT_KIND_STANDARD);
  participant_info->set_disconnect_reason(proto::UNKNOWN_REASON);
  participant_info->set_joined_at(0);
  participant_info->set_client_protocol(0);

  std::string bytes;
  ASSERT_TRUE(event.SerializeToString(&bytes));
  ffiEventCallback(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
}

void emitDisconnectCompletion(FfiClient::AsyncId async_id) {
  proto::FfiEvent event;
  event.mutable_disconnect()->set_async_id(async_id);

  std::string bytes;
  ASSERT_TRUE(event.SerializeToString(&bytes));
  ffiEventCallback(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
}

void emitPublishTrackCompletionWithHandle(FfiClient::AsyncId async_id, std::uint64_t publication_handle) {
  proto::FfiEvent event;
  auto* callback = event.mutable_publish_track();
  callback->set_async_id(async_id);
  auto* publication = callback->mutable_publication();
  publication->mutable_handle()->set_id(publication_handle);
  auto* info = publication->mutable_info();
  info->set_sid("TR_test");
  info->set_name("test");
  info->set_kind(proto::KIND_AUDIO);
  info->set_source(proto::SOURCE_MICROPHONE);
  info->set_simulcasted(false);
  info->set_width(0);
  info->set_height(0);
  info->set_mime_type("audio/opus");
  info->set_muted(false);
  info->set_remote(false);
  info->set_encryption_type(proto::NONE);

  std::string bytes;
  ASSERT_TRUE(event.SerializeToString(&bytes));
  ffiEventCallback(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
}

void emitPublishTrackCompletion(FfiClient::AsyncId async_id) { emitPublishTrackCompletionWithHandle(async_id, 0); }

void emitUnpublishTrackCompletion(FfiClient::AsyncId async_id) {
  proto::FfiEvent event;
  event.mutable_unpublish_track()->set_async_id(async_id);

  std::string bytes;
  ASSERT_TRUE(event.SerializeToString(&bytes));
  ffiEventCallback(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
}

void emitCaptureAudioFrameCompletion(FfiClient::AsyncId async_id) {
  proto::FfiEvent event;
  event.mutable_capture_audio_frame()->set_async_id(async_id);

  std::string bytes;
  ASSERT_TRUE(event.SerializeToString(&bytes));
  ffiEventCallback(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
}

void installSuccessfulOperationSender() {
  FfiClientTestAccess::setRequestSender(FfiClient::instance(), [](const proto::FfiRequest& request) {
    proto::FfiResponse response;
    if (request.has_connect()) {
      response.mutable_connect()->set_async_id(request.connect().request_async_id());
    } else if (request.has_disconnect()) {
      response.mutable_disconnect()->set_async_id(request.disconnect().request_async_id());
    } else if (request.has_publish_track()) {
      response.mutable_publish_track()->set_async_id(request.publish_track().request_async_id());
    } else if (request.has_unpublish_track()) {
      response.mutable_unpublish_track()->set_async_id(request.unpublish_track().request_async_id());
    } else if (request.has_capture_audio_frame()) {
      response.mutable_capture_audio_frame()->set_async_id(request.capture_audio_frame().request_async_id());
    } else {
      throw std::runtime_error("Unexpected request in FFI operation test");
    }
    return response;
  });
}

template <typename StartOperation, typename EmitCompletion>
void verifyOperationLifecycle(StartOperation start_operation, EmitCompletion emit_completion) {
  FfiClientTestAccess::setRequestSender(FfiClient::instance(), [](const proto::FfiRequest&) -> proto::FfiResponse {
    throw std::runtime_error("synthetic synchronous request failure");
  });
  auto request_failure_operation = start_operation();
  auto request_failure = request_failure_operation.waitFor(std::chrono::seconds(1));
  ASSERT_TRUE(request_failure.hasError());
  EXPECT_EQ(request_failure.error().code, FfiOperationErrorCode::RequestFailed);
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);

  installSuccessfulOperationSender();
  auto success_operation = start_operation();
  emit_completion(success_operation.asyncId());
  auto success = success_operation.waitFor(std::chrono::seconds(1));
  EXPECT_TRUE(success.ok());
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);

  auto timeout_operation = start_operation();
  const auto timed_out_id = timeout_operation.asyncId();
  auto timeout = timeout_operation.waitFor(std::chrono::milliseconds(5));
  ASSERT_TRUE(timeout.hasError());
  EXPECT_EQ(timeout.error().code, FfiOperationErrorCode::Timeout);
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
  emit_completion(timed_out_id);
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);

  auto cancellation_operation = start_operation();
  const auto cancelled_id = cancellation_operation.asyncId();
  auto cancelled = cancellation_operation.cancel();
  ASSERT_TRUE(cancelled.hasError());
  EXPECT_EQ(cancelled.error().code, FfiOperationErrorCode::Cancelled);
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
  emit_completion(cancelled_id);
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
}

template <typename T>
void expectRequestFailure(FfiOperation<T> operation) {
  auto result = operation.waitFor(std::chrono::seconds(1));
  ASSERT_TRUE(result.hasError());
  EXPECT_EQ(result.error().code, FfiOperationErrorCode::RequestFailed);
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
}

// Minimal stand-in for Room that mirrors its relationship to FfiClient:
//   - it registers an FFI listener whose callback dereferences `this`
//     (like Room's `[this](const FfiEvent& e){ onEvent(e); }`), and
//   - it tears that listener down in its destructor
//     (like ~Room -> disconnect -> removeListener).
//
// This is the object the user's bug report is about: if the FFI thread is
// dispatching an event into the listener while the object is destroyed,
// the callback must never touch freed memory. `magic_` is a liveness
// sentinel so a use-after-free is observable even without a sanitizer.
class FakeRoom {
public:
  static constexpr std::uint32_t kAlive = 0xA11ECAFEU;
  static constexpr std::uint32_t kDead = 0xDEADBEEFU;

  FakeRoom() {
    listener_id_ = FfiClient::instance().addListener([this](const proto::FfiEvent& e) { onEvent(e); });
  }

  ~FakeRoom() {
    // Mirror ~Room: removeListener() blocks until any in-flight callback
    // for this listener finishes, so onEvent() below can never run against
    // a destroyed FakeRoom.
    FfiClient::instance().removeListener(listener_id_);
    magic_ = kDead;
  }

  FakeRoom(const FakeRoom&) = delete;
  FakeRoom& operator=(const FakeRoom&) = delete;
  FakeRoom(FakeRoom&&) = delete;
  FakeRoom& operator=(FakeRoom&&) = delete;

  void setOnEntered(std::function<void()> fn) { on_entered_ = std::move(fn); }
  void setReleaseGate(std::shared_future<void> gate) { gate_ = std::move(gate); }
  int events() const { return events_.load(); }

private:
  void onEvent(const proto::FfiEvent&) {
    // If `this` were freed mid-dispatch, these reads would observe kDead or
    // garbage (and trip ASan); the listener handshake must keep us alive.
    EXPECT_EQ(magic_, kAlive) << "onEvent ran against a destroyed FakeRoom (use-after-free)";
    if (on_entered_) {
      on_entered_();
    }
    if (gate_.valid()) {
      gate_.wait();
    }
    EXPECT_EQ(magic_, kAlive) << "FakeRoom freed while onEvent was still running";
    ++events_;
  }

  std::uint32_t magic_ = kAlive;
  FfiClient::ListenerId listener_id_ = 0;
  std::function<void()> on_entered_;
  std::shared_future<void> gate_;
  std::atomic<int> events_{0};
};

class TestLocalTrack final : public Track {
public:
  explicit TestLocalTrack(std::uint64_t handle)
      : Track(FfiHandle(static_cast<uintptr_t>(handle)), "TR_source", "test-track", TrackKind::KIND_AUDIO,
              StreamState::STATE_ACTIVE, false, false) {}

  void setPublication(const std::shared_ptr<LocalTrackPublication>& publication) noexcept override {
    publication_ = publication;
  }

  bool published() const noexcept { return publication_ != nullptr; }

private:
  std::shared_ptr<LocalTrackPublication> publication_;
};

struct TestD3D11LeaseState {
  bool accepted = false;
  bool released = false;
};

class TestD3D11TextureLease final : public D3D11TextureLease {
public:
  explicit TestD3D11TextureLease(std::shared_ptr<TestD3D11LeaseState> state)
      : state_(std::move(state)) {
    texture_.shared_handle = 101;
    texture_.adapter_luid = 202;
    texture_.acquire_key = 3;
    texture_.release_key = 4;
    texture_.width = 1280;
    texture_.height = 720;
  }

  const D3D11SharedTexture& texture() const noexcept override { return texture_; }
  void accepted() noexcept override { state_->accepted = true; }
  void release() noexcept override { state_->released = true; }

private:
  std::shared_ptr<TestD3D11LeaseState> state_;
  D3D11SharedTexture texture_{};
};

class TestD3D11VideoSource final : public D3D11H264VideoSource {
public:
  TestD3D11VideoSource() : D3D11H264VideoSource(1280, 720) {}

  using D3D11H264VideoSource::capture;
  bool capture(std::unique_ptr<D3D11TextureLease>, std::int64_t) override { return false; }
};

} // namespace

class FfiClientTest : public ::testing::Test {
protected:
  void SetUp() override {
    // Ensure the singleton for this test case starts up uninitialized
    livekit::shutdown();

    // This assert helps test the livekit::shutdown() <-> FFI client interface
    ASSERT_FALSE(FfiClient::instance().isInitialized());
  }

  void TearDown() override { livekit::shutdown(); }
};

TEST_F(FfiClientTest, Singleton) {
  auto& a = FfiClient::instance();
  auto& b = FfiClient::instance();
  EXPECT_EQ(&a, &b);
}

// ---------------------------------------------------------------------------
// Initialization state
// ---------------------------------------------------------------------------

TEST_F(FfiClientTest, DefaultUninitialized) { EXPECT_FALSE(FfiClient::instance().isInitialized()); }

TEST_F(FfiClientTest, Initialize) {
  EXPECT_TRUE(FfiClient::instance().initialize(false));
  EXPECT_TRUE(FfiClient::instance().isInitialized());
}

TEST_F(FfiClientTest, InitializeFromSDK) {
  EXPECT_TRUE(livekit::initialize(livekit::LogLevel::Info));
  EXPECT_TRUE(FfiClient::instance().isInitialized());
}

TEST_F(FfiClientTest, DoubleInitialize) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  EXPECT_FALSE(FfiClient::instance().initialize(false))
      << "second initialize() on an already-initialized client must be a no-op";
  EXPECT_TRUE(FfiClient::instance().isInitialized());
}

TEST_F(FfiClientTest, Shutdown) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  ASSERT_TRUE(FfiClient::instance().isInitialized());

  FfiClient::instance().shutdown();
  EXPECT_FALSE(FfiClient::instance().isInitialized());
}

TEST_F(FfiClientTest, ShutdownWithoutInitialize) {
  EXPECT_NO_THROW(FfiClient::instance().shutdown());
  EXPECT_FALSE(FfiClient::instance().isInitialized());
}

TEST_F(FfiClientTest, RepeatedShutdown) {
  FfiClient::instance().initialize(false);
  EXPECT_NO_THROW(FfiClient::instance().shutdown());
  EXPECT_NO_THROW(FfiClient::instance().shutdown());
  EXPECT_NO_THROW(FfiClient::instance().shutdown());
}

TEST_F(FfiClientTest, ReinitializeAfterShutdown) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  FfiClient::instance().shutdown();
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  EXPECT_TRUE(FfiClient::instance().initialize(false));
  EXPECT_TRUE(FfiClient::instance().isInitialized());
}

// ---------------------------------------------------------------------------
// addListener / removeListener
// ---------------------------------------------------------------------------

TEST_F(FfiClientTest, AddListenerReturnsNonZeroId) {
  const auto id = FfiClient::instance().addListener([](const proto::FfiEvent&) {});
  EXPECT_NE(id, 0);
  FfiClient::instance().removeListener(id);
}

TEST_F(FfiClientTest, AddListenerReturnsUniqueIds) {
  constexpr int kCount = 16;
  std::unordered_set<FfiClient::ListenerId> ids;
  ids.reserve(kCount);
  for (int i = 0; i < kCount; ++i) {
    const auto id = FfiClient::instance().addListener([](const proto::FfiEvent&) {});
    EXPECT_TRUE(ids.insert(id).second) << "duplicate listener id: " << id;
  }
  for (auto id : ids) {
    FfiClient::instance().removeListener(id);
  }
}

TEST_F(FfiClientTest, RemoveListenerWithUnknownIdIsSafe) {
  EXPECT_NO_THROW(FfiClient::instance().removeListener(424242));
}

TEST_F(FfiClientTest, RemoveListenerIsIdempotent) {
  const auto id = FfiClient::instance().addListener([](const proto::FfiEvent&) {});
  EXPECT_NO_THROW(FfiClient::instance().removeListener(id));
  EXPECT_NO_THROW(FfiClient::instance().removeListener(id));
}

TEST_F(FfiClientTest, ShutdownClearsListenerRegistrations) {
  FfiClient::instance().initialize(false);
  std::atomic<int> listener_calls{0};
  const auto id = FfiClient::instance().addListener([&listener_calls](const proto::FfiEvent&) { ++listener_calls; });
  EXPECT_NE(id, 0);

  FfiClient::instance().shutdown();
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  ASSERT_TRUE(FfiClient::instance().initialize(false));
  emitEvent();
  EXPECT_EQ(listener_calls.load(), 0);
}

TEST_F(FfiClientTest, RemoveListenerWaitsForInFlightCallback) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));

  std::promise<void> callback_entered;
  auto callback_entered_future = callback_entered.get_future();
  std::promise<void> release_callback;
  auto release_callback_future = release_callback.get_future();
  std::atomic<bool> callback_completed{false};

  const auto id = FfiClient::instance().addListener([&](const proto::FfiEvent&) {
    callback_entered.set_value();
    release_callback_future.wait();
    callback_completed.store(true);
  });

  std::thread callback_thread([] { emitEvent(); });
  ASSERT_EQ(callback_entered_future.wait_for(kListenerSyncTimeout), std::future_status::ready);

  auto remove_future = std::async(std::launch::async, [&] { FfiClient::instance().removeListener(id); });
  EXPECT_EQ(remove_future.wait_for(std::chrono::milliseconds(50)), std::future_status::timeout);
  EXPECT_FALSE(callback_completed.load());

  release_callback.set_value();
  callback_thread.join();

  EXPECT_EQ(remove_future.wait_for(kListenerSyncTimeout), std::future_status::ready);
  EXPECT_TRUE(callback_completed.load());
}

// Reproduces the reported "Room event vs. Room destruction" race: the FFI
// thread is inside the listener callback (dereferencing `this`) at the exact
// moment the owning object is destroyed on another thread. ~FakeRoom() ->
// removeListener() must block until the in-flight callback returns, so the
// callback never touches freed memory. Without the ListenerSlot handshake the
// destroy thread would free the FakeRoom while onEvent() is still running.
TEST_F(FfiClientTest, RoomDestructionRace) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));

  std::promise<void> callback_entered;
  auto callback_entered_future = callback_entered.get_future();
  std::promise<void> release_callback;
  const std::shared_future<void> release_callback_future = release_callback.get_future().share();
  std::atomic<bool> entered_once{false};

  auto room = std::make_unique<FakeRoom>();
  room->setReleaseGate(release_callback_future);
  room->setOnEntered([&] {
    if (!entered_once.exchange(true)) {
      callback_entered.set_value();
    }
  });

  // FFI thread dispatches an event; FakeRoom::onEvent is now parked inside the
  // callback holding `this`, waiting on the release gate.
  std::thread ffi_thread([] { emitEvent(); });
  ASSERT_EQ(callback_entered_future.wait_for(kListenerSyncTimeout), std::future_status::ready);

  // Destroy the owner on a different thread while the callback is in flight.
  std::atomic<bool> destroyed{false};
  std::thread destroy_thread([&] {
    room.reset();
    destroyed.store(true);
  });

  // The destructor (removeListener) must block while the callback holds the
  // slot; the FakeRoom must still be alive.
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_FALSE(destroyed.load()) << "destruction completed while a callback was still running";

  // Let the callback finish; destruction should now unblock and complete.
  release_callback.set_value();
  ffi_thread.join();
  destroy_thread.join();
  EXPECT_TRUE(destroyed.load());
}

// Same race exercised under contention: repeatedly create a FakeRoom while a
// background thread floods events, then destroy it. The destroy can land
// before, during, or after dispatch, sweeping the (A) copy-pointer / (B)
// invoke-onEvent window the report describes. Any use-after-free trips the
// magic-sentinel assertions in FakeRoom::onEvent (and ASan, if enabled).
TEST_F(FfiClientTest, RoomDestructionRaceFloodEvents) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));

  std::atomic<bool> stop{false};
  std::thread emitter([&] {
    while (!stop.load(std::memory_order_relaxed)) {
      emitEvent();
    }
  });

  constexpr int kIterations = 500;
  for (int i = 0; i < kIterations; ++i) {
    auto room = std::make_unique<FakeRoom>();
    // Give the emitter a chance to dispatch into this listener before we tear
    // it down, so destruction races against an active/just-finishing callback.
    std::this_thread::yield();
    room.reset(); // ~FakeRoom -> removeListener must drain safely.
  }

  stop.store(true, std::memory_order_relaxed);
  emitter.join();
}

TEST_F(FfiClientTest, ShutdownFromListenerDoesNotDeadlock) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));

  std::atomic<bool> shutdown_returned{false};
  const auto id = FfiClient::instance().addListener([&shutdown_returned](const proto::FfiEvent&) {
    FfiClient::instance().shutdown();
    shutdown_returned.store(true);
  });
  ASSERT_NE(id, 0);

  auto callback_future = std::async(std::launch::async, [] { emitEvent(); });
  EXPECT_EQ(callback_future.wait_for(kListenerSyncTimeout), std::future_status::ready);
  EXPECT_TRUE(shutdown_returned.load());
  EXPECT_FALSE(FfiClient::instance().isInitialized());
}

TEST_F(FfiClientTest, ShutdownRejectsReinitializeAndDropsNewEventsWhileDraining) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));

  std::promise<void> callback_entered;
  auto callback_entered_future = callback_entered.get_future();
  std::promise<void> release_callback;
  auto release_callback_future = release_callback.get_future();
  std::atomic<int> listener_calls{0};

  const auto id = FfiClient::instance().addListener([&](const proto::FfiEvent&) {
    ++listener_calls;
    callback_entered.set_value();
    release_callback_future.wait();
  });
  ASSERT_NE(id, 0);

  std::thread callback_thread([] { emitEvent(); });
  ASSERT_EQ(callback_entered_future.wait_for(kListenerSyncTimeout), std::future_status::ready);

  auto shutdown_future = std::async(std::launch::async, [] { FfiClient::instance().shutdown(); });
  for (int i = 0; i < 5000 && FfiClient::instance().isInitialized(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_FALSE(FfiClient::instance().isInitialized());
  EXPECT_EQ(shutdown_future.wait_for(std::chrono::milliseconds(50)), std::future_status::timeout);
  EXPECT_FALSE(FfiClient::instance().initialize(false));

  emitEvent();
  EXPECT_EQ(listener_calls.load(), 1);

  release_callback.set_value();
  callback_thread.join();
  EXPECT_EQ(shutdown_future.wait_for(kListenerSyncTimeout), std::future_status::ready);
  EXPECT_FALSE(FfiClient::instance().isInitialized());
}

TEST_F(FfiClientTest, ConnectOperationTimeoutRemovesPendingAndIgnoresLateCompletion) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  FfiClientTestAccess::setRequestSender(FfiClient::instance(), [](const proto::FfiRequest& request) {
    proto::FfiResponse response;
    if (request.has_connect()) {
      response.mutable_connect();
    }
    return response;
  });

  RoomOptions options;
  auto operation = FfiClient::instance().connectAsync("wss://localhost:7880", "fake-token", options);
  const auto expired_async_id = operation.asyncId();
  ASSERT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 1U);

  const auto started_at = std::chrono::steady_clock::now();
  auto timeout = operation.waitFor(std::chrono::milliseconds(20));
  const auto elapsed = std::chrono::steady_clock::now() - started_at;

  ASSERT_TRUE(timeout.hasError());
  EXPECT_EQ(timeout.error().code, FfiOperationErrorCode::Timeout);
  EXPECT_LT(elapsed, std::chrono::seconds(1));
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);

  emitConnectCompletion(expired_async_id);
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);

  auto newer_operation = FfiClient::instance().connectAsync("wss://localhost:7880", "new-token", options);
  ASSERT_NE(newer_operation.asyncId(), expired_async_id);
  emitConnectCompletion(newer_operation.asyncId());

  auto success = newer_operation.waitFor(std::chrono::seconds(1));
  EXPECT_TRUE(success.ok());
}

TEST_F(FfiClientTest, LatePublishCompletionReleasesUnclaimedOwnedHandle) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));

  proto::FfiRequest source_request;
  auto* new_source = source_request.mutable_new_audio_source();
  new_source->set_type(proto::AUDIO_SOURCE_NATIVE);
  new_source->set_sample_rate(48000);
  new_source->set_num_channels(1);
  new_source->set_queue_size_ms(0);
  const auto source_response = FfiClient::instance().sendRequest(source_request);
  ASSERT_TRUE(source_response.has_new_audio_source());
  const auto owned_handle = source_response.new_audio_source().source().handle().id();
  ASSERT_NE(owned_handle, 0U);

  installSuccessfulOperationSender();
  TrackPublishOptions options;
  auto operation = FfiClient::instance().publishTrackAsync(42, 43, options);
  const auto expired_async_id = operation.asyncId();
  const auto timeout = operation.waitFor(std::chrono::milliseconds(5));
  ASSERT_TRUE(timeout.hasError());
  ASSERT_EQ(timeout.error().code, FfiOperationErrorCode::Timeout);

  emitPublishTrackCompletionWithHandle(expired_async_id, owned_handle);
  EXPECT_FALSE(FfiClientTestAccess::dropHandle(owned_handle));
}

TEST_F(FfiClientTest, ConnectOperationHasBoundedLifecycle) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  RoomOptions options;
  verifyOperationLifecycle(
      [&options] { return FfiClient::instance().connectAsync("wss://localhost:7880", "fake-token", options); },
      [](FfiClient::AsyncId async_id) { emitConnectCompletion(async_id); });
}

TEST_F(FfiClientTest, D3D11CapturePreservesPacketTrailerFrameIdentity) {
  std::optional<proto::CaptureD3D11VideoFrameRequest> captured_request;
  FfiClientTestAccess::setRequestSender(
      FfiClient::instance(), [&captured_request](const proto::FfiRequest& request) {
        proto::FfiResponse response;
        if (request.has_new_video_source()) {
          response.mutable_new_video_source()->mutable_source()->mutable_handle()->set_id(91);
          return response;
        }
        if (request.has_capture_d3d11_video_frame()) {
          captured_request = request.capture_d3d11_video_frame();
          response.mutable_capture_d3d11_video_frame()->set_accepted(true);
          return response;
        }
        throw std::runtime_error("Unexpected request in D3D11 capture metadata test");
      });

  auto lease_state = std::make_shared<TestD3D11LeaseState>();
  TestD3D11VideoSource source;
  VideoCaptureOptions options;
  options.timestamp_us = 111'111;
  options.metadata = VideoFrameMetadata{};
  options.metadata->user_timestamp_us = 9'999'999;
  options.metadata->frame_id = 73;

  EXPECT_TRUE(source.capture(std::make_unique<TestD3D11TextureLease>(lease_state), options));
  ASSERT_TRUE(captured_request.has_value());
  EXPECT_EQ(captured_request->timestamp_us(), 111'111);
  ASSERT_TRUE(captured_request->has_metadata());
  EXPECT_EQ(captured_request->metadata().user_timestamp(), 9'999'999u);
  EXPECT_EQ(captured_request->metadata().frame_id(), 73u);
  EXPECT_NE(captured_request->timestamp_us(),
            static_cast<std::int64_t>(captured_request->metadata().user_timestamp()));
  EXPECT_TRUE(lease_state->accepted);
  EXPECT_FALSE(lease_state->released);
}

TEST_F(FfiClientTest, CancellationHandleCancelsNeverCompletingOperationAndRepeatedCancelIsHarmless) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  installSuccessfulOperationSender();
  RoomOptions options;
  auto operation = FfiClient::instance().connectAsync("wss://localhost:7880", "fake-token", options);
  ASSERT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 1U);

  OperationCancellation cancellation;
  std::thread canceller([&cancellation] { cancellation.requestCancel(); });
  const auto started_at = std::chrono::steady_clock::now();
  const auto result = operation.waitFor(std::chrono::seconds(1), cancellation);
  canceller.join();
  const auto elapsed = std::chrono::steady_clock::now() - started_at;

  ASSERT_TRUE(result.hasError());
  EXPECT_EQ(result.error().code, FfiOperationErrorCode::Cancelled);
  EXPECT_LT(elapsed, std::chrono::milliseconds(100));
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
  EXPECT_FALSE(operation.requestCancel());
  EXPECT_FALSE(operation.requestCancel());
}

TEST_F(FfiClientTest, CancellationSubscriptionsAreScopedAndOneFailureDoesNotBlockTheRest) {
  OperationCancellation cancellation;
  std::atomic_size_t expired_callbacks{0};
  for (std::size_t iteration = 0; iteration < 10000; ++iteration) {
    [[maybe_unused]] auto expired = cancellation.subscribe([&expired_callbacks] { ++expired_callbacks; });
  }

  [[maybe_unused]] auto throwing =
      cancellation.subscribe([] { throw std::runtime_error("synthetic cancellation callback failure"); });
  std::atomic_size_t active_callbacks{0};
  [[maybe_unused]] auto active = cancellation.subscribe([&active_callbacks] { ++active_callbacks; });
  EXPECT_TRUE(cancellation.requestCancel());
  EXPECT_EQ(expired_callbacks.load(), 0U);
  EXPECT_EQ(active_callbacks.load(), 1U);
  EXPECT_FALSE(cancellation.requestCancel());
}

TEST_F(FfiClientTest, CancellationRequestAllocatesNothingAfterSubscriptionsAreRegistered) {
  OperationCancellation cancellation;
  std::atomic_size_t invoked_callbacks{0};
  [[maybe_unused]] auto first = cancellation.subscribe([&invoked_callbacks] {
    ++invoked_callbacks;
  });
  [[maybe_unused]] auto second = cancellation.subscribe([&invoked_callbacks] {
    ++invoked_callbacks;
  });

  bool first_request = false;
  {
    cancellation_allocation_probe::Scope allocation_scope;
    first_request = cancellation.requestCancel();
  }

  EXPECT_TRUE(first_request);
  EXPECT_TRUE(cancellation.isCancellationRequested());
  EXPECT_EQ(invoked_callbacks.load(), 2U);
  EXPECT_EQ(cancellation_allocation_probe::allocations.load(std::memory_order_acquire), 0U);
}

TEST_F(FfiClientTest, DestroyedCancellationSubscriptionIsSkippedAfterCollection) {
  OperationCancellation cancellation;
  std::mutex mutex;
  std::condition_variable changed;
  bool first_callback_entered = false;
  bool release_first_callback = false;
  std::atomic_bool second_callback_invoked{false};

  [[maybe_unused]] auto first = cancellation.subscribe([&] {
    std::unique_lock lock(mutex);
    first_callback_entered = true;
    changed.notify_all();
    changed.wait(lock, [&] { return release_first_callback; });
  });
  auto second = cancellation.subscribe([&] {
    second_callback_invoked.store(true, std::memory_order_release);
  });

  std::thread canceller([&] { EXPECT_TRUE(cancellation.requestCancel()); });
  bool observed_first_callback = false;
  {
    std::unique_lock lock(mutex);
    observed_first_callback = changed.wait_for(lock, std::chrono::seconds(1), [&] {
      return first_callback_entered;
    });
  }
  EXPECT_TRUE(observed_first_callback);

  second = {};
  {
    const std::scoped_lock lock(mutex);
    release_first_callback = true;
  }
  changed.notify_all();
  canceller.join();

  EXPECT_FALSE(second_callback_invoked.load(std::memory_order_acquire));
}

TEST_F(FfiClientTest, DestroyingCancellationSubscriptionWaitsForConcurrentCallback) {
  OperationCancellation cancellation;
  std::mutex mutex;
  std::condition_variable changed;
  bool callback_entered = false;
  bool release_callback = false;
  auto subscription = cancellation.subscribe([&] {
    std::unique_lock lock(mutex);
    callback_entered = true;
    changed.notify_all();
    changed.wait(lock, [&] { return release_callback; });
  });

  std::thread canceller([&] { EXPECT_TRUE(cancellation.requestCancel()); });
  bool observed_callback = false;
  {
    std::unique_lock lock(mutex);
    observed_callback = changed.wait_for(lock, std::chrono::seconds(1), [&] {
      return callback_entered;
    });
  }
  EXPECT_TRUE(observed_callback);

  std::promise<void> destruction_started;
  std::promise<void> destruction_completed;
  auto destruction_started_future = destruction_started.get_future();
  auto destruction_completed_future = destruction_completed.get_future();
  std::thread destroyer([&] {
    destruction_started.set_value();
    subscription = {};
    destruction_completed.set_value();
  });
  destruction_started_future.wait();
  EXPECT_EQ(
      destruction_completed_future.wait_for(std::chrono::milliseconds(50)),
      std::future_status::timeout);

  {
    const std::scoped_lock lock(mutex);
    release_callback = true;
  }
  changed.notify_all();
  EXPECT_EQ(
      destruction_completed_future.wait_for(std::chrono::seconds(1)),
      std::future_status::ready);
  destroyer.join();
  canceller.join();
}

TEST_F(FfiClientTest, CancellationCallbackCanDestroyItsOwnSubscription) {
  OperationCancellation cancellation;
  std::optional<OperationCancellation::Subscription> subscription;
  std::atomic_bool callback_completed{false};
  subscription.emplace(cancellation.subscribe([&] {
    subscription.reset();
    callback_completed.store(true, std::memory_order_release);
  }));

  auto cancellation_result = std::async(std::launch::async, [&] {
    return cancellation.requestCancel();
  });
  ASSERT_EQ(
      cancellation_result.wait_for(std::chrono::seconds(1)),
      std::future_status::ready);
  EXPECT_TRUE(cancellation_result.get());
  EXPECT_TRUE(callback_completed.load(std::memory_order_acquire));
}

TEST_F(FfiClientTest, LegacyRoomConnectWaitsForFfiCompletionWithoutSdkDeadline) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  std::atomic<FfiClient::AsyncId> connect_async_id{0};
  std::atomic<FfiClient::AsyncId> disconnect_async_id{0};
  FfiClientTestAccess::setRequestSender(
      FfiClient::instance(),
      [&](const proto::FfiRequest& request) {
        proto::FfiResponse response;
        if (request.has_connect()) {
          connect_async_id.store(request.connect().request_async_id(), std::memory_order_release);
          response.mutable_connect()->set_async_id(request.connect().request_async_id());
        } else if (request.has_ready_for_room_event()) {
          response.mutable_ready_for_room_event();
        } else if (request.has_disconnect()) {
          disconnect_async_id.store(request.disconnect().request_async_id(), std::memory_order_release);
          response.mutable_disconnect()->set_async_id(request.disconnect().request_async_id());
        } else {
          throw std::runtime_error("Unexpected request in legacy Room test");
        }
        return response;
      });

  Room room;
  RoomOptions options;
  options.connect_timeout = std::chrono::milliseconds(1);
  options.join_retries = 0;
  auto connect = std::async(std::launch::async, [&] {
    return room.connect("wss://localhost:7880", "fake-token", options);
  });
  const auto entered_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (connect_async_id.load(std::memory_order_acquire) == 0U &&
         std::chrono::steady_clock::now() < entered_deadline) {
    std::this_thread::yield();
  }
  ASSERT_NE(connect_async_id.load(std::memory_order_acquire), 0U);
  EXPECT_EQ(connect.wait_for(std::chrono::milliseconds(50)), std::future_status::timeout);

  emitConnectCompletion(connect_async_id.load(std::memory_order_acquire));
  ASSERT_EQ(connect.wait_for(std::chrono::seconds(1)), std::future_status::ready);
  EXPECT_TRUE(connect.get());

  auto disconnect = std::async(std::launch::async, [&] { return room.disconnect(); });
  const auto disconnect_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (disconnect_async_id.load(std::memory_order_acquire) == 0U &&
         std::chrono::steady_clock::now() < disconnect_deadline) {
    std::this_thread::yield();
  }
  ASSERT_NE(disconnect_async_id.load(std::memory_order_acquire), 0U);
  EXPECT_EQ(disconnect.wait_for(std::chrono::milliseconds(2100)), std::future_status::timeout);
  emitDisconnectCompletion(disconnect_async_id.load(std::memory_order_acquire));
  EXPECT_TRUE(disconnect.get());
}

TEST_F(FfiClientTest, RoomDisconnectUntilRetiresPendingOperationAtDeadline) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  std::atomic<FfiClient::AsyncId> connect_async_id{0};
  std::atomic<FfiClient::AsyncId> disconnect_async_id{0};
  FfiClientTestAccess::setRequestSender(
      FfiClient::instance(),
      [&](const proto::FfiRequest& request) {
        proto::FfiResponse response;
        if (request.has_connect()) {
          connect_async_id.store(request.connect().request_async_id(), std::memory_order_release);
          response.mutable_connect()->set_async_id(request.connect().request_async_id());
        } else if (request.has_ready_for_room_event()) {
          response.mutable_ready_for_room_event();
        } else if (request.has_disconnect()) {
          disconnect_async_id.store(request.disconnect().request_async_id(), std::memory_order_release);
          response.mutable_disconnect()->set_async_id(request.disconnect().request_async_id());
        } else {
          throw std::runtime_error("Unexpected request in bounded Room disconnect test");
        }
        return response;
      });

  Room room;
  auto connect = std::async(std::launch::async, [&] {
    return room.connect("wss://localhost:7880", "fake-token", RoomOptions{});
  });
  const auto connect_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (connect_async_id.load(std::memory_order_acquire) == 0U &&
         std::chrono::steady_clock::now() < connect_deadline) {
    std::this_thread::yield();
  }
  ASSERT_NE(connect_async_id.load(std::memory_order_acquire), 0U);
  emitConnectCompletion(connect_async_id.load(std::memory_order_acquire));
  ASSERT_TRUE(connect.get());

  const auto started_at = std::chrono::steady_clock::now();
  EXPECT_FALSE(room.disconnectUntil(started_at + std::chrono::milliseconds(20)));
  EXPECT_LT(std::chrono::steady_clock::now() - started_at, std::chrono::seconds(1));
  ASSERT_NE(disconnect_async_id.load(std::memory_order_acquire), 0U);
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
  emitDisconnectCompletion(disconnect_async_id.load(std::memory_order_acquire));
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
}

TEST_F(FfiClientTest, RoomConnectCancellationRemovesListenerAndReleasesLateOwnedHandles) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  const auto make_owned_handle = [] {
    proto::FfiRequest request;
    auto* source = request.mutable_new_audio_source();
    source->set_type(proto::AUDIO_SOURCE_NATIVE);
    source->set_sample_rate(48000);
    source->set_num_channels(1);
    source->set_queue_size_ms(0);
    const auto response = FfiClient::instance().sendRequest(request);
    EXPECT_TRUE(response.has_new_audio_source());
    return response.new_audio_source().source().handle().id();
  };
  const auto late_room_handle = make_owned_handle();
  const auto late_participant_handle = make_owned_handle();
  ASSERT_NE(late_room_handle, 0U);
  ASSERT_NE(late_participant_handle, 0U);

  std::atomic<FfiClient::AsyncId> connect_async_id{0};
  FfiClientTestAccess::setRequestSender(FfiClient::instance(), [&connect_async_id](const proto::FfiRequest& request) {
    if (!request.has_connect()) {
      throw std::runtime_error("Unexpected request in cancellable Room test");
    }
    const auto async_id = request.connect().request_async_id();
    connect_async_id.store(async_id, std::memory_order_release);
    proto::FfiResponse response;
    response.mutable_connect()->set_async_id(async_id);
    return response;
  });

  Room room;
  RoomOptions options;
  OperationCancellation cancellation;
  auto connect = std::async(std::launch::async, [&] {
    return room.connect("wss://localhost:7880", "fake-token", options, cancellation);
  });
  const auto entered_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (FfiClientTestAccess::pendingOperationCount(FfiClient::instance()) != 1U &&
         std::chrono::steady_clock::now() < entered_deadline) {
    std::this_thread::yield();
  }
  ASSERT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 1U);
  ASSERT_EQ(FfiClientTestAccess::listenerCount(FfiClient::instance()), 1U);
  ASSERT_NE(connect_async_id.load(std::memory_order_acquire), 0U);

  const auto cancel_started = std::chrono::steady_clock::now();
  EXPECT_TRUE(cancellation.requestCancel());
  EXPECT_FALSE(cancellation.requestCancel());
  ASSERT_EQ(connect.wait_for(std::chrono::milliseconds(100)), std::future_status::ready);
  EXPECT_FALSE(connect.get());
  EXPECT_LT(std::chrono::steady_clock::now() - cancel_started, std::chrono::milliseconds(100));
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
  EXPECT_EQ(FfiClientTestAccess::listenerCount(FfiClient::instance()), 0U);
  EXPECT_EQ(room.connectionState(), ConnectionState::Disconnected);
  EXPECT_TRUE(room.localParticipant().expired());

  emitConnectCompletion(connect_async_id.load(std::memory_order_acquire), late_room_handle, late_participant_handle);
  EXPECT_FALSE(FfiClientTestAccess::dropHandle(late_room_handle));
  EXPECT_FALSE(FfiClientTestAccess::dropHandle(late_participant_handle));
  EXPECT_EQ(FfiClientTestAccess::listenerCount(FfiClient::instance()), 0U);
}

TEST_F(FfiClientTest, DisconnectOperationHasBoundedLifecycle) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  verifyOperationLifecycle([] { return FfiClient::instance().disconnectAsync(42, DisconnectReason::ClientInitiated); },
                           emitDisconnectCompletion);
}

TEST_F(FfiClientTest, PublishTrackOperationHasBoundedLifecycle) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  TrackPublishOptions options;
  verifyOperationLifecycle([&options] { return FfiClient::instance().publishTrackAsync(42, 43, options); },
                           emitPublishTrackCompletion);
}

TEST_F(FfiClientTest, UnpublishTrackOperationHasBoundedLifecycle) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  verifyOperationLifecycle([] { return FfiClient::instance().unpublishTrackAsync(42, "TR_test", true); },
                           emitUnpublishTrackCompletion);
}

TEST_F(FfiClientTest, CaptureAudioFrameOperationHasBoundedLifecycle) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  proto::AudioFrameBufferInfo buffer;
  verifyOperationLifecycle([&buffer] { return FfiClient::instance().captureAudioFrameAsync(42, buffer); },
                           emitCaptureAudioFrameCompletion);
}

TEST_F(FfiClientTest, AudioSourceCaptureFrameAcknowledgementIsStopInterruptible) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  std::atomic<FfiClient::AsyncId> capture_async_id{0};
  FfiClientTestAccess::setRequestSender(
      FfiClient::instance(),
      [&capture_async_id](const proto::FfiRequest& request) {
        proto::FfiResponse response;
        if (request.has_new_audio_source()) {
          response.mutable_new_audio_source()
              ->mutable_source()
              ->mutable_handle()
              ->set_id(42);
          return response;
        }
        if (!request.has_capture_audio_frame()) {
          throw std::runtime_error("Unexpected request in cancellable AudioSource test");
        }
        const auto async_id = request.capture_audio_frame().request_async_id();
        capture_async_id.store(async_id, std::memory_order_release);
        response.mutable_capture_audio_frame()->set_async_id(async_id);
        return response;
      });
  AudioSource source(48000, 2, /*queue_size_ms=*/1000);

  OperationCancellation cancellation;
  auto capture = std::async(std::launch::async, [&] {
    source.captureFrame(
        AudioFrame::create(48000, 2, 480),
        /*timeout_ms=*/1000,
        cancellation);
  });
  const auto entered_deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while ((FfiClientTestAccess::pendingOperationCount(FfiClient::instance()) != 1U ||
          capture_async_id.load(std::memory_order_acquire) == 0U) &&
         std::chrono::steady_clock::now() < entered_deadline) {
    std::this_thread::yield();
  }
  ASSERT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 1U);
  ASSERT_NE(capture_async_id.load(std::memory_order_acquire), 0U);

  const auto cancel_started = std::chrono::steady_clock::now();
  EXPECT_TRUE(cancellation.requestCancel());
  ASSERT_EQ(capture.wait_for(std::chrono::milliseconds(100)), std::future_status::ready);
  EXPECT_THROW(capture.get(), std::runtime_error);
  EXPECT_LT(
      std::chrono::steady_clock::now() - cancel_started,
      std::chrono::milliseconds(100));
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);

  emitCaptureAudioFrameCompletion(capture_async_id.load(std::memory_order_acquire));
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);
}

TEST_F(FfiClientTest, LegacyAudioSourceZeroTimeoutWaitsForFfiCompletion) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  std::atomic<FfiClient::AsyncId> capture_async_id{0};
  FfiClientTestAccess::setRequestSender(
      FfiClient::instance(),
      [&capture_async_id](const proto::FfiRequest& request) {
        proto::FfiResponse response;
        if (request.has_new_audio_source()) {
          response.mutable_new_audio_source()->mutable_source()->mutable_handle()->set_id(42);
        } else if (request.has_capture_audio_frame()) {
          capture_async_id.store(request.capture_audio_frame().request_async_id(), std::memory_order_release);
          response.mutable_capture_audio_frame()->set_async_id(request.capture_audio_frame().request_async_id());
        } else {
          throw std::runtime_error("Unexpected request in legacy AudioSource test");
        }
        return response;
      });
  AudioSource source(48000, 2, /*queue_size_ms=*/0);

  auto capture = std::async(std::launch::async, [&] {
    source.captureFrame(AudioFrame::create(48000, 2, 480), /*timeout_ms=*/0);
  });
  const auto entered_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (capture_async_id.load(std::memory_order_acquire) == 0U &&
         std::chrono::steady_clock::now() < entered_deadline) {
    std::this_thread::yield();
  }
  ASSERT_NE(capture_async_id.load(std::memory_order_acquire), 0U);
  EXPECT_EQ(capture.wait_for(std::chrono::milliseconds(250)), std::future_status::timeout);

  emitCaptureAudioFrameCompletion(capture_async_id.load(std::memory_order_acquire));
  ASSERT_EQ(capture.wait_for(std::chrono::seconds(1)), std::future_status::ready);
  EXPECT_NO_THROW(capture.get());
}

TEST_F(FfiClientTest, LegacyTrackPublicationWaitsPastTheBoundedApiDefault) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  std::atomic<FfiClient::AsyncId> publish_async_id{0};
  std::atomic<FfiClient::AsyncId> unpublish_async_id{0};
  FfiClientTestAccess::setRequestSender(
      FfiClient::instance(),
      [&](const proto::FfiRequest& request) {
        proto::FfiResponse response;
        if (request.has_publish_track()) {
          publish_async_id.store(request.publish_track().request_async_id(), std::memory_order_release);
          response.mutable_publish_track()->set_async_id(request.publish_track().request_async_id());
        } else if (request.has_unpublish_track()) {
          unpublish_async_id.store(request.unpublish_track().request_async_id(), std::memory_order_release);
          response.mutable_unpublish_track()->set_async_id(request.unpublish_track().request_async_id());
        } else {
          throw std::runtime_error("Unexpected request in legacy publication test");
        }
        return response;
      });

  LocalParticipant participant(FfiHandle(42), "PA_test", "test", "test", "", {}, ParticipantKind::Standard,
                               DisconnectReason::Unknown);
  auto track = std::make_shared<TestLocalTrack>(43);
  TrackPublishOptions options;
  auto publish = std::async(std::launch::async, [&] { participant.publishTrack(track, options); });
  const auto publish_entered_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (publish_async_id.load(std::memory_order_acquire) == 0U &&
         std::chrono::steady_clock::now() < publish_entered_deadline) {
    std::this_thread::yield();
  }
  ASSERT_NE(publish_async_id.load(std::memory_order_acquire), 0U);
  EXPECT_EQ(publish.wait_for(std::chrono::milliseconds(10100)), std::future_status::timeout);
  emitPublishTrackCompletion(publish_async_id.load(std::memory_order_acquire));
  ASSERT_EQ(publish.wait_for(std::chrono::seconds(1)), std::future_status::ready);
  EXPECT_NO_THROW(publish.get());
  EXPECT_TRUE(track->published());

  auto unpublish = std::async(std::launch::async, [&] { participant.unpublishTrack("TR_test"); });
  const auto unpublish_entered_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (unpublish_async_id.load(std::memory_order_acquire) == 0U &&
         std::chrono::steady_clock::now() < unpublish_entered_deadline) {
    std::this_thread::yield();
  }
  ASSERT_NE(unpublish_async_id.load(std::memory_order_acquire), 0U);
  EXPECT_EQ(unpublish.wait_for(std::chrono::milliseconds(10100)), std::future_status::timeout);
  emitUnpublishTrackCompletion(unpublish_async_id.load(std::memory_order_acquire));
  ASSERT_EQ(unpublish.wait_for(std::chrono::seconds(1)), std::future_status::ready);
  EXPECT_NO_THROW(unpublish.get());
  EXPECT_FALSE(track->published());
}

TEST_F(FfiClientTest, ShutdownCancelsNeverCompletingOperationAndRemovesPendingRegistration) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  installSuccessfulOperationSender();
  RoomOptions options;
  auto operation = FfiClient::instance().connectAsync("wss://localhost:7880", "fake-token", options);
  ASSERT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 1U);

  FfiClient::instance().shutdown();
  EXPECT_EQ(FfiClientTestAccess::pendingOperationCount(FfiClient::instance()), 0U);

  const auto started_at = std::chrono::steady_clock::now();
  const auto result = operation.waitFor(std::chrono::seconds(1));
  const auto elapsed = std::chrono::steady_clock::now() - started_at;
  ASSERT_TRUE(result.hasError());
  EXPECT_EQ(result.error().code, FfiOperationErrorCode::Shutdown);
  EXPECT_LT(elapsed, std::chrono::milliseconds(100));
}

TEST_F(FfiClientTest, PanicEvent) {
  // Wire up a signal handler to ensure the panic event raises SIGTERM
  // (and that users can handle it)
  g_sigterm_received = false;
  auto previous_handler = std::signal(SIGTERM, handleSignal);
  ASSERT_NE(previous_handler, SIG_ERR);

  // Wire up a listener to ensure the panic event doesn't make it through
  // (matches Python SDK)
  bool listener_called = false;
  const auto id =
      FfiClient::instance().addListener([&listener_called](const proto::FfiEvent&) { listener_called = true; });

  proto::FfiEvent event;
  event.mutable_panic()->set_message("rust panic");
  std::string bytes;
  ASSERT_TRUE(event.SerializeToString(&bytes));

  testing::internal::CaptureStderr();
  ffiEventCallback(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
  const std::string stderr_output = testing::internal::GetCapturedStderr();

  ASSERT_NE(std::signal(SIGTERM, previous_handler), SIG_ERR);
  FfiClient::instance().removeListener(id);

  EXPECT_TRUE(g_sigterm_received);
  EXPECT_FALSE(listener_called);
  EXPECT_NE(stderr_output.find("FFI Panic: rust panic"), std::string::npos);
}

// ---------------------------------------------------------------------------
// These tests ensure FfiClient methods throw in various error conditions
// ---------------------------------------------------------------------------

TEST_F(FfiClientTest, SendRequestThrowsOnEmptyRequest) {
  // A default-constructed FfiRequest has no oneof populated and serializes
  // to zero bytes, which sendRequest treats as a serialization failure.
  // This path is reachable regardless of initialization state.
  proto::FfiRequest req;
  EXPECT_THROW(FfiClient::instance().sendRequest(req), std::runtime_error);
}

TEST_F(FfiClientTest, SendRequestThrowsAfterShutdown) {
  ASSERT_TRUE(FfiClient::instance().initialize(false));
  FfiClient::instance().shutdown();
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  proto::FfiRequest req;
  (void)req.mutable_dispose();

  EXPECT_THROW(FfiClient::instance().sendRequest(req), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_ConnectOperationReportsRequestFailure) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  RoomOptions options;
  expectRequestFailure(FfiClient::instance().connectAsync("wss://localhost:7880", "fake-token", options));
}

TEST_F(FfiClientTest, NotInitialized_DisconnectOperationReportsRequestFailure) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  expectRequestFailure(FfiClient::instance().disconnectAsync(1, DisconnectReason::ClientInitiated));
}

TEST_F(FfiClientTest, NotInitialized_PublishTrackOperationReportsRequestFailure) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  TrackPublishOptions options;
  expectRequestFailure(FfiClient::instance().publishTrackAsync(1, 2, options));
}

TEST_F(FfiClientTest, NotInitialized_UnpublishTrackOperationReportsRequestFailure) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  expectRequestFailure(FfiClient::instance().unpublishTrackAsync(1, "sid", true));
}

TEST_F(FfiClientTest, NotInitialized_PublishDataAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  const std::uint8_t payload[1] = {0};
  EXPECT_THROW(FfiClient::instance().publishDataAsync(1, payload, 1, true, {}, ""), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_PublishSipDtmfAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  EXPECT_THROW(FfiClient::instance().publishSipDtmfAsync(1, 1, "1", {}), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_SetLocalMetadataAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  EXPECT_THROW(FfiClient::instance().setLocalMetadataAsync(1, "metadata"), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_CaptureAudioFrameOperationReportsRequestFailure) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  proto::AudioFrameBufferInfo buf;
  expectRequestFailure(FfiClient::instance().captureAudioFrameAsync(1, buf));
}

TEST_F(FfiClientTest, NotInitialized_PerformRpcAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  EXPECT_THROW(FfiClient::instance().performRpcAsync(1, "dest", "method", "payload", std::nullopt), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_GetTrackStatsAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  EXPECT_THROW(FfiClient::instance().getTrackStatsAsync(1), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_GetSessionStatsAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  EXPECT_THROW(FfiClient::instance().getSessionStatsAsync(1), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_PublishDataTrackAsyncFails) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  auto fut_result = FfiClient::instance().publishDataTrackAsync(1, "name");
  auto result = fut_result.get();
  EXPECT_FALSE(result.ok());
  EXPECT_EQ(result.error().code, PublishDataTrackErrorCode::INTERNAL);
}

TEST_F(FfiClientTest, NotInitialized_SubscribeDataTrackFails) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  auto result = FfiClient::instance().subscribeDataTrack(1);
  EXPECT_FALSE(result.ok());
  EXPECT_EQ(result.error().code, SubscribeDataTrackErrorCode::INTERNAL);
}

TEST_F(FfiClientTest, NotInitialized_SendStreamHeaderAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  proto::DataStream::Header header;
  EXPECT_THROW(FfiClient::instance().sendStreamHeaderAsync(1, header, {}, "sender"), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_SendStreamChunkAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  proto::DataStream::Chunk chunk;
  EXPECT_THROW(FfiClient::instance().sendStreamChunkAsync(1, chunk, {}, "sender"), std::runtime_error);
}

TEST_F(FfiClientTest, NotInitialized_SendStreamTrailerAsyncThrows) {
  ASSERT_FALSE(FfiClient::instance().isInitialized());

  proto::DataStream::Trailer trailer;
  EXPECT_THROW(FfiClient::instance().sendStreamTrailerAsync(1, trailer, "sender"), std::runtime_error);
}

} // namespace livekit::test
