#include "audio_plugins/builtin_effects.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <stdexcept>
#include <vector>

namespace syrnike::windows_media::audio_plugins {
namespace {
constexpr float kPi = std::numbers::pi_v<float>;
float decibels(float gain_db) noexcept { return std::pow(10.0f, gain_db / 20.0f); }

// RBJ Audio EQ Cookbook biquad, transposed direct form II.
class Biquad {
 public:
  enum class Shape { low_shelf, peak, high_shelf };
  void configure(Shape shape, float frequency, float gain_db, float q) noexcept {
    const float a = std::pow(10.0f, gain_db / 40.0f);
    const float w0 = 2.0f * kPi * frequency / kEffectSampleRate;
    const float cosine = std::cos(w0);
    float b0, b1, b2, a0, a1, a2;
    if (shape == Shape::peak) {
      const float alpha = std::sin(w0) / (2.0f * q);
      b0 = 1 + alpha * a; b1 = -2 * cosine; b2 = 1 - alpha * a;
      a0 = 1 + alpha / a; a1 = -2 * cosine; a2 = 1 - alpha / a;
    } else {
      const float shelf = 2.0f * std::sqrt(a) * std::sin(w0) / 2.0f * std::numbers::sqrt2_v<float>;
      const float sign = shape == Shape::low_shelf ? 1.0f : -1.0f;
      b0 = a * ((a + 1) - sign * (a - 1) * cosine + shelf);
      b1 = sign * 2 * a * ((a - 1) - sign * (a + 1) * cosine);
      b2 = a * ((a + 1) - sign * (a - 1) * cosine - shelf);
      a0 = (a + 1) + sign * (a - 1) * cosine + shelf;
      a1 = -sign * 2 * ((a - 1) + sign * (a + 1) * cosine);
      a2 = (a + 1) + sign * (a - 1) * cosine - shelf;
    }
    b0_ = b0 / a0; b1_ = b1 / a0; b2_ = b2 / a0; a1_ = a1 / a0; a2_ = a2 / a0;
  }
  float process(float input) noexcept {
    const float output = b0_ * input + z1_;
    z1_ = b1_ * input - a1_ * output + z2_;
    z2_ = b2_ * input - a2_ * output;
    return output;
  }
  void reset() noexcept { z1_ = z2_ = 0; }
 private:
  float b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0, z1_ = 0, z2_ = 0;
};

constexpr std::array kEqParameters{
    EffectParameter{"lowGainDb", -12, 12, 0},
    EffectParameter{"midGainDb", -12, 12, 0},
    EffectParameter{"midFrequency", 200, 5000, 1500},
    EffectParameter{"highGainDb", -12, 12, 0},
};
class Equalizer final : public BuiltinEffect {
 public:
  Equalizer() : BuiltinEffect(kEqParameters) {}
  void process(float* samples, std::size_t count) noexcept override {
    if (consumeChange()) {
      low_.configure(Biquad::Shape::low_shelf, 120, value(0), 0.707f);
      mid_.configure(Biquad::Shape::peak, value(2), value(1), 1.0f);
      high_.configure(Biquad::Shape::high_shelf, 6000, value(3), 0.707f);
    }
    for (std::size_t index = 0; index < count; ++index)
      samples[index] = high_.process(mid_.process(low_.process(samples[index])));
  }
  void reset() noexcept override { low_.reset(); mid_.reset(); high_.reset(); }
 private:
  Biquad low_, mid_, high_;
};

constexpr std::array kCompressorParameters{
    EffectParameter{"thresholdDb", -60, 0, -24},
    EffectParameter{"ratio", 1, 20, 4},
    EffectParameter{"attackMs", 0.1f, 100, 5},
    EffectParameter{"releaseMs", 10, 1000, 120},
    EffectParameter{"makeupDb", 0, 24, 6},
};
// Feed-forward peak compressor with a 6 dB soft knee, smoothed in the dB domain.
class Compressor final : public BuiltinEffect {
 public:
  Compressor() : BuiltinEffect(kCompressorParameters) {}
  void process(float* samples, std::size_t count) noexcept override {
    if (consumeChange()) {
      threshold_ = value(0);
      slope_ = 1.0f / value(1) - 1.0f;
      attack_ = std::exp(-1.0f / (value(2) * 0.001f * kEffectSampleRate));
      release_ = std::exp(-1.0f / (value(3) * 0.001f * kEffectSampleRate));
      makeup_ = value(4);
    }
    constexpr float knee = 6.0f;
    for (std::size_t index = 0; index < count; ++index) {
      const float level = 20.0f * std::log10(std::abs(samples[index]) + 1e-9f);
      const float coefficient = level > envelope_ ? attack_ : release_;
      envelope_ = coefficient * envelope_ + (1 - coefficient) * level;
      const float over = envelope_ - threshold_;
      float reduction = 0;
      if (2 * over > knee) reduction = slope_ * over;
      else if (2 * std::abs(over) <= knee) reduction = slope_ * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      samples[index] *= decibels(reduction + makeup_);
    }
  }
  void reset() noexcept override { envelope_ = -120; }
 private:
  float threshold_ = 0, slope_ = 0, attack_ = 0, release_ = 0, makeup_ = 0, envelope_ = -120;
};

constexpr std::array kReverbParameters{
    EffectParameter{"roomSize", 0, 1, 0.5f},
    EffectParameter{"damping", 0, 1, 0.5f},
};
// Mono Freeverb (Jezar at Dreampoint, public domain), retuned for 48 kHz.
// The output is the wet signal only; the slot mix blends in the dry voice.
class Reverb final : public BuiltinEffect {
 public:
  Reverb() : BuiltinEffect(kReverbParameters) {
    constexpr std::array<int, 8> combs{1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
    constexpr std::array<int, 4> allpasses{556, 441, 341, 225};
    for (std::size_t index = 0; index < combs.size(); ++index) combs_[index].buffer.assign(scaled(combs[index]), 0.0f);
    for (std::size_t index = 0; index < allpasses.size(); ++index)
      allpasses_[index].buffer.assign(scaled(allpasses[index]), 0.0f);
  }
  void process(float* samples, std::size_t count) noexcept override {
    if (consumeChange()) {
      feedback_ = value(0) * 0.28f + 0.7f;
      damping_ = value(1) * 0.4f;
    }
    for (std::size_t index = 0; index < count; ++index) {
      const float input = samples[index] * 0.015f;
      float output = 0;
      for (auto& comb : combs_) {
        const float delayed = comb.buffer[comb.position];
        comb.store = delayed * (1 - damping_) + comb.store * damping_;
        comb.buffer[comb.position] = input + comb.store * feedback_;
        comb.position = (comb.position + 1) % comb.buffer.size();
        output += delayed;
      }
      for (auto& allpass : allpasses_) {
        const float delayed = allpass.buffer[allpass.position];
        allpass.buffer[allpass.position] = output + delayed * 0.5f;
        allpass.position = (allpass.position + 1) % allpass.buffer.size();
        output = delayed - output;
      }
      samples[index] = output * 3.0f;
    }
  }
  void reset() noexcept override {
    for (auto& comb : combs_) { std::ranges::fill(comb.buffer, 0.0f); comb.store = 0; }
    for (auto& allpass : allpasses_) std::ranges::fill(allpass.buffer, 0.0f);
  }
 private:
  static std::size_t scaled(int samples) { return static_cast<std::size_t>(samples * kEffectSampleRate / 44'100.0f); }
  struct Line {
    std::vector<float> buffer;
    std::size_t position = 0;
    float store = 0;
  };
  std::array<Line, 8> combs_;
  std::array<Line, 4> allpasses_;
  float feedback_ = 0.84f, damping_ = 0.2f;
};

constexpr std::array kPitchParameters{EffectParameter{"semitones", -12, 12, 0}};
// Two crossfaded read heads sweep a short delay line at the pitch ratio. The
// sin^2 windows of heads half a period apart always sum to one.
class PitchShifter final : public BuiltinEffect {
 public:
  PitchShifter() : BuiltinEffect(kPitchParameters) { buffer_.assign(kBuffer, 0.0f); }
  void process(float* samples, std::size_t count) noexcept override {
    if (consumeChange()) step_ = (1.0f - std::exp2(value(0) / 12.0f)) / kWindow;
    for (std::size_t index = 0; index < count; ++index) {
      buffer_[write_] = samples[index];
      float output = 0;
      for (float offset : {0.0f, 0.5f}) {
        float phase = phase_ + offset;
        phase -= std::floor(phase);
        const float position = static_cast<float>(write_) - phase * kWindow + static_cast<float>(kBuffer);
        const auto base = static_cast<std::size_t>(position);
        const float fraction = position - static_cast<float>(base);
        const float a = buffer_[base % kBuffer], b = buffer_[(base + 1) % kBuffer];
        const float weight = std::sin(kPi * phase);
        output += (a + (b - a) * fraction) * weight * weight;
      }
      samples[index] = output;
      phase_ += step_;
      phase_ -= std::floor(phase_);
      write_ = (write_ + 1) % kBuffer;
    }
  }
  void reset() noexcept override { std::ranges::fill(buffer_, 0.0f); phase_ = 0; }
  // The two heads read the past with a 0…kWindow delay; the window is
  // symmetric, so the mean delay is half of it. The slot delays its dry path by
  // this value: at unity shift the wet copy is then aligned and Mix cannot comb.
  std::uint32_t latencySamples() const noexcept override {
    return static_cast<std::uint32_t>(kWindow / 2.0f);  // 1024 samples ≈ 21 ms
  }
 private:
  static constexpr std::size_t kBuffer = 4096;
  static constexpr float kWindow = 2048;  // ~43 ms
  std::vector<float> buffer_;
  std::size_t write_ = 0;
  float phase_ = 0, step_ = 0;
};

constexpr std::array kEchoParameters{
    EffectParameter{"timeMs", 20, 1000, 250},
    EffectParameter{"feedback", 0, 0.9f, 0.35f},
};
// Feedback delay; outputs the repeats only, the slot mix adds the dry voice.
class Echo final : public BuiltinEffect {
 public:
  Echo() : BuiltinEffect(kEchoParameters) { buffer_.assign(static_cast<std::size_t>(kEffectSampleRate) + 1, 0.0f); }
  void process(float* samples, std::size_t count) noexcept override {
    if (consumeChange()) {
      delay_ = static_cast<std::size_t>(value(0) * 0.001f * kEffectSampleRate);
      feedback_ = value(1);
    }
    for (std::size_t index = 0; index < count; ++index) {
      const float delayed = buffer_[(write_ + buffer_.size() - delay_) % buffer_.size()];
      buffer_[write_] = samples[index] + delayed * feedback_;
      write_ = (write_ + 1) % buffer_.size();
      samples[index] = delayed;
    }
  }
  void reset() noexcept override { std::ranges::fill(buffer_, 0.0f); }
 private:
  std::vector<float> buffer_;
  std::size_t write_ = 0, delay_ = 0;
  float feedback_ = 0;
};

constexpr std::array<std::string_view, 5> kKinds{"eq", "compressor", "reverb", "pitch", "echo"};
}  // namespace

BuiltinEffect::BuiltinEffect(std::span<const EffectParameter> definitions) : definitions_(definitions) {
  if (definitions_.size() > kMaximumParameters) throw std::invalid_argument("Too many effect parameters");
  for (std::size_t index = 0; index < definitions_.size(); ++index)
    values_[index].store(definitions_[index].initial, std::memory_order_relaxed);
}
bool BuiltinEffect::setParameter(std::string_view id, float value) noexcept {
  if (!std::isfinite(value)) return false;
  for (std::size_t index = 0; index < definitions_.size(); ++index) {
    if (definitions_[index].id != id) continue;
    values_[index].store((std::clamp)(value, definitions_[index].minimum, definitions_[index].maximum),
                         std::memory_order_relaxed);
    revision_.fetch_add(1, std::memory_order_release);
    return true;
  }
  return false;
}
float BuiltinEffect::parameter(std::string_view id) const noexcept {
  for (std::size_t index = 0; index < definitions_.size(); ++index)
    if (definitions_[index].id == id) return value(index);
  return 0;
}
bool BuiltinEffect::consumeChange() noexcept {
  const auto revision = revision_.load(std::memory_order_acquire);
  if (revision == seen_) return false;
  seen_ = revision;
  return true;
}

std::unique_ptr<BuiltinEffect> makeBuiltinEffect(std::string_view kind) {
  if (kind == "eq") return std::make_unique<Equalizer>();
  if (kind == "compressor") return std::make_unique<Compressor>();
  if (kind == "reverb") return std::make_unique<Reverb>();
  if (kind == "pitch") return std::make_unique<PitchShifter>();
  if (kind == "echo") return std::make_unique<Echo>();
  return nullptr;
}
std::span<const std::string_view> builtinEffectKinds() noexcept { return kKinds; }
}  // namespace syrnike::windows_media::audio_plugins
