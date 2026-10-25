#pragma once

#include "audio_plugins/effect_chain.hpp"

#include <array>
#include <atomic>
#include <span>
#include <string_view>

namespace syrnike::windows_media::audio_plugins {
struct EffectParameter {
  std::string_view id;
  float minimum;
  float maximum;
  float initial;
};

// Effects shipped with the app. Parameters are written by the control thread
// and picked up by the realtime thread at the next block.
class BuiltinEffect : public AudioEffect {
 public:
  static constexpr std::size_t kMaximumParameters = 8;
  std::span<const EffectParameter> parameters() const noexcept { return definitions_; }
  // Clamps into range; false for an unknown id or a non-finite value.
  bool setParameter(std::string_view id, float value) noexcept;
  float parameter(std::string_view id) const noexcept;
 protected:
  explicit BuiltinEffect(std::span<const EffectParameter>);
  float value(std::size_t index) const noexcept { return values_[index].load(std::memory_order_relaxed); }
  // True once after any parameter changed since the previous call.
  bool consumeChange() noexcept;
 private:
  std::span<const EffectParameter> definitions_;
  std::array<std::atomic<float>, kMaximumParameters> values_{};
  std::atomic<std::uint32_t> revision_{1};
  std::uint32_t seen_ = 0;
};

// Kinds: "eq", "compressor", "reverb", "pitch", "echo". Null for anything else.
std::unique_ptr<BuiltinEffect> makeBuiltinEffect(std::string_view kind);
std::span<const std::string_view> builtinEffectKinds() noexcept;
}  // namespace syrnike::windows_media::audio_plugins
