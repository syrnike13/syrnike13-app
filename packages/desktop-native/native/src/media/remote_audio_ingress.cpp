#include "remote_audio_ingress.hpp"

#include <algorithm>
#include <chrono>
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

class ConsumerGate final {
 public:
  explicit ConsumerGate(std::atomic_flag& gate) noexcept
    : gate_(gate), acquired_(!gate_.test_and_set(std::memory_order_acquire)) {}
  ~ConsumerGate() {
    if (acquired_) gate_.clear(std::memory_order_release);
  }
  explicit operator bool() const noexcept { return acquired_; }

 private:
  std::atomic_flag& gate_;
  bool acquired_;
};

}  // namespace

std::uint64_t remoteAudioSteadyNowUs() noexcept {
  return static_cast<std::uint64_t>(
    std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()
    ).count()
  );
}

RemoteAudioIngress::RemoteAudioIngress(
  RemoteAudioSteadyNowUs steady_now
) noexcept : steady_now_(steady_now ? steady_now : &remoteAudioSteadyNowUs) {}

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
    const auto discontinuity =
      discontinuity_epoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
    flush_discontinuity_epoch_.store(
      discontinuity,
      std::memory_order_release
    );
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
  auto ingress_steady_us = steady_now_();
  if (ingress_steady_us <= last_ingress_steady_us_) {
    ingress_steady_us = last_ingress_steady_us_ + 1;
  }
  last_ingress_steady_us_ = ingress_steady_us;
  slots_[write_index].sequence = ++next_sequence_;
  slots_[write_index].ingress_steady_us = ingress_steady_us;
  write_index_.store(next_write_index, std::memory_order_release);
  accepted_frames_.fetch_add(1, std::memory_order_relaxed);
}

