#include "audio/screen_audio_pcm.hpp"
#include <algorithm>

namespace syrnike::windows_media::audio {
void PcmQueue::begin(std::uint64_t generation) noexcept {
  std::scoped_lock lock(mutex_);
  generation_ = generation;
  stopped_ = false;
  head_ = 0;
  stats_ = {};
}
void PcmQueue::stop() noexcept {
  std::scoped_lock lock(mutex_);
  stopped_ = true;
  stats_.depth = 0;
  changed_.notify_all();
}
bool PcmQueue::push(const PcmPacket& packet, std::int64_t now) noexcept {
  std::scoped_lock lock(mutex_);
  if (stopped_ || packet.generation != generation_) {
    ++stats_.fenced;
    return false;
  }
  if (packet.capture_timestamp_100ns <= 0 || packet.capture_timestamp_100ns > now ||
      now - packet.capture_timestamp_100ns > kAudioMaximumAge100ns) {
    ++stats_.stale;
    return false;
  }
  if (stats_.depth == kAudioQueueCapacity) {
    head_ = (head_ + 1) % kAudioQueueCapacity;
    --stats_.depth;
    ++stats_.superseded;
  }
  packets_[(head_ + stats_.depth) % kAudioQueueCapacity] = packet;
  ++stats_.depth;
  ++stats_.accepted;
  stats_.maximum_depth = (std::max)(stats_.maximum_depth, stats_.depth);
  changed_.notify_one();
  return true;
}
std::optional<PcmPacket> PcmQueue::take(std::int64_t now) noexcept {
  std::scoped_lock lock(mutex_);
  while (!stopped_ && stats_.depth) {
    auto packet = packets_[head_];
    head_ = (head_ + 1) % kAudioQueueCapacity;
    --stats_.depth;
    if (packet.capture_timestamp_100ns > now ||
        now - packet.capture_timestamp_100ns > kAudioMaximumAge100ns) {
      ++stats_.stale;
      continue;
    }
    ++stats_.consumed;
    return packet;
  }
  return std::nullopt;
}
void PcmQueue::discardBacklogExceptLatest() noexcept {
  std::scoped_lock lock(mutex_);
  if (stats_.depth > 1) {
    const auto discarded = stats_.depth - 1;
    head_ = (head_ + discarded) % kAudioQueueCapacity;
    stats_.depth = 1;
    stats_.superseded += discarded;
  }
}
void PcmQueue::wait(std::chrono::milliseconds timeout) {
  std::unique_lock lock(mutex_);
  changed_.wait_for(lock, timeout, [this] { return stopped_ || stats_.depth > 0; });
}
PcmQueueStats PcmQueue::stats() const noexcept {
  std::scoped_lock lock(mutex_);
  return stats_;
}
bool PcmQueue::stopped() const noexcept {
  std::scoped_lock lock(mutex_);
  return stopped_;
}
void PcmPacketizer::begin(std::uint64_t generation) noexcept {
  pending_ = {};
  pending_.generation = generation;
  filled_ = 0;
  next_position_.reset();
}
void PcmPacketizer::ingest(std::span<const std::int16_t> samples, std::uint32_t frames,
                           std::uint64_t position, std::int64_t qpc, bool silent,
                           bool discontinuity, bool timestamp_error, std::int64_t now) noexcept {
  if (timestamp_error || qpc <= 0 || frames > kAudioRate ||
      (!silent && samples.size() < static_cast<std::size_t>(frames) * kAudioChannels)) {
    filled_ = 0;
    next_position_.reset();
    pending_.discontinuity = true;
    return;
  }
  if (discontinuity || (next_position_ && *next_position_ != position)) {
    filled_ = 0;
    pending_.discontinuity = true;
  }
  next_position_ = position + frames;
  for (std::uint32_t offset = 0; offset < frames;) {
    if (filled_ == 0)
      pending_.capture_timestamp_100ns =
          qpc + static_cast<std::int64_t>(offset) * 10'000'000 / kAudioRate;
    const auto count = (std::min)(frames - offset, kAudioPacketFrames - filled_);
    auto output = pending_.samples.begin() + filled_ * kAudioChannels;
    if (silent)
      std::fill_n(output, count * kAudioChannels, std::int16_t{0});
    else
      std::copy_n(samples.begin() + offset * kAudioChannels, count * kAudioChannels, output);
    filled_ += count;
    offset += count;
    if (filled_ == kAudioPacketFrames) {
      ++pending_.sequence;
      (void)queue_.push(pending_, now);
      pending_.discontinuity = false;
      filled_ = 0;
    }
  }
}
}  // namespace syrnike::windows_media::audio
