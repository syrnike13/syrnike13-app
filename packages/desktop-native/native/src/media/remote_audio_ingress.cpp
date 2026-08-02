#include "remote_audio_ingress.hpp"

#include <algorithm>

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

}  // namespace

void RemoteAudioIngress::onAudioFrame(
  const livekit::DecodedAudioFrameView& frame
) noexcept {
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

RemoteAudioIngressReadResult RemoteAudioIngress::tryRead(
  RemoteAudioIngressFrame& destination
) noexcept {
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
    .invalid_frames = invalid_frames_.load(std::memory_order_relaxed),
    .discontinuities = discontinuity_epoch_.load(std::memory_order_relaxed),
  };
}

}  // namespace syrnike::desktop_native::media