void RemoteAudioIngress::activate(std::uint64_t renderer_epoch) noexcept {
  while (producer_gate_.test_and_set(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  while (consumer_gate_.test_and_set(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  resetQueue();
  renderer_epoch_.store(renderer_epoch, std::memory_order_release);
  consumer_gate_.clear(std::memory_order_release);
  producer_gate_.clear(std::memory_order_release);
}

void RemoteAudioIngress::suspend() noexcept {
  while (producer_gate_.test_and_set(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  while (consumer_gate_.test_and_set(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  renderer_epoch_.store(0, std::memory_order_release);
  consumer_gate_.clear(std::memory_order_release);
  producer_gate_.clear(std::memory_order_release);
}

RemoteAudioIngressReadResult RemoteAudioIngress::tryRead(
  RemoteAudioIngressFrame& destination,
  std::uint64_t renderer_epoch
) noexcept {
  ConsumerGate consumer(consumer_gate_);
  if (!consumer) return RemoteAudioIngressReadResult::Empty;
  if (renderer_epoch == 0 ||
      renderer_epoch_.load(std::memory_order_acquire) != renderer_epoch) {
    return RemoteAudioIngressReadResult::Discontinuity;
  }
  const auto discontinuity_epoch =
    discontinuity_epoch_.load(std::memory_order_acquire);
  if (discontinuity_epoch != consumed_discontinuity_epoch_) {
    recoverFromDiscontinuity(discontinuity_epoch);
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
    recoverFromDiscontinuity(completed_discontinuity_epoch);
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

void RemoteAudioIngress::discardQueued(std::uint64_t renderer_epoch) noexcept {
  ConsumerGate consumer(consumer_gate_);
  if (!consumer ||
      (renderer_epoch != 0 &&
       renderer_epoch_.load(std::memory_order_acquire) != renderer_epoch)) {
    return;
  }
  resetQueue();
}

bool RemoteAudioIngress::activeFor(std::uint64_t renderer_epoch) const
    noexcept {
  return renderer_epoch != 0 &&
    renderer_epoch_.load(std::memory_order_acquire) == renderer_epoch;
}

RemoteAudioIngressFreshness RemoteAudioIngress::enforceFreshness(
  std::uint64_t now_us,
  std::size_t scheduled_frames,
  std::uint64_t current_frame_ingress_us,
  std::size_t current_frame_remaining,
  std::uint64_t renderer_epoch
) noexcept {
  ConsumerGate consumer(consumer_gate_);
  if (!consumer ||
      (renderer_epoch != 0 &&
       renderer_epoch_.load(std::memory_order_acquire) != renderer_epoch)) {
    return {};
  }
  const auto write_index = write_index_.load(std::memory_order_acquire);
  const auto read_index = read_index_.load(std::memory_order_acquire);
  const auto queued = queuedFrameCount(write_index, read_index);
  const auto queued_timestamp = queued == 0
    ? 0
    : slots_[read_index].ingress_steady_us;
  const auto oldest_queued_age_us =
    queued_timestamp != 0 && now_us > queued_timestamp
      ? now_us - queued_timestamp
      : 0;
  const auto oldest_timestamp = current_frame_ingress_us != 0
    ? current_frame_ingress_us
    : queued_timestamp;
  const auto resident_age_us = oldest_timestamp != 0 && now_us > oldest_timestamp
    ? now_us - oldest_timestamp
    : 0;
  const auto scheduled_delay_us = static_cast<std::uint64_t>(
    scheduled_frames * 1'000'000ULL / kRemoteAudioIngressSampleRate
  );
  const auto scheduled_playout_age_us = oldest_timestamp == 0
    ? 0
    : resident_age_us + scheduled_delay_us;

  last_scheduled_playout_age_us_.store(
    scheduled_playout_age_us,
    std::memory_order_relaxed
  );
  last_oldest_queued_age_us_.store(
    oldest_queued_age_us,
    std::memory_order_relaxed
  );
  last_queued_packets_.store(queued, std::memory_order_relaxed);
  auto maximum = maximum_scheduled_playout_age_us_.load(
    std::memory_order_relaxed
  );
  while (
    maximum < scheduled_playout_age_us &&
    !maximum_scheduled_playout_age_us_.compare_exchange_weak(
      maximum,
      scheduled_playout_age_us,
      std::memory_order_relaxed
    )
  ) {}

  RemoteAudioIngressFreshness result{
    .recovered = false,
    .scheduled_playout_age_us = scheduled_playout_age_us,
    .oldest_queued_age_us = oldest_queued_age_us,
    .queued_packets = queued,
    .discarded_packets = 0,
  };
  if (
    oldest_timestamp == 0 ||
    scheduled_playout_age_us <= kRemoteAudioLocalPlayoutAgeBudgetUs
  ) {
    return result;
  }

  const auto retained = (std::min)(
    queued,
    kRemoteAudioIngressRecoveryPackets
  );
  const auto recovery_index = static_cast<std::uint32_t>(
    (
      write_index +
      static_cast<std::uint32_t>(kRemoteAudioIngressSlotCount) -
      static_cast<std::uint32_t>(retained)
    ) % static_cast<std::uint32_t>(kRemoteAudioIngressSlotCount)
  );
  read_index_.store(recovery_index, std::memory_order_release);
  const auto discontinuity =
    discontinuity_epoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
  // This consumer performed the exact recovery represented by this epoch.
  // A concurrent producer discontinuity increments the epoch again and is
  // still observed by the next tryRead().
  consumed_discontinuity_epoch_ = discontinuity;

  result.recovered = true;
  result.discarded_packets = queued - retained +
    (current_frame_remaining != 0 ? 1 : 0);
  freshness_recoveries_.fetch_add(1, std::memory_order_relaxed);
  stale_frames_discarded_.fetch_add(
    result.discarded_packets,
    std::memory_order_relaxed
  );
  return result;
}

void RemoteAudioIngress::recoverFromDiscontinuity(
  std::uint64_t discontinuity_epoch
) noexcept {
  const auto write_index = write_index_.load(std::memory_order_acquire);
  const auto flush_epoch =
    flush_discontinuity_epoch_.load(std::memory_order_acquire);
  if (flush_epoch != consumed_flush_discontinuity_epoch_) {
    read_index_.store(write_index, std::memory_order_release);
    consumed_flush_discontinuity_epoch_ = flush_epoch;
  } else {
    const auto read_index = read_index_.load(std::memory_order_relaxed);
    const auto queued = queuedFrameCount(write_index, read_index);
    const auto retained = std::min(
      queued,
      kRemoteAudioIngressRecoveryPackets
    );
    const auto recovery_index = static_cast<std::uint32_t>(
      (
        write_index +
        static_cast<std::uint32_t>(kRemoteAudioIngressSlotCount) -
        static_cast<std::uint32_t>(retained)
      ) % static_cast<std::uint32_t>(kRemoteAudioIngressSlotCount)
    );
    read_index_.store(recovery_index, std::memory_order_release);
  }
  consumed_discontinuity_epoch_ = discontinuity_epoch;
}

void RemoteAudioIngress::resetQueue() noexcept {
  read_index_.store(
    write_index_.load(std::memory_order_acquire),
    std::memory_order_release
  );
  consumed_discontinuity_epoch_ =
    discontinuity_epoch_.load(std::memory_order_acquire);
  consumed_flush_discontinuity_epoch_ =
    flush_discontinuity_epoch_.load(std::memory_order_acquire);
}

RemoteAudioIngressTelemetry RemoteAudioIngress::telemetry() const noexcept {
  return {
    .accepted_frames = accepted_frames_.load(std::memory_order_relaxed),
    .dropped_frames = dropped_frames_.load(std::memory_order_relaxed),
    .suspended_frames = suspended_frames_.load(std::memory_order_relaxed),
    .invalid_frames = invalid_frames_.load(std::memory_order_relaxed),
    .discontinuities = discontinuity_epoch_.load(std::memory_order_relaxed),
    .freshness_recoveries = freshness_recoveries_.load(
      std::memory_order_relaxed
    ),
    .stale_frames_discarded = stale_frames_discarded_.load(
      std::memory_order_relaxed
    ),
    .last_scheduled_playout_age_us = last_scheduled_playout_age_us_.load(
      std::memory_order_relaxed
    ),
    .maximum_scheduled_playout_age_us =
      maximum_scheduled_playout_age_us_.load(std::memory_order_relaxed),
    .last_oldest_queued_age_us = last_oldest_queued_age_us_.load(
      std::memory_order_relaxed
    ),
    .last_queued_packets = last_queued_packets_.load(
      std::memory_order_relaxed
    ),
  };
}

}  // namespace syrnike::desktop_native::media
