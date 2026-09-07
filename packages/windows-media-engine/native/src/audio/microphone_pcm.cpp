#include "audio/microphone_pcm.hpp"
#include <limits>

namespace syrnike::windows_media::audio {
void MicrophonePacketizer::ingest(std::span<const std::int16_t> samples, std::uint32_t frames,
                                  std::uint64_t position, std::int64_t timestamp_100ns,
                                  bool silent, bool discontinuity, bool timestamp_error) noexcept {
  // Bound work even if a platform adapter reports an invalid packet size.
  if (frames > kMicrophoneRate || (!silent && samples.size() < frames) ||
      position > (std::numeric_limits<std::uint64_t>::max)() - frames) {
    ++stats_.invalid_buffers;
    stats_.consecutive_healthy_frames = 0;
    filled_ = 0;
    previous_position_.reset();
    expected_timestamp_100ns_.reset();
    pending_.discontinuity = true;
    return;
  }
  if (timestamp_error || timestamp_100ns <= 0 ||
      timestamp_100ns > (std::numeric_limits<std::int64_t>::max)() - 10'000'000) {
    ++stats_.invalid_timestamps;
    stats_.consecutive_healthy_frames = 0;
    filled_ = 0;
    previous_position_.reset();
    expected_timestamp_100ns_.reset();
    pending_.discontinuity = true;
    return;
  }
  // AUTOCONVERTPCM leaves device positions in the endpoint's clock domain on
  // real 44.1 kHz inputs while returning 48 kHz PCM. Comparing position deltas
  // to converted frame counts therefore invents a gap on every packet. Use
  // Windows glitch flags, monotonic device positions and the QPC sample clock.
  // A 2 ms tolerance accommodates initial resampler latency and QPC rounding;
  // larger unflagged holes discard the partial frame just like a native glitch.
  const bool clock_gap = expected_timestamp_100ns_ &&
      (timestamp_100ns < *expected_timestamp_100ns_ - 20'000 ||
       timestamp_100ns > *expected_timestamp_100ns_ + 20'000);
  if (discontinuity || clock_gap || (previous_position_ && position <= *previous_position_)) {
    ++stats_.discontinuities;
    stats_.consecutive_healthy_frames = 0;
    filled_ = 0;
    pending_.discontinuity = true;
  }
  previous_position_ = position;
  expected_timestamp_100ns_ = timestamp_100ns + static_cast<std::int64_t>(frames) * 10'000'000 / kMicrophoneRate;
  for (std::uint32_t index = 0; index < frames; ++index) {
    if (filled_ == 0)
      pending_.timestamp_100ns = timestamp_100ns + static_cast<std::int64_t>(index) * 10'000'000 / kMicrophoneRate;
    pending_.samples[filled_++] = silent ? 0 : samples[index];
    if (filled_ == kMicrophoneFrameSamples) {
      pending_.sequence = ++stats_.frames;
      if (stats_.consecutive_healthy_frames < 3) ++stats_.consecutive_healthy_frames;
      port_.publish(pending_);
      filled_ = 0;
      pending_.discontinuity = false;
    }
  }
}
}  // namespace syrnike::windows_media::audio
