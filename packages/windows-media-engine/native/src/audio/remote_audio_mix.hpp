#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <span>
#include <string_view>

namespace syrnike::windows_media::audio {
inline constexpr std::uint32_t kRemoteAudioRate = 48'000;
inline constexpr std::size_t kRemoteAudioChannels = 2;
inline constexpr std::size_t kRemoteAudioFrames = 480;  // 10 ms
inline constexpr std::size_t kRemoteAudioSamples = kRemoteAudioFrames * kRemoteAudioChannels;
using RemoteAudioFrame = std::array<std::int16_t, kRemoteAudioSamples>;

struct RemoteAudioJitterStats {
  std::uint64_t pushed = 0, played = 0, underruns = 0, overruns = 0, trimmed = 0;
  std::uint32_t depth = 0;
};

// Per-track safety buffer owned by the device-clocked playout thread. A single
// synchronously pulled frame primes it; capacity and trimming bound any backlog
// left by startup or recovery without adding a second clock's phase delay.
class RemoteAudioJitter final {
 public:
  static constexpr std::size_t kCapacity = 8, kPrime = 1, kHigh = 6, kTrim = 3;
  void push(const RemoteAudioFrame& frame) noexcept {
    if (depth_ == kCapacity) {
      head_ = (head_ + 1) % kCapacity;
      --depth_;
      ++stats_.overruns;
    }
    frames_[(head_ + depth_) % kCapacity] = frame;
    ++depth_;
    ++stats_.pushed;
  }
  // Null while priming or after an underrun; the caller mixes silence.
  const RemoteAudioFrame* pop() noexcept {
    if (depth_ > kHigh) {
      stats_.trimmed += depth_ - kTrim;
      head_ = (head_ + depth_ - kTrim) % kCapacity;
      depth_ = kTrim;
    }
    if (!primed_) {
      if (depth_ < kPrime) return nullptr;
      primed_ = true;
    }
    if (!depth_) {
      primed_ = false;
      ++stats_.underruns;
      return nullptr;
    }
    const auto* frame = &frames_[head_];
    head_ = (head_ + 1) % kCapacity;
    --depth_;
    ++stats_.played;
    return frame;
  }
  RemoteAudioJitterStats stats() const noexcept {
    auto result = stats_;
    result.depth = static_cast<std::uint32_t>(depth_);
    return result;
  }

 private:
  std::array<RemoteAudioFrame, kCapacity> frames_{};
  std::size_t head_ = 0, depth_ = 0;
  bool primed_ = false;
  RemoteAudioJitterStats stats_;
};

// Room identities are "voice:v1|engine|instance|epoch|operation|userId". Listener
// volume and mute are per user, across every connection that user has.
inline std::string_view voiceUserId(std::string_view identity) noexcept {
  if (!identity.starts_with("voice:v1|")) return identity;
  return identity.substr(identity.rfind('|') + 1);
}

struct RemoteAudioMixInput {
  RemoteAudioJitter* jitter = nullptr;
  float volume = 1.0f;  // output volume (0..3) times participant volume (0..3)
  bool muted = false;
  // Gain last applied to this input. When present, volume, mute and deafen
  // changes ramp across one frame instead of stepping, which would click.
  float* gain = nullptr;
};

// Sums one 10 ms frame from every input. Muted inputs are still consumed so an
// unmute never plays a backlog. A linked-stereo peak limiter attacks within the
// frame that would clip and releases smoothly over the following frames.
class RemoteAudioMixer final {
 public:
  bool mix(std::span<const RemoteAudioMixInput> inputs, bool deafened, RemoteAudioFrame& output) noexcept {
    std::array<float, kRemoteAudioSamples> mixed{};
    bool audible = false;
    for (const auto& input : inputs) {
      const auto* frame = input.jitter->pop();
      const float target = deafened || input.muted ? 0.0f : (std::max)(input.volume, 0.0f);
      const float from = input.gain ? *input.gain : target;
      if (input.gain) *input.gain = frame ? target : 0.0f;
      if (!frame || (from <= 0 && target <= 0)) continue;
      audible = true;
      const float step = (target - from) / static_cast<float>(kRemoteAudioFrames);
      for (std::size_t sample = 0; sample < kRemoteAudioFrames; ++sample) {
        const float gain = from + step * static_cast<float>(sample + 1);
        for (std::size_t channel = 0; channel < kRemoteAudioChannels; ++channel) {
          const auto index = sample * kRemoteAudioChannels + channel;
          mixed[index] += static_cast<float>((*frame)[index]) * gain;
        }
      }
    }
    if (!audible) {
      output.fill(0);
      gain_ = 1.0f;
      return false;
    }
    float peak = 0;
    for (const auto sample : mixed) peak = (std::max)(peak, std::abs(sample));
    constexpr float ceiling = 32'112.0f;
    const float target = peak > ceiling ? ceiling / peak : 1.0f;
    gain_ = target < gain_ ? target : gain_ + (target - gain_) * 0.05f;
    for (std::size_t index = 0; index < mixed.size(); ++index)
      output[index] = static_cast<std::int16_t>(std::lround((std::clamp)(mixed[index] * gain_, -32'768.0f, 32'767.0f)));
    return true;
  }

 private:
  float gain_ = 1.0f;
};
}  // namespace syrnike::windows_media::audio
