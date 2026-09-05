#pragma once

#include <functional>
#include <memory>

#include <livekit/video_source.h>

#include "livekit/livekit_room_transport.hpp"
#include "screen/production_screen_sender.hpp"

namespace syrnike::windows_media {

#if defined(LIVEKIT_CPP_HAS_PREENCODED_VIDEO_SOURCE)

struct LiveKitScreenEncoderControls {
  std::function<void()> request_key_frame;
};

// Thin adapter: it owns publication objects, while Room ownership and every
// SDK call remain on LiveKitRoomTransport's serialized lane.
class LiveKitScreenPublicationAdapter final
    : public screen::ScreenPublicationAdapter {
 public:
  explicit LiveKitScreenPublicationAdapter(
      std::shared_ptr<LiveKitRoomTransport> transport,
      LiveKitScreenEncoderControls controls = {});
  ~LiveKitScreenPublicationAdapter() override;

  void startPublish(std::uint64_t generation,
                    screen::ScreenTrackDescriptor descriptor,
                    screen::ScreenOperationCompletion completion) override;
  void startSubmit(std::uint64_t generation, screen::EncodedScreenFrame frame,
                   screen::ScreenOperationCompletion completion) override;
  void startUnpublish(std::uint64_t generation,
                      screen::ScreenOperationCompletion completion) override;

 private:
  struct State;
  std::shared_ptr<LiveKitRoomTransport> transport_;
  std::shared_ptr<State> state_;
};

#endif

}  // namespace syrnike::windows_media
