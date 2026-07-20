/*
 * Copyright 2025 LiveKit
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

/// @file test_room_callbacks.cpp
/// @brief Public API tests for Room callback registration.

#include <gtest/gtest.h>
#include <livekit/livekit.h>

#include <atomic>
#include <limits>
#include <thread>
#include <vector>

#include "ffi.pb.h"
#include "livekit/remote_participant.h"
#include "livekit/remote_track_publication.h"
#include "track.pb.h"

namespace livekit {

class RoomCallbackTest : public ::testing::Test {
protected:
  void SetUp() override { livekit::initialize(livekit::LogLevel::Info); }

  void TearDown() override { livekit::shutdown(); }

  static constexpr const char* kParticipantIdentity = "viewer-source";
  static constexpr const char* kTrackSid = "screen-track";

  static proto::OwnedTrackPublication makeScreenPublication() {
    proto::OwnedTrackPublication owned;
    owned.mutable_handle()->set_id(0);
    auto* info = owned.mutable_info();
    info->set_sid(kTrackSid);
    info->set_name("screen");
    info->set_kind(proto::KIND_VIDEO);
    info->set_source(proto::SOURCE_SCREENSHARE);
    info->set_simulcasted(false);
    info->set_width(1920);
    info->set_height(1080);
    info->set_mime_type("video/h264");
    info->set_muted(false);
    info->set_remote(true);
    info->set_encryption_type(proto::NONE);
    return owned;
  }

  static proto::OwnedTrack makeScreenTrack() {
    proto::OwnedTrack owned;
    owned.mutable_handle()->set_id(0);
    auto* info = owned.mutable_info();
    info->set_sid(kTrackSid);
    info->set_name("screen");
    info->set_kind(proto::KIND_VIDEO);
    info->set_stream_state(proto::STATE_ACTIVE);
    info->set_muted(false);
    info->set_remote(true);
    return owned;
  }

  static std::shared_ptr<RemoteTrackPublication> addScreenPublication(Room& room) {
    room.room_handle_ = std::make_shared<FfiHandle>();
    auto participant = std::make_shared<RemoteParticipant>(
        FfiHandle(), "participant-sid", "source", kParticipantIdentity, "",
        std::unordered_map<std::string, std::string>{}, ParticipantKind::Standard, DisconnectReason::Unknown);
    auto publication = std::make_shared<RemoteTrackPublication>(makeScreenPublication());
    participant->mutableTrackPublications().emplace(kTrackSid, publication);
    room.remote_participants_.emplace(kParticipantIdentity, std::move(participant));
    return publication;
  }

  static void setSubscriptionDesired(RemoteTrackPublication& publication, bool desired) {
    publication.subscription_desired_.store(desired, std::memory_order_release);
  }

  static void pushTrackSubscribed(Room& room) {
    proto::FfiEvent event;
    auto* room_event = event.mutable_room_event();
    room_event->set_room_handle(0);
    auto* subscribed = room_event->mutable_track_subscribed();
    subscribed->set_participant_identity(kParticipantIdentity);
    subscribed->mutable_track()->CopyFrom(makeScreenTrack());
    room.onEvent(event);
  }

  static void pushTrackUnsubscribed(Room& room) {
    proto::FfiEvent event;
    auto* room_event = event.mutable_room_event();
    room_event->set_room_handle(0);
    auto* unsubscribed = room_event->mutable_track_unsubscribed();
    unsubscribed->set_participant_identity(kParticipantIdentity);
    unsubscribed->set_track_sid(kTrackSid);
    room.onEvent(event);
  }
};

TEST_F(RoomCallbackTest, FrameCallbackRegistrationByTrackNameIsAccepted) {
  Room room;

  EXPECT_NO_THROW(room.setOnAudioFrameCallback("alice", "mic-main", [](const AudioFrame&) {}));
  EXPECT_NO_THROW(room.setOnVideoFrameCallback("alice", "cam-main", [](const VideoFrame&, std::int64_t) {}));
  EXPECT_NO_THROW(room.clearOnAudioFrameCallback("alice", "mic-main"));
  EXPECT_NO_THROW(room.clearOnVideoFrameCallback("alice", "cam-main"));
}

TEST_F(RoomCallbackTest, DataCallbackRegistrationReturnsUsableIds) {
  Room room;

  const auto id1 = room.addOnDataFrameCallback("alice", "track-a",
                                               [](const std::vector<std::uint8_t>&, std::optional<std::uint64_t>) {});
  const auto id2 = room.addOnDataFrameCallback("alice", "track-a",
                                               [](const std::vector<std::uint8_t>&, std::optional<std::uint64_t>) {});

  EXPECT_NE(id1, std::numeric_limits<DataFrameCallbackId>::max());
  EXPECT_NE(id2, std::numeric_limits<DataFrameCallbackId>::max());
  EXPECT_NE(id1, id2);

  EXPECT_NO_THROW(room.removeOnDataFrameCallback(id1));
  EXPECT_NO_THROW(room.removeOnDataFrameCallback(id2));
}

TEST_F(RoomCallbackTest, RemovingUnknownDataCallbackIsNoOp) {
  Room room;

  EXPECT_NO_THROW(room.removeOnDataFrameCallback(std::numeric_limits<DataFrameCallbackId>::max()));
}

TEST_F(RoomCallbackTest, DestroyRoomWithRegisteredCallbacksIsSafe) {
  EXPECT_NO_THROW({
    Room room;
    room.setOnAudioFrameCallback("alice", "mic-main", [](const AudioFrame&) {});
    room.setOnVideoFrameCallback("bob", "cam-main", [](const VideoFrame&, std::int64_t) {});
    room.addOnDataFrameCallback("carol", "track",
                                [](const std::vector<std::uint8_t>&, std::optional<std::uint64_t>) {});
  });
}

TEST_F(RoomCallbackTest, DestroyRoomAfterClearingCallbacksIsSafe) {
  EXPECT_NO_THROW({
    Room room;
    room.setOnAudioFrameCallback("alice", "mic-main", [](const AudioFrame&) {});
    room.clearOnAudioFrameCallback("alice", "mic-main");

    const auto id = room.addOnDataFrameCallback("alice", "track",
                                                [](const std::vector<std::uint8_t>&, std::optional<std::uint64_t>) {});
    room.removeOnDataFrameCallback(id);
  });
}

TEST_F(RoomCallbackTest, DefaultConnectionStateIsDisconnected) {
  Room room;
  EXPECT_EQ(room.connectionState(), ConnectionState::Disconnected);
}

TEST_F(RoomCallbackTest, ConnectionStateRemainsDisconnectedWithoutConnect) {
  // Register callbacks, do other operations — state must stay Disconnected.
  Room room;
  room.setOnAudioFrameCallback("alice", "mic-main", [](const AudioFrame&) {});
  room.setOnVideoFrameCallback("alice", "cam-main", [](const VideoFrame&, std::int64_t) {});
  room.addOnDataFrameCallback("alice", "track", [](const std::vector<std::uint8_t>&, std::optional<std::uint64_t>) {});
  room.registerTextStreamHandler("topic", [](const std::shared_ptr<TextStreamReader>&, const std::string&) {});
  EXPECT_EQ(room.connectionState(), ConnectionState::Disconnected);
}

TEST_F(RoomCallbackTest, ConnectionStateIsQueryableFromMultipleThreads) {
  Room room;
  constexpr int kThreads = 8;
  constexpr int kIterations = 200;

  std::vector<std::thread> threads;
  threads.reserve(kThreads);
  std::atomic<int> disconnected_count{0};

  for (int t = 0; t < kThreads; ++t) {
    threads.emplace_back([&room, &disconnected_count, kIterations]() {
      for (int i = 0; i < kIterations; ++i) {
        if (room.connectionState() == ConnectionState::Disconnected) {
          disconnected_count.fetch_add(1, std::memory_order_relaxed);
        }
      }
    });
  }

  for (auto& thread : threads) {
    thread.join();
  }

  EXPECT_EQ(disconnected_count.load(), kThreads * kIterations);
}

TEST_F(RoomCallbackTest, TrackSubscribedEventUpdatesStateWithoutSendingSubscriptionCommand) {
  Room room;
  const auto publication = addScreenPublication(room);

  ASSERT_NO_THROW(pushTrackSubscribed(room));

  EXPECT_TRUE(publication->subscribed());
  EXPECT_NE(publication->track(), nullptr);
}

TEST_F(RoomCallbackTest, LateTrackUnsubscribedDoesNotDetachDemandedReplacement) {
  Room room;
  const auto publication = addScreenPublication(room);
  setSubscriptionDesired(*publication, true);
  pushTrackSubscribed(room);
  const auto replacement = publication->track();
  ASSERT_NE(replacement, nullptr);

  ASSERT_NO_THROW(pushTrackUnsubscribed(room));

  EXPECT_TRUE(publication->subscribed());
  EXPECT_EQ(publication->track(), replacement);
}

TEST_F(RoomCallbackTest, TrackUnsubscribedEventClearsStateWithoutSendingSubscriptionCommand) {
  Room room;
  const auto publication = addScreenPublication(room);
  pushTrackSubscribed(room);
  ASSERT_NE(publication->track(), nullptr);

  ASSERT_NO_THROW(pushTrackUnsubscribed(room));

  EXPECT_FALSE(publication->subscribed());
  EXPECT_EQ(publication->track(), nullptr);
}

} // namespace livekit
