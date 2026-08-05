#include "remote_audio_ingress.hpp"

#include <algorithm>
#include <thread>

namespace syrnike::desktop_native::media {

namespace {

constexpr std::uint32_t nextIndex(std::uint32_t index) noexcept {
  return (index + 1) % static_cast<std::uint32_t>(kRemoteAudioIngressSlotCount);
}

std::size_t queuedFrameCount(
  std::uint32_t write_index,
  std::uint32_t read_index
) noexcept {
  if (write_index >= read_index) return write_index - read_index;
  return kRemoteAudioIngressSlotCount - read_index + write_index;
}

class ProducerGate final {
 public:
  explicit ProducerGate(std::atomic_flag& gate) noexcept
    : gate_(gate), acquired_(!gate_.test_and_set(std::memory_order_acquire)) {}
  ~ProducerGate() {
    if (acquired_) gate_.clear(std::memory_order_release);
  }
  explicit operator bool() const noexcept { return acquired_; }

 private:
  std::atomic_flag& gate_;
  bool acquired_;
};

}  // namespace

void RemoteAudioIngress::onAudioFrame(
  const livekit::DecodedAudioFrameView& frame
) noexcept {
  ProducerGate producer(producer_gate_);
  if (!producer ||
      renderer_epoch_.load(std::memory_order_acquire) == 0) {
    suspended_frames_.fetch_add(1, std::memory_order_relaxed);
    return;
  }

  if (
    frame.data == nullptr ||
    frame.sample_rate != kRemoteAudioIngressSampleRate ||
    frame.num_channels != kRemoteAudioIngressChannels ||
    frame.num_frames != kRemoteAudioIngressFramesPerPacket ||
    frame.sample_count != kRemoteAudioIngressSamplesPerPacket
  ) {
    invalid_frames_.fetch_add(1, std::memory_order_relaxed);
    discontinuity_epoch_.fetch_add(1, std::memory_order_release);
    return;
  }

  const auto write_index = write_index_.load(std::memory_order_relaxed);
  const auto next_write_index = nextIndex(write_index);
  if (next_write_index == read_index_.load(std::memory_order_acquire)) {
    dropped_frames_.fetch_add(1, std::memory_order_relaxed);
    discontinuity_epoch_.fetch_add(1, std::memory_order_release);
    return;
  }

  std::copy_n(
    frame.data,
    kRemoteAudioIngressSamplesPerPacket,
    slots_[write_index].samples.begin()
  );
  write_index_.store(next_write_index, std::memory_order_release);
  accepted_frames_.fetch_add(1, std::memory_order_relaxed);
}

void RemoteAudioIngress::activate(std::uint64_t renderer_epoch) noexcept {
  while (producer_gate_.test_and_set(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  // resetQueue() touches renderer-owned non-atomic state. It must run before
  // the epoch store so concurrent tryRead() calls return before reading it.
  resetQueue();
  renderer_epoch_.store(renderer_epoch, std::memory_order_release);
  producer_gate_.clear(std::memory_order_release);
}

void RemoteAudioIngress::suspend() noexcept {
  while (producer_gate_.test_and_set(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  renderer_epoch_.store(0, std::memory_order_release);
  producer_gate_.clear(std::memory_order_release);
}

RemoteAudioIngressReadResult RemoteAudioIngress::tryRead(
  RemoteAudioIngressFrame& destination,
  std::uint64_t renderer_epoch
) noexcept {
  if (renderer_epoch == 0 ||
      renderer_epoch_.load(std::memory_order_acquire) != renderer_epoch) {
    return RemoteAudioIngressReadResult::Discontinuity;
  }
  const auto discontinuity_epoch =
    discontinuity_epoch_.load(std::memory_order_acquire);
  if (discontinuity_epoch != consumed_discontinuity_epoch_) {
    read_index_.store(
      write_index_.load(std::memory_order_acquire),
      std::memory_order_release
    );
    consumed_discontinuity_epoch_ = discontinuity_epoch;
    return RemoteAudioIngressReadResult::Discontinuity;
  }

  const auto read_index = read_index_.load(std::memory_order_relaxed);
  if (read_index == write_index_.load(std::memory_order_acquire)) {
    return RemoteAudioIngressReadResult::Empty;
  }
  destination = slots_[read_index];
  const auto completed_discontinuity_epoch =
    discontinuity_epoch_.load(std::memory_order_acquire);
  if (completed_discontinuity_epoch != consumed_discontinuity_epoch_) {
    read_index_.store(
      write_index_.load(std::memory_order_acquire),
      std::memory_order_release
    );
    consumed_discontinuity_epoch_ = completed_discontinuity_epoch;
    return RemoteAudioIngressReadResult::Discontinuity;
  }
  read_index_.store(nextIndex(read_index), std::memory_order_release);
  return RemoteAudioIngressReadResult::Frame;
}

std::size_t RemoteAudioIngress::queuedFrames() const noexcept {
  const auto write_index = write_index_.load(std::memory_order_acquire);
  const auto read_index = read_index_.load(std::memory_order_acquire);
  return queuedFrameCount(write_index, read_index);
}

void RemoteAudioIngress::discardQueued() noexcept {
  resetQueue();
}

void RemoteAudioIngress::resetQueue() noexcept {
  read_index_.store(
    write_index_.load(std::memory_order_acquire),
    std::memory_order_release
  );
  consumed_discontinuity_epoch_ =
    discontinuity_epoch_.load(std::memory_order_acquire);
}

RemoteAudioIngressTelemetry RemoteAudioIngress::telemetry() const noexcept {
  return {
    .accepted_frames = accepted_frames_.load(std::memory_order_relaxed),
    .dropped_frames = dropped_frames_.load(std::memory_order_relaxed),
    .suspended_frames = suspended_frames_.load(std::memory_order_relaxed),
    .invalid_frames = invalid_frames_.load(std::memory_order_relaxed),
    .discontinuities = discontinuity_epoch_.load(std::memory_order_relaxed),
  };
}

}  // namespace syrnike::desktop_native::media
