#pragma once

#include "audio_plugins/effect_bus.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace syrnike::windows_media::audio_plugins {
inline constexpr float kEffectSampleRate = 48'000.0f;

// One 48 kHz mono effect. process() runs on the realtime thread only, with at
// most kEffectBusFrameSamples samples, and must not allocate, lock or log.
class AudioEffect {
 public:
  virtual ~AudioEffect() = default;
  virtual void process(float* samples, std::size_t count) noexcept = 0;
  // Fixed for the lifetime of the effect; a plugin that changes it is rebuilt.
  virtual std::uint32_t latencySamples() const noexcept { return 0; }
  virtual void reset() noexcept {}
};

// Names the plugin code the current thread runs, so a crash report can blame
// one plugin. Labels must outlive the scope; nesting restores the outer one.
class PluginActivity final {
 public:
  explicit PluginActivity(const char* label) noexcept;
  ~PluginActivity();
  PluginActivity(const PluginActivity&) = delete;
  PluginActivity& operator=(const PluginActivity&) = delete;
  static const char* current() noexcept;
 private:
  const char* previous_;
};

// Processing time of one slot, written by the realtime thread only. The
// histogram has 100 us buckets up to the 10 ms frame; the last one is overflow.
class EffectLoad final {
 public:
  static constexpr std::size_t kBuckets = 101;
  static constexpr std::uint64_t kBucketNs = 100'000;
  struct Snapshot {
    std::uint64_t blocks = 0;
    std::uint64_t total_ns = 0;
    std::uint64_t max_ns = 0;
    std::array<std::uint64_t, kBuckets> histogram{};
    // Time below which `fraction` of the blocks finished, at bucket resolution.
    std::uint64_t percentileNs(double fraction) const noexcept;
  };
  void record(std::uint64_t ns) noexcept;
  Snapshot snapshot() const noexcept;
 private:
  std::atomic<std::uint64_t> blocks_{0}, total_ns_{0}, max_ns_{0};
  std::array<std::atomic<std::uint64_t>, kBuckets> histogram_{};
};

// An effect with its own dry/wet mix. The dry path is delayed by the effect
// latency so a partial mix does not comb-filter. Mix and enable changes ramp
// over 20 ms; a disabled slot that has faded out skips the effect entirely.
class EffectSlot final {
 public:
  static constexpr std::uint32_t kMaximumLatencySamples = 48'000;  // 1 s
  // The label names the effect in crash reports (slot id and plugin name).
  EffectSlot(std::unique_ptr<AudioEffect>, float mix, bool enabled, std::string label = {});
  const std::string& label() const noexcept { return label_; }
  void setMix(float) noexcept;
  void setEnabled(bool) noexcept;
  float mix() const noexcept { return target_mix_.load(std::memory_order_relaxed); }
  bool enabled() const noexcept { return enabled_.load(std::memory_order_relaxed); }
  std::uint32_t latencySamples() const noexcept { return latency_; }
  AudioEffect& effect() noexcept { return *effect_; }
  // Time spent inside the effect itself; a bypassed slot records nothing.
  const EffectLoad& load() const noexcept { return load_; }
  void process(float* samples, std::size_t count) noexcept;
 private:
  std::unique_ptr<AudioEffect> effect_;
  std::atomic<float> target_mix_;
  std::atomic<bool> enabled_;
  float mix_ = 0;  // realtime thread: effective (enable-gated) mix
  bool running_ = false;
  std::uint32_t latency_ = 0;
  std::vector<float> dry_delay_;
  std::size_t dry_position_ = 0;
  std::array<float, kEffectBusFrameSamples> dry_{};
  EffectLoad load_;
  std::string label_;
};

// Slots are shared by consecutive chains, so reordering or adding an effect
// keeps the others' state. The realtime thread runs one chain at a time and
// never holds a reference: only the control thread releases slots.
class EffectChain final {
 public:
  void add(std::shared_ptr<EffectSlot> slot) { slots_.push_back(std::move(slot)); }
  std::size_t size() const noexcept { return slots_.size(); }
  EffectSlot& slot(std::size_t index) noexcept { return *slots_[index]; }
  std::uint32_t latencySamples() const noexcept;
  bool active() const noexcept;
  void process(float* samples, std::size_t count) noexcept;
 private:
  std::vector<std::shared_ptr<EffectSlot>> slots_;
};

// Hands a new chain to the realtime thread without locks. The control thread
// publishes and later destroys what the realtime thread retired, so plugin
// objects are released on the thread that created them.
class EffectChainExchange final {
 public:
  ~EffectChainExchange();
  // Control thread.
  void publish(std::unique_ptr<EffectChain>);
  void collect() noexcept;
  // The chain the realtime thread uses now, or will use after its next block.
  EffectChain* latest() const noexcept;
  // Realtime thread.
  EffectChain* acquire() noexcept;
 private:
  std::atomic<EffectChain*> pending_{nullptr}, retired_{nullptr};
  std::atomic<EffectChain*> active_{nullptr};
  // Set while retired_ holds a chain the control thread has not destroyed.
  std::atomic<bool> retired_full_{false};
};
}  // namespace syrnike::windows_media::audio_plugins
