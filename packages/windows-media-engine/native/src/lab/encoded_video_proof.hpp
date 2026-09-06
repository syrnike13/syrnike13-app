#pragma once
#include "screen/production_screen_sender.hpp"
#include <cstdlib>
#include <fstream>
#include <vector>

namespace syrnike::windows_media::lab {
// Opt-in diagnostic recording before the SDK. Fixed capacity, memory copies on
// submission, disk output only after stop. Never used for resource acceptance.
class EncodedVideoProof final : public screen::ScreenPublicationAdapter {
 public:
  EncodedVideoProof(std::shared_ptr<screen::ScreenPublicationAdapter> adapter, std::string path)
      : adapter_(std::move(adapter)), path_(std::move(path)) {
    bytes_.reserve(capacity);
    frames_.reserve(frame_capacity);
  }
  ~EncodedVideoProof() override {
    std::ofstream output(path_, std::ios::binary);
    output.write(reinterpret_cast<const char*>(bytes_.data()),
                 static_cast<std::streamsize>(bytes_.size()));
    std::ofstream trace(path_ + ".csv");
    trace << "sequence,timestampUs,keyframe,size\n";
    for (const auto& frame : frames_)
      trace << frame.sequence << ',' << frame.timestamp_us << ',' << frame.key_frame << ','
            << frame.size << '\n';
  }
  OutgoingNetworkObservation networkObservation() const noexcept override {
    return adapter_->networkObservation();
  }
  void startPublish(std::uint64_t generation, screen::ScreenTrackDescriptor descriptor,
                    screen::ScreenOperationCompletion completion) override {
    adapter_->startPublish(generation, std::move(descriptor), std::move(completion));
  }
  void startSubmit(std::uint64_t generation, screen::EncodedScreenFrame frame,
                   screen::ScreenOperationCompletion completion) override {
    if (frame.size > capacity - bytes_.size() || frames_.size() == frame_capacity)
      throw std::runtime_error("Encoded diagnostic capacity exceeded");
    bytes_.insert(bytes_.end(), frame.data, frame.data + frame.size);
    frames_.push_back({frame.sequence, frame.timestamp_us, frame.key_frame, frame.size});
    adapter_->startSubmit(generation, frame, std::move(completion));
  }
  void startUnpublish(std::uint64_t generation,
                      screen::ScreenOperationCompletion completion) override {
    adapter_->startUnpublish(generation, std::move(completion));
  }

 private:
  static constexpr std::size_t capacity = 512ULL * 1024 * 1024;
  static constexpr std::size_t frame_capacity = 32768;
  struct Frame {
    std::uint64_t sequence;
    std::uint64_t timestamp_us;
    bool key_frame;
    std::size_t size;
  };
  std::shared_ptr<screen::ScreenPublicationAdapter> adapter_;
  std::string path_;
  std::vector<std::uint8_t> bytes_;
  std::vector<Frame> frames_;
};
}  // namespace syrnike::windows_media::lab
