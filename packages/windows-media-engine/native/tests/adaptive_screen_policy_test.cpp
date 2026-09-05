#include "screen/adaptive_screen_policy.hpp"
#include "screen/screen_keyframe_control.hpp"

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace syrnike::windows_media::screen;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
struct Change {
  std::uint64_t time;
  std::size_t target;
  AdaptiveReason reason;
  bool operator==(const Change&) const = default;
};
struct Trace {
  AdaptivePolicyState state;
  AdaptiveMeasurements sample;
  std::vector<Change> changes;
  Trace() {
    sample.current_profile = 4;
    sample.supported_profiles = 31;
    sample.available_outgoing_bitrate = 20'000'000;
    sample.network_measurement_fresh = true;
    sample.encoder_inputs = sample.encoder_outputs = 30;
    sample.capture_age_ms = sample.convert_age_ms = sample.publish_age_ms = 20;
  }
  AdaptiveDecision tick() {
    auto d = evaluateAdaptiveScreenPolicy(sample, state);
    state = d.next;
    require(d.action != AdaptiveAction::terminal_capability_failure, "unexpected terminal decision");
    if (d.action != AdaptiveAction::keep) {
      require(d.target_profile <= sample.user_maximum, "user ceiling exceeded");
      changes.push_back({sample.now_ms, d.target_profile, d.reason});
      sample.current_profile = d.target_profile;
      state = recordAdaptiveProfileAttempt(state, sample.now_ms);
    }
    sample.now_ms += 500;
    return d;
  }
  void ticks(unsigned count) { while (count--) tick(); }
};
std::vector<Change> collapseRecovery() {
  Trace t;
  t.ticks(10);
  t.sample.available_outgoing_bitrate = 1'000'000;
  t.ticks(10);
  t.sample.available_outgoing_bitrate = 20'000'000;
  t.ticks(170);
  const std::vector<Change> golden{
    {5500, 0, AdaptiveReason::network},
    {30000, 1, AdaptiveReason::healthy},
    {50500, 2, AdaptiveReason::healthy},
    {71000, 3, AdaptiveReason::healthy},
    {91500, 4, AdaptiveReason::healthy},
  };
  if (t.changes != golden) for (const auto& c : t.changes)
    std::cerr << c.time << ": profile=" << c.target << " reason=" << static_cast<int>(c.reason) << '\n';
  require(t.changes == golden, "collapse/recovery differs from golden trace");
  return t.changes;
}
void pressureTraces() {
  Trace recovery_margin;
  recovery_margin.sample.current_profile = 3;
  recovery_margin.sample.available_outgoing_bitrate = 8'799'999;
  recovery_margin.ticks(100);
  require(recovery_margin.changes.empty(), "recovery ignored next-profile bandwidth margin");
  recovery_margin.sample.available_outgoing_bitrate = 8'800'000;
  recovery_margin.ticks(40);
  require(recovery_margin.changes.empty(), "recovery skipped sustained healthy interval");
  recovery_margin.tick();
  require(recovery_margin.changes == std::vector<Change>{{70000, 4, AdaptiveReason::healthy}},
      "bounded RTP bandwidth estimate cannot recover the user ceiling");
  for (const auto reason : {AdaptiveReason::encoder, AdaptiveReason::gpu,
                            AdaptiveReason::frame_age, AdaptiveReason::backpressure}) {
    Trace t;
    t.ticks(2);
    if (reason == AdaptiveReason::encoder) t.sample.encoder_outputs = 10;
    if (reason == AdaptiveReason::gpu) t.sample.publication_gpu_pressure_permille = 900;
    if (reason == AdaptiveReason::frame_age) t.sample.publish_age_ms = 200;
    if (reason == AdaptiveReason::backpressure) t.sample.backpressure_permille = 300;
    t.ticks(3);
    require(t.changes == std::vector<Change>{{2000, 3, reason}}, "pressure golden trace differs");
  }
  Trace burst;
  burst.sample.publish_age_ms = 900;
  burst.tick();
  burst.sample.publish_age_ms = 20;
  burst.ticks(100);
  require(burst.changes.empty(), "single burst changed profile");
  Trace noisy;
  for (unsigned i = 0; i < 2400; ++i) {
    noisy.sample.available_outgoing_bitrate = i % 2 ? 20'000'000 : 1'000'000;
    noisy.tick();
  }
  require(noisy.changes.empty(), "20-minute noisy golden trace oscillates");
  Trace stable;
  stable.ticks(2400);
  require(stable.changes.empty(), "stable high capacity changed profile");
}
void keyframes() {
  ScreenKeyframeControl c;
  c.begin(1);
  require(c.poll(0, 0) == KeyframeAction::request, "initial keyframe missing");
  for (unsigned i = 0; i < 1000; ++i) require(c.request(1), "lost request");
  c.progress(1, 1, true);
  require(c.pending() == 1000, "acknowledged requests arriving after issue");
  require(c.poll(999, 1) == KeyframeAction::none, "keyframe storm");
  require(c.poll(1000, 1) == KeyframeAction::request, "pending intents not retried");
  c.progress(2, 2, true);
  c.progress(1, 1, true);
  c.progress(1, 2, false);
  require(c.pending() == 1000, "stale generation/sequence or delta frame acknowledged keyframe");
  c.progress(1, 2, true);
  require(c.pending() == 0, "keyframe did not acknowledge issued watermark");
  c.begin(3);
  require(!c.request(1), "old generation accepted");
  require(c.poll(0, 0) == KeyframeAction::request, "transition keyframe missing");
  require(c.poll(60000, 0) == KeyframeAction::none && c.pending() == 1,
          "static capture lost keyframe intent or consumed retry budget");
  require(c.poll(61000, 1) == KeyframeAction::request, "first bounded retry missing");
  require(c.poll(62000, 2) == KeyframeAction::request, "second bounded retry missing");
  require(c.poll(63000, 3) == KeyframeAction::exhausted && c.pending() == 1,
          "retry budget lost intent or loops forever");
}
void contention() {
  Trace t;
  for (unsigned i = 0; i < 2400; ++i) {
    const bool busy = i % 120 < 20;
    t.sample.publication_gpu_pressure_permille = busy ? 990 : 200;
    t.tick();
  }
  for (const auto& c : t.changes) {
    unsigned count = 0;
    for (const auto& other : t.changes)
      if (other.time <= c.time && c.time - other.time < 60000) ++count;
    require(count <= kAdaptiveMaxChangesPerMinute, "20-minute contention exceeds rate bound");
  }
  require(!t.changes.empty(), "contention trace exercised no transitions");
}
void boundaries() {
  Trace fps_downgrade;
  fps_downgrade.sample.current_profile = 3;
  fps_downgrade.sample.encoder_outputs = 10;
  fps_downgrade.ticks(3);
  require(fps_downgrade.sample.current_profile == 1,
          "encoder-pressure downgrade increased FPS");
  Trace fps_ceiling;
  fps_ceiling.sample.current_profile = 2;
  fps_ceiling.sample.user_maximum = 3;
  require(fps_ceiling.tick().reason == AdaptiveReason::user_maximum &&
          fps_ceiling.sample.current_profile == 1,
          "1080p30 ceiling allowed 720p60");
  fps_ceiling.ticks(41);
  require(fps_ceiling.sample.current_profile == 3,
          "upgrade did not skip profile exceeding the FPS ceiling");
  Trace t;
  t.sample.user_maximum = 1;
  require(t.tick().target_profile == 1, "user max did not constrain immediately");
  t.sample.available_outgoing_bitrate = 100'000;
  t.tick();
  auto emergency = t.tick();
  require(emergency.emergency && emergency.target_profile == 0,
          "emergency cooldown blocked downgrade");
  Trace unknown;
  unknown.sample.current_profile = 1;
  unknown.sample.network_measurement_fresh = false;
  unknown.ticks(100);
  require(unknown.changes.empty(), "unknown network permitted upgrade");
  Trace gap;
  gap.sample.current_profile = 1;
  gap.ticks(39);
  gap.sample.now_ms += 5000;
  gap.tick();
  gap.tick();
  require(gap.changes.empty(), "missing samples count as healthy interval");
  Trace unsupported;
  unsupported.sample.supported_profiles = 0;
  require(evaluateAdaptiveScreenPolicy(unsupported.sample, {}).action ==
          AdaptiveAction::terminal_capability_failure, "missing capability not terminal");
  Trace limited;
  for (unsigned i = 0; i < 6; ++i) limited.state = recordAdaptiveProfileAttempt(limited.state, i * 500);
  limited.sample.now_ms = 3000;
  limited.sample.user_maximum = 0;
  require(evaluateAdaptiveScreenPolicy(limited.sample, limited.state).action ==
          AdaptiveAction::terminal_capability_failure, "rate cap silently violates user maximum");
  Trace duplicates;
  duplicates.sample.available_outgoing_bitrate = 1'000'000;
  duplicates.tick();
  duplicates.sample.now_ms = 0;
  for (unsigned i = 0; i < 100; ++i) {
    const auto d = evaluateAdaptiveScreenPolicy(duplicates.sample, duplicates.state);
    require(d.action == AdaptiveAction::keep && d.next.pressure_samples == 1,
            "duplicate samples built hysteresis");
  }
}
}
int main() {
  try {
    require(collapseRecovery() == collapseRecovery(), "trace is nondeterministic");
    pressureTraces();
    boundaries();
    keyframes();
    contention();
    std::cout << "Adaptive policy golden traces and boundaries passed\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
