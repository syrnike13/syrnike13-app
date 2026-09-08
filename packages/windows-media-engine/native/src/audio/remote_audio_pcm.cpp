#include "audio/remote_audio_pcm.hpp"

#include <algorithm>
#include <cmath>

namespace syrnike::windows_media::audio {
bool RemoteAudioPcmPort::publish(const RemoteAudioFrame& frame) noexcept {
  if (!active() || !generation_ || frame.generation != generation_ ||
      frame.sequence <= last_sequence_ || frame.decoded_timestamp_100ns <= 0) {
    ++rejected_;
    producer_gap_ = true;
    return false;
  }
  last_sequence_ = frame.sequence;
  if (busy_.test_and_set(std::memory_order_acquire)) {
    ++producer_contention_;
    producer_gap_ = true;
    return false;
  }
  if (depth_ == capacity_) {
    head_ = (head_ + 1) % frames_.size();
    --depth_;
    ++overrun_;
    producer_gap_ = true;
  }
  auto& slot = frames_[(head_ + depth_) % frames_.size()];
  slot = frame;
  slot.discontinuity = slot.discontinuity || producer_gap_;
  producer_gap_ = false;
  ++depth_;
  ++accepted_;
  published_depth_.store(static_cast<std::uint32_t>(depth_), std::memory_order_relaxed);
  busy_.clear(std::memory_order_release);
  return true;
}

std::optional<RemoteAudioFrame> RemoteAudioPcmPort::take(
    std::int64_t now_100ns, std::int64_t minimum_timestamp_100ns) noexcept {
  if (!active()) return {};
  if (busy_.test_and_set(std::memory_order_acquire)) {
    ++consumer_contention_;
    return {};
  }
  std::optional<RemoteAudioFrame> result;
  bool dropped = false;
  for (std::size_t inspected = 0; inspected < frames_.size() && depth_; ++inspected) {
    const auto& frame = frames_[head_];
    const bool fresh = frame.decoded_timestamp_100ns >= minimum_timestamp_100ns &&
        frame.decoded_timestamp_100ns <= now_100ns &&
        now_100ns - frame.decoded_timestamp_100ns <= kRemoteAudioMaximumAge100ns;
    if (fresh) {
      result = frame;
      result->discontinuity = result->discontinuity || dropped ||
          frame.sequence != consumed_sequence_ + 1;
      consumed_sequence_ = frame.sequence;
    } else {
      ++stale_;
      dropped = true;
    }
    head_ = (head_ + 1) % frames_.size();
    --depth_;
    if (result) break;
  }
  published_depth_.store(static_cast<std::uint32_t>(depth_), std::memory_order_relaxed);
  busy_.clear(std::memory_order_release);
  // Retirement can race the copy, but a late callback never revives a port.
  if (!active()) result.reset();
  return result;
}

RemoteAudioQueueStats RemoteAudioPcmPort::stats() const noexcept {
  return {accepted_.load(), overrun_.load(), stale_.load(), rejected_.load(),
          producer_contention_.load(), consumer_contention_.load(),
          active() ? published_depth_.load() : 0};
}

bool RemoteAudioMixer::setInputs(std::span<const RemoteAudioMixInput> inputs) noexcept {
  if (inputs.size() > inputs_.size()) return false;
  for (std::size_t index = 0; index < inputs.size(); ++index) {
    const auto& input = inputs[index];
    if (!input.port || !std::isfinite(input.volume) || input.volume < 0 || input.volume > 9)
      return false;
    for (std::size_t earlier = 0; earlier < index; ++earlier)
      if (inputs[earlier].port == input.port) return false;
  }
  inputs_.fill({});
  std::copy(inputs.begin(), inputs.end(), inputs_.begin());
  count_ = inputs.size();
  stats_.inputs = static_cast<std::uint32_t>(count_);
  return true;
}

RemoteAudioFrame RemoteAudioMixer::mix(std::int64_t now_100ns,
                                      std::int64_t minimum_timestamp_100ns,
                                      std::uint64_t renderer_epoch) noexcept {
  RemoteAudioFrame output;
  output.generation = renderer_epoch;
  output.sequence = ++stats_.frames;
  output.decoded_timestamp_100ns = now_100ns;
  std::array<float, kRemoteAudioSamples> mixed{};
  for (std::size_t index = 0; index < count_; ++index) {
    const auto& input = inputs_[index];
    const auto frame = input.port->take(now_100ns, minimum_timestamp_100ns);
    if (!frame) continue;
    ++stats_.source_frames;
    if (frame->discontinuity) ++stats_.discontinuities;
    output.discontinuity = output.discontinuity || frame->discontinuity;
    const auto age = now_100ns - frame->decoded_timestamp_100ns;
    stats_.maximum_age_100ns = (std::max)(stats_.maximum_age_100ns, age);
    const auto bucket = static_cast<std::size_t>((std::max)(std::int64_t{0}, age - 1) / 100'000);
    ++stats_.age_histogram[(std::min)(bucket, stats_.age_histogram.size() - 1)];
    // Muted inputs are consumed too: unmute cannot expose a pre-mute backlog.
    if (deafened_ || input.muted) continue;
    output.decoded_timestamp_100ns = (std::min)(output.decoded_timestamp_100ns,
                                               frame->decoded_timestamp_100ns);
    for (std::size_t sample = 0; sample < mixed.size(); ++sample)
      mixed[sample] += static_cast<float>(frame->samples[sample]) * input.volume;
  }
  float peak = 0;
  for (const auto sample : mixed) peak = (std::max)(peak, std::abs(sample));
  // Linked stereo, per-frame peak limiter. Preserve source balance and stereo
  // image, without hidden lookahead/history or integer wraparound.
  constexpr float ceiling = 32'112.0f;
  const float gain = peak > ceiling ? ceiling / peak : 1.0f;
  if (gain < 1) ++stats_.limited_frames;
  for (std::size_t sample = 0; sample < mixed.size(); ++sample)
    output.samples[sample] = static_cast<std::int16_t>(std::lround(mixed[sample] * gain));
  return output;
}
}  // namespace syrnike::windows_media::audio
