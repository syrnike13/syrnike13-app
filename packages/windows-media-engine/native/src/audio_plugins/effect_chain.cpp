#include "audio_plugins/effect_chain.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <numbers>
#include <stdexcept>

namespace syrnike::windows_media::audio_plugins {
namespace {
constexpr float kMixRampStep = 1.0f / (0.020f * kEffectSampleRate);
float clampMix(float value) noexcept { return std::isfinite(value) ? (std::clamp)(value, 0.0f, 1.0f) : 1.0f; }
}  // namespace

namespace {
thread_local const char* tl_plugin_activity = nullptr;
}  // namespace
PluginActivity::PluginActivity(const char* label) noexcept : previous_(tl_plugin_activity) {
  tl_plugin_activity = label;
}
PluginActivity::~PluginActivity() { tl_plugin_activity = previous_; }
const char* PluginActivity::current() noexcept { return tl_plugin_activity; }

void EffectLoad::record(std::uint64_t ns) noexcept {
  blocks_.fetch_add(1, std::memory_order_relaxed);
  total_ns_.fetch_add(ns, std::memory_order_relaxed);
  if (ns > max_ns_.load(std::memory_order_relaxed)) max_ns_.store(ns, std::memory_order_relaxed);
  histogram_[(std::min)(ns / kBucketNs, std::uint64_t{kBuckets - 1})].fetch_add(1, std::memory_order_relaxed);
}
EffectLoad::Snapshot EffectLoad::snapshot() const noexcept {
  Snapshot value;
  value.blocks = blocks_.load(std::memory_order_relaxed);
  value.total_ns = total_ns_.load(std::memory_order_relaxed);
  value.max_ns = max_ns_.load(std::memory_order_relaxed);
  for (std::size_t index = 0; index < kBuckets; ++index)
    value.histogram[index] = histogram_[index].load(std::memory_order_relaxed);
  return value;
}
std::uint64_t EffectLoad::Snapshot::percentileNs(double fraction) const noexcept {
  std::uint64_t total = 0;
  for (const auto count : histogram) total += count;
  if (!total) return 0;
  const auto target = static_cast<std::uint64_t>(fraction * static_cast<double>(total));
  std::uint64_t seen = 0;
  for (std::size_t index = 0; index < kBuckets; ++index) {
    seen += histogram[index];
    if (seen > target) return (index + 1) * kBucketNs;
  }
  return kBuckets * kBucketNs;
}

EffectSlot::EffectSlot(std::unique_ptr<AudioEffect> effect, float mix, bool enabled, std::string label)
    : effect_(std::move(effect)), target_mix_(clampMix(mix)), enabled_(enabled), label_(std::move(label)) {
  if (!effect_) throw std::invalid_argument("Effect slot requires an effect");
  latency_ = effect_->latencySamples();
  if (latency_ > kMaximumLatencySamples) throw std::invalid_argument("Effect latency is out of range");
  dry_delay_.assign(latency_, 0.0f);
}
void EffectSlot::setMix(float mix) noexcept { target_mix_.store(clampMix(mix), std::memory_order_relaxed); }
void EffectSlot::setEnabled(bool enabled) noexcept { enabled_.store(enabled, std::memory_order_relaxed); }
void EffectSlot::process(float* samples, std::size_t count) noexcept {
  count = (std::min)(count, kEffectBusFrameSamples);
  const float target = enabled_.load(std::memory_order_relaxed) ? target_mix_.load(std::memory_order_relaxed) : 0.0f;
  if (!running_) {
    if (target <= 0.0f) return;
    // A slot that comes back from bypass starts from silence, not old tails.
    effect_->reset();
    std::ranges::fill(dry_delay_, 0.0f);
    dry_position_ = 0;
    mix_ = 0.0f;
    running_ = true;
  }
  for (std::size_t index = 0; index < count; ++index) {
    if (dry_delay_.empty()) {
      dry_[index] = samples[index];
    } else {
      dry_[index] = dry_delay_[dry_position_];
      dry_delay_[dry_position_] = samples[index];
      dry_position_ = (dry_position_ + 1) % dry_delay_.size();
    }
  }
  const auto started = std::chrono::steady_clock::now();
  {
    PluginActivity activity(label_.c_str());
    effect_->process(samples, count);
  }
  load_.record(static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - started).count()));
  for (std::size_t index = 0; index < count; ++index) {
    if (mix_ < target) mix_ = (std::min)(target, mix_ + kMixRampStep);
    else if (mix_ > target) mix_ = (std::max)(target, mix_ - kMixRampStep);
    // Equal-power law keeps loudness steady through the middle of the range.
    const float angle = mix_ * std::numbers::pi_v<float> * 0.5f;
    const float wet = std::isfinite(samples[index]) ? samples[index] : 0.0f;
    samples[index] = wet * std::sin(angle) + dry_[index] * std::cos(angle);
  }
  if (target <= 0.0f && mix_ <= 0.0f) running_ = false;
}

std::uint32_t EffectChain::latencySamples() const noexcept {
  std::uint32_t total = 0;
  for (const auto& slot : slots_) total += slot->latencySamples();
  return total;
}
bool EffectChain::active() const noexcept {
  return std::ranges::any_of(slots_, [](const auto& slot) { return slot->enabled(); });
}
void EffectChain::process(float* samples, std::size_t count) noexcept {
  for (auto& slot : slots_) slot->process(samples, count);
}

EffectChainExchange::~EffectChainExchange() {
  delete pending_.exchange(nullptr);
  collect();
  delete active_.exchange(nullptr);
}
void EffectChainExchange::publish(std::unique_ptr<EffectChain> chain) {
  collect();
  delete pending_.exchange(chain.release(), std::memory_order_acq_rel);
}
void EffectChainExchange::collect() noexcept {
  if (!retired_full_.load(std::memory_order_acquire)) return;
  delete retired_.exchange(nullptr, std::memory_order_acq_rel);
  retired_full_.store(false, std::memory_order_release);
}
EffectChain* EffectChainExchange::latest() const noexcept {
  if (auto* pending = pending_.load(std::memory_order_acquire)) return pending;
  return active_.load(std::memory_order_acquire);
}
EffectChain* EffectChainExchange::acquire() noexcept {
  // Swap only into an empty retired slot; otherwise keep the current chain for
  // one more block rather than destroying plugin objects on this thread.
  if (!retired_full_.load(std::memory_order_acquire) && pending_.load(std::memory_order_acquire)) {
    if (auto* next = pending_.exchange(nullptr, std::memory_order_acq_rel)) {
      retired_.store(active_.exchange(next, std::memory_order_acq_rel), std::memory_order_release);
      retired_full_.store(true, std::memory_order_release);
    }
  }
  return active_.load(std::memory_order_relaxed);
}
}  // namespace syrnike::windows_media::audio_plugins
