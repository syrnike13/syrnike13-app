#include "screen/adaptive_screen_policy.hpp"
#include "core/network_observation.hpp"
#include "core/packet_send_delay.hpp"
#include <limits>
#include "screen/screen_keyframe_control.hpp"
#include "screen/screen_load_governor.hpp"
#include "screen/live_bitrate_mailbox.hpp"
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace syrnike::windows_media::screen;
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
struct Change {
  std::uint64_t time;
  std::uint32_t bitrate;
  AdaptiveReason reason;
  std::uint32_t frame_rate = 0;
  bool operator==(const Change& other) const {
    return time == other.time && bitrate == other.bitrate && reason == other.reason;
  }
};
struct Trace {
  AdaptiveMeasurements sample;
  AdaptivePolicyState state;
  std::vector<Change> changes;
  Trace() {
    sample.selected_preset = 4;
    sample.applied_bitrate = 8'000'000;
    sample.available_outgoing_bitrate = 20'000'000;
    sample.network_measurement_fresh = sample.local_measurements_fresh = true;
    sample.encoder_inputs = sample.encoder_outputs = 30;
  }
  AdaptiveDecision tick(bool apply = true) {
    const auto decision = evaluateAdaptiveScreenPolicy(sample, state);
    state = decision.next;
    if (decision.action == AdaptiveAction::update_bitrate) {
      const auto& preset = kAdaptiveScreenProfiles[sample.selected_preset];
      require(decision.target_bitrate >= preset.min_bitrate / 8 / 25'000 * 25'000 &&
              decision.target_bitrate <= preset.max_bitrate, "bitrate escaped preset bounds");
      require(decision.frame_rate >= adaptiveMinimumFrameRate(preset) &&
              decision.frame_rate <= preset.fps, "frame rate escaped preset bounds");
      // Below the floor, the stream still fits what the network allows.
      if (decision.target_bitrate < preset.min_bitrate &&
          decision.target_bitrate > preset.min_bitrate / 8 / 25'000 * 25'000)
        require(static_cast<std::uint64_t>(decision.target_bitrate) * decision.frame_rate /
                    preset.fps <= decision.network_target, "stream exceeded the budget");
      changes.push_back({sample.now_ms, decision.target_bitrate, decision.reason,
                         decision.frame_rate});
      state = recordAdaptiveBitrateAttempt(state, sample.now_ms);
      if (apply) {
        sample.applied_bitrate = decision.target_bitrate;
        sample.frame_rate = decision.frame_rate;
      }
    }
    sample.now_ms += 500;
    return decision;
  }
  void ticks(unsigned count) { while (count--) tick(); }
};
void golden() {
  require(adaptiveStartBitrate(kAdaptiveScreenProfiles[4]) == 4'800'000 &&
          adaptiveStartBitrate(kAdaptiveScreenProfiles[0]) == 375'000,
          "start bitrate is not below the SDK's initial estimate");

  // Startup: the encoder opens at 60% while WebRTC starts at 90% of the
  // declared maximum, then follows the sender budget within seconds.
  Trace start;
  start.sample.applied_bitrate = 4'800'000;
  start.state = recordAdaptiveBitrateAttempt(start.state, 0);
  start.sample.now_ms = 500;
  start.sample.available_outgoing_bitrate = 7'200'000;
  start.ticks(2);
  start.sample.sender_bitrate_allocation = 7'070'000;
  start.ticks(2);
  // Measured on loopback: the estimate tops out at the declared maxima and
  // audio takes its share, so the video budget stays just below 8 Mbit/s.
  start.sample.available_outgoing_bitrate = 8'120'000;
  start.sample.sender_bitrate_allocation = 7'940'000;
  start.ticks(3);
  require(start.changes == std::vector<Change>{{1000, 6'100'000, AdaptiveReason::healthy},
      {2000, 6'700'000, AdaptiveReason::healthy}, {3000, 8'000'000, AdaptiveReason::healthy}},
      "startup did not follow the sender budget to the full preset");
  require(!start.state.warning, "following the network raised a quality warning");

  // Just below the full-budget threshold the overshoot margin applies again.
  Trace margin;
  margin.sample.sender_bitrate_allocation = 7'750'000;
  margin.ticks(1);
  require(margin.changes == std::vector<Change>{{0, 7'350'000, AdaptiveReason::network}},
          "a constrained budget near the maximum lost its margin");

  // The encoder follows a falling budget within one sample and a rising one
  // after a second; it never waits for a long healthy interval.
  Trace follow;
  follow.sample.sender_bitrate_allocation = 3'000'000;
  follow.ticks(1);
  follow.sample.sender_bitrate_allocation = 6'000'000;
  follow.ticks(3);
  follow.sample.sender_bitrate_allocation = 1'000'000;
  follow.ticks(2);
  require(follow.changes == std::vector<Change>{{0, 2'850'000, AdaptiveReason::network},
      {1000, 5'700'000, AdaptiveReason::healthy}, {2000, 1'000'000, AdaptiveReason::network}},
      "sender budget golden differs");
  require(follow.sample.frame_rate == 57, "a budget below half the floor kept every frame");
  require(follow.state.warning, "a budget below the preset floor must warn");

  // Before the first budget only the uncapped link estimate is known.
  Trace link;
  link.sample.available_outgoing_bitrate = 1'000'000;
  link.ticks(10);
  link.sample.available_outgoing_bitrate = 20'000'000;
  link.ticks(3);
  require(link.changes == std::vector<Change>{{0, 1'000'000, AdaptiveReason::network},
      {5000, 8'000'000, AdaptiveReason::healthy}}, "link fallback golden differs");
  require(link.sample.frame_rate == 60, "recovered budget did not restore the frame rate");
  require(link.sample.selected_preset == 4, "automatic control changed user intent");

  for (const auto reason : {AdaptiveReason::encoder, AdaptiveReason::gpu,
                            AdaptiveReason::frame_age, AdaptiveReason::backpressure}) {
    Trace t;
    t.ticks(2);
    if (reason == AdaptiveReason::encoder) t.sample.encoder_outputs = 10;
    if (reason == AdaptiveReason::gpu) t.sample.publication_gpu_pressure_permille = 900;
    if (reason == AdaptiveReason::frame_age) t.sample.publish_age_ms = 200;
    if (reason == AdaptiveReason::backpressure) t.sample.backpressure_permille = 300;
    t.ticks(3);
    require(t.changes == std::vector<Change>{{2000, 6'000'000, reason}}, "pressure golden differs");
    require(t.state.warning, "local pressure did not warn");
    t.sample.encoder_outputs = 30;
    t.sample.publication_gpu_pressure_permille = 0;
    t.sample.publish_age_ms = 0;
    t.sample.backpressure_permille = 0;
    t.ticks(82);
    require(t.changes == std::vector<Change>{{2000, 6'000'000, reason},
        {22500, 7'500'000, AdaptiveReason::healthy}, {42500, 8'000'000, AdaptiveReason::healthy}},
        "local recovery golden differs");
    require(!t.state.warning && !t.state.local_ceiling, "recovered local cap remained");
  }

  // Local pressure caps a generous network budget, and the tighter one wins.
  Trace both;
  both.sample.sender_bitrate_allocation = 8'000'000;
  both.sample.publish_age_ms = 300;
  both.ticks(2);
  both.sample.sender_bitrate_allocation = 4'000'000;
  both.ticks(1);
  require(both.changes == std::vector<Change>{{500, 6'000'000, AdaptiveReason::frame_age},
      {1000, 3'800'000, AdaptiveReason::network}}, "emergency or tighter budget golden differs");
}
// Below the preset floor smooth motion goes last: per-frame quality falls
// first to half the floor, then the frame rate down to 30, then quality again.
void belowFloor() {
  Trace t;
  t.sample.sender_bitrate_allocation = 1'600'000;
  t.ticks(1);
  require(t.sample.frame_rate == 60 && t.sample.applied_bitrate == 1'500'000,
          "a budget above half the floor dropped frames");
  t.sample.sender_bitrate_allocation = 800'000;
  t.ticks(1);
  require(t.sample.frame_rate == 46 && t.sample.applied_bitrate == 975'000,
          "below half the floor the frame rate did not take over");
  t.sample.sender_bitrate_allocation = 100'000;
  t.ticks(1);
  require(t.sample.frame_rate == 30 && t.sample.applied_bitrate == 250'000,
          "a tiny budget went below 30 fps");
  t.sample.sender_bitrate_allocation = 8'000'000;
  t.ticks(3);
  require(t.sample.frame_rate == 60 && t.sample.applied_bitrate == 8'000'000,
          "a recovered budget did not restore the full preset");
  require(t.changes.size() == 4 && t.changes[2].reason == AdaptiveReason::network &&
          t.changes[3].reason == AdaptiveReason::healthy, "below-floor reasons differ");

  // Without live encoder control, admission alone follows the budget, and a
  // recovered budget restores every frame.
  Trace fixed;
  fixed.sample.applied_bitrate = 1'000'000;
  fixed.sample.frame_rate = 30;
  fixed.sample.live_update_available = false;
  fixed.sample.sender_bitrate_allocation = 8'000'000;
  auto decision = evaluateAdaptiveScreenPolicy(fixed.sample, fixed.state);
  require(decision.action == AdaptiveAction::keep && decision.frame_rate == 60,
          "lost live control froze a reduced frame rate");
  fixed.sample.sender_bitrate_allocation = 400'000;
  decision = evaluateAdaptiveScreenPolicy(fixed.sample, fixed.state);
  require(decision.frame_rate == 30 && decision.network_target == 380'000,
          "fixed command did not admit fewer frames for a tight budget");

  // A paused share keeps its bitrate, frame rate and warning.
  Trace paused;
  paused.sample.paused = true;
  paused.sample.sender_bitrate_allocation = 0;
  paused.ticks(40);
  require(paused.changes.empty() && !paused.state.warning,
          "a paused share reacted to its zero budget");

  // Steady below the floor, the reason compares the budget with the stream,
  // not with the per-frame-scaled command.
  Trace steady;
  steady.sample.sender_bitrate_allocation = 400'000;
  steady.ticks(6);
  require(steady.changes.size() == 1 && steady.sample.frame_rate == 30, "below-floor setup");
  decision = steady.tick();
  require(decision.reason == AdaptiveReason::healthy, "a settled budget still reported network");

  // The network target is reported even while an update is pending.
  Trace pending;
  pending.sample.sender_bitrate_allocation = 4'000'000;
  pending.sample.update_pending = true;
  require(pending.tick().network_target == 3'800'000, "pending update hid the network target");

  // A 30 fps preset never loses frames; only per-frame quality falls.
  Trace thirty;
  thirty.sample.selected_preset = 3;
  thirty.sample.applied_bitrate = 6'000'000;
  thirty.sample.sender_bitrate_allocation = 300'000;
  thirty.ticks(1);
  require(thirty.sample.frame_rate == 30 && thirty.sample.applied_bitrate == 275'000,
          "a 30 fps preset dropped frames");
}
void boundaries() {
  Trace t;
  t.sample.available_outgoing_bitrate = 1'000'000;
  t.tick();
  auto duplicate = t.sample;
  duplicate.now_ms = 0;
  for (unsigned i = 0; i < 1000; ++i) {
    auto d = evaluateAdaptiveScreenPolicy(duplicate, t.state);
    require(d.action == AdaptiveAction::keep, "duplicate samples changed bitrate");
  }
  t.sample.now_ms += 2000;
  t.sample.available_outgoing_bitrate = 20'000'000;
  require(t.tick().action == AdaptiveAction::keep, "a sampling gap changed bitrate");
  t.changes.clear();
  t.sample.update_pending = true;
  t.ticks(30);
  require(t.changes.empty(), "pending operation created another command");

  Trace unconfirmed;
  unconfirmed.sample.available_outgoing_bitrate = 1'000'000;
  unconfirmed.tick(false); unconfirmed.tick(false);
  require(unconfirmed.sample.applied_bitrate == 8'000'000,
          "policy pretended requested bitrate was applied");
  const auto commanded = unconfirmed.changes.size();
  unconfirmed.sample.live_update_available = false;
  unconfirmed.ticks(2400);
  require(unconfirmed.changes.size() == commanded && unconfirmed.state.warning,
          "unsupported update retried or cleared warning");
  unconfirmed.sample.available_outgoing_bitrate = 20'000'000;
  unconfirmed.ticks(2400);
  require(unconfirmed.state.warning, "healthy network pretended capability recovered");

  // An unknown network never raises the bitrate.
  for (int missing = 0; missing < 2; ++missing) {
    Trace unknown;
    unknown.sample.applied_bitrate = 2'000'000;
    if (missing == 0) unknown.sample.network_measurement_fresh = false;
    if (missing == 1) unknown.sample.available_outgoing_bitrate.reset();
    unknown.ticks(2400);
    require(unknown.changes.empty(), "stale network measurements raised the bitrate");
  }
  // A local cap is lifted only by fresh local evidence, never by the network.
  Trace capped;
  capped.sample.applied_bitrate = 6'000'000;
  capped.state.local_ceiling = 6'000'000;
  capped.state.local_reason = AdaptiveReason::gpu;
  capped.sample.local_measurements_fresh = false;
  capped.ticks(2400);
  require(capped.changes.empty() && capped.state.warning && capped.state.local_ceiling,
          "stale local measurements lifted the local cap");
  Trace static_screen;
  static_screen.sample.encoder_inputs = static_screen.sample.encoder_outputs = 0;
  static_screen.sample.local_measurements_fresh = false;
  static_screen.sample.publish_age_ms = 60000;
  static_screen.ticks(2400);
  require(static_screen.changes.empty(), "static last-value diagnostics changed bitrate");

  for (std::size_t preset = 0; preset < kAdaptiveScreenProfiles.size(); ++preset) {
    Trace minimum;
    const auto& profile = kAdaptiveScreenProfiles[preset];
    minimum.sample.selected_preset = preset;
    minimum.sample.applied_bitrate = profile.min_bitrate;
    minimum.sample.available_outgoing_bitrate = 1;
    minimum.ticks(2400);
    require(minimum.changes.size() == 1 && minimum.state.warning &&
            minimum.sample.frame_rate == adaptiveMinimumFrameRate(profile) &&
            minimum.sample.applied_bitrate <= profile.min_bitrate / 8,
            "minimum did not continue bounded");
  }
}
void longTraces() {
  Trace noisy, stable, jitter, contention;
  for (unsigned i = 0; i < 2400; ++i) {
    noisy.sample.sender_bitrate_allocation = i % 2 ? 8'000'000 : 1'000'000;
    // WebRTC's budget wanders by a few percent between samples.
    jitter.sample.sender_bitrate_allocation = i % 2 ? 5'000'000 : 5'200'000;
    noisy.tick(); stable.tick(); jitter.tick();
    contention.sample.publication_gpu_pressure_permille = i % 120 < 20 ? 990 : 200;
    contention.tick();
  }
  require(stable.changes.empty(), "stable trace changed bitrate");
  require(jitter.changes.size() == 1, "small budget jitter caused platform calls");
  require(!contention.changes.empty(), "contention exercised no updates");
  for (const auto* trace : {&noisy, &contention}) {
    for (std::size_t i = 1; i < trace->changes.size(); ++i) {
      const auto& previous = trace->changes[i - 1];
      const auto& change = trace->changes[i];
      const auto spacing = change.time - previous.time;
      const auto stream = static_cast<std::uint64_t>(change.bitrate) * change.frame_rate;
      const auto previous_stream = static_cast<std::uint64_t>(previous.bitrate) * previous.frame_rate;
      require(spacing >= kAdaptiveDecreaseIntervalMs &&
              (stream < previous_stream || spacing >= kAdaptiveIncreaseIntervalMs),
              "bitrate updates exceeded the platform cadence");
    }
  }
}
void mailboxFences() {
  LiveBitrateMailbox mailbox(8'000'000);
  require(!mailbox.request(1, 9'000'000), "encoder maximum exceeded");
  require(mailbox.request(1, 4'000'000), "first command rejected");
  require(mailbox.take(0)->revision == 1, "first command missing");
  for (std::uint64_t revision = 2; revision <= 1000; ++revision)
    require(mailbox.request(revision, 2'000'000), "coalesced desired value rejected");
  require(!mailbox.take(1), "two simultaneous platform operations");
  require(mailbox.snapshot(1).applied_bitrate == 8'000'000, "unconfirmed update committed");
  mailbox.complete(1, BitrateUpdateOutcome::applied, 0, 10);
  require(mailbox.snapshot(10).applied_bitrate == 4'000'000, "confirmed result missing");
  require(mailbox.take(20)->revision == 1000, "latest desired value did not coalesce");
  mailbox.complete(1, BitrateUpdateOutcome::applied, 0, 30);
  require(mailbox.snapshot(30).outcome == BitrateUpdateOutcome::pending, "stale completion won");
  mailbox.stop();
  mailbox.complete(1000, BitrateUpdateOutcome::applied, 0, 40);
  require(mailbox.snapshot(40).applied_bitrate == 4'000'000 && !mailbox.request(1001, 1'500'000),
          "late completion changed stopped intent");
  LiveBitrateMailbox nextIntent(6'000'000);
  require(nextIntent.snapshot(50).applied_bitrate == 6'000'000, "old command leaked to new encoder");

  LiveBitrateMailbox unsupported(8'000'000);
  require(unsupported.request(1, 4'000'000) && unsupported.take(0).has_value(), "request missing");
  unsupported.complete(1, BitrateUpdateOutcome::unsupported, -1, 1);
  for (std::uint64_t revision = 2; revision < 1000; ++revision)
    require(!unsupported.request(revision, 4'000'000), "unsupported update storm");
  require(unsupported.snapshot(2).applied_bitrate == 8'000'000, "unsupported changed initial bitrate");

  LiveBitrateMailbox rejected(8'000'000);
  require(rejected.request(1, 4'000'000) && rejected.take(0).has_value(), "request missing");
  rejected.complete(1, BitrateUpdateOutcome::applied, 0, 1);
  for (std::uint64_t revision = 2; revision <= 4; ++revision) {
    require(rejected.request(revision, 2'000'000) && rejected.take(revision * 5000).has_value(),
            "retry budget exhausted prematurely");
    rejected.complete(revision, BitrateUpdateOutcome::rejected, -2, revision * 5000 + 1);
    require(rejected.snapshot(revision * 5000 + 2).applied_bitrate == 4'000'000,
            "rejected update replaced last confirmed bitrate");
  }
  require(!rejected.request(5, 2'000'000) && !rejected.snapshot(25000).available,
          "consecutive rejected updates exceeded their budget");
  // A success between rejections restarts the budget: frequent updates must
  // not end live control after scattered rejections.
  LiveBitrateMailbox scattered(8'000'000);
  for (std::uint64_t revision = 1; revision <= 30; ++revision) {
    require(scattered.request(revision, 4'000'000) && scattered.take(revision * 10).has_value(),
            "scattered rejections disabled live control");
    scattered.complete(revision, revision % 3 ? BitrateUpdateOutcome::rejected
                                              : BitrateUpdateOutcome::applied,
                       0, revision * 10 + 1);
  }
  require(scattered.snapshot(400).available, "scattered rejections disabled live control");
  LiveBitrateMailbox hung(8'000'000);
  require(hung.request(1, 4'000'000) && hung.take(0).has_value(), "request missing");
  require(hung.snapshot(1999).outcome == BitrateUpdateOutcome::pending &&
          hung.snapshot(2000).outcome == BitrateUpdateOutcome::unsafe, "deadline boundary wrong");
  hung.complete(1, BitrateUpdateOutcome::applied, 0, 2000);
  require(hung.snapshot(2001).outcome == BitrateUpdateOutcome::unsafe &&
          hung.snapshot(2001).applied_bitrate == 8'000'000, "late unsafe result committed");
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

  // Network backpressure leaves sparse input: each retry is due as soon as the
  // keyframe input is admitted, before that keyframe is encoded and consumed.
  c.begin(4);
  require(c.poll(0, 10) == KeyframeAction::request, "late-keyframe request missing");
  for (std::uint64_t round = 1; round <= 10; ++round) {
    require(c.request(4), "lost late-keyframe intent");
    const auto answer = 10 + round;
    require(c.poll(round * 1000, answer) == KeyframeAction::request,
            "late keyframe exhausted the retry budget");
    c.progress(4, answer, true);
  }
  require(c.attempts() == 1 && c.pending() == 1, "late keyframes lost outstanding attempts");
  c.progress(4, 20, true);
  require(c.pending() == 1, "keyframe before the latest attempt acknowledged it");
  c.progress(4, 21, true);
  require(c.attempts() == 0 && c.pending() == 0,
          "keyframe after the latest attempt not acknowledged");
}
void localPressure() {
  Trace lossy;
  // A link far below the preset: the network binds the bitrate here.
  lossy.sample.available_outgoing_bitrate = 3'000'000;
  lossy.sample.publish_age_ms = 250;
  const auto decision = lossy.tick();
  require(decision.reason == AdaptiveReason::network, "network verdict changed");
  require(decision.local_measured && decision.local_pressure == AdaptiveReason::frame_age,
          "lossy network hid local load");
  Trace stale;
  stale.sample.local_measurements_fresh = false;
  stale.sample.publish_age_ms = 250;
  require(!stale.tick().local_measured, "stale sample judged local load");
}
void encoderRecoveryBudget() {
  ScreenEncoderRecoveryBudget budget;
  require(budget.available(1'000), "first in-place recovery refused");
  budget.consume(1'000);
  require(budget.available(2'000), "second in-place recovery refused");
  budget.consume(2'000);
  require(!budget.available(3'000), "in-place recoveries were unbounded");
  require(!budget.available(60'999), "recovery window expired early");
  require(budget.available(61'000), "recovery window never expired");
  budget.consume(61'000);
  require(!budget.available(61'500), "newest recoveries were forgotten");
  require(budget.available(122'000), "budget did not recover after a quiet minute");
}
void loadGovernor() {
  using L = ScreenLoadLevel;
  ScreenLoadGovernor g;
  std::uint64_t t = 0;
  const auto step = [&](bool pressure, bool measured = true, bool reducible = true) {
    t += 500;
    return g.observe(t, measured, pressure, reducible);
  };
  require(step(true) == L::normal && step(true) == L::normal, "boosted before sustained load");
  require(step(false) == L::normal, "single quiet sample kept pressure streak");
  step(true); step(true);
  require(step(true) == L::boosted, "sustained load not boosted");
  for (int i = 0; i < 5; ++i) require(step(true) == L::boosted, "frame rate dropped before boost settled");
  require(step(true) == L::reduced_frame_rate, "persisting load kept full frame rate");
  for (int i = 0; i < 100; ++i) require(step(false, false) == L::reduced_frame_rate,
                                         "unmeasured samples relaxed the level");
  // The first measured sample after the gap counts one capped interval (1 s).
  for (int i = 0; i < 58; ++i) require(step(false) == L::reduced_frame_rate, "frame rate restored early");
  require(step(false) == L::boosted, "frame rate never restored");
  // Load returns right after the restore: back to half rate, longer hold.
  for (int i = 0; i < 6; ++i) step(true);
  require(g.level() == L::reduced_frame_rate && g.restoreHoldMs() == 60'000,
          "premature restore did not back off");
  for (int i = 0; i < 120; ++i) step(false);
  require(g.level() == L::boosted, "backed-off restore never happened");
  for (int i = 0; i < 59; ++i) require(step(false) == L::boosted, "boost released early");
  require(step(false) == L::normal, "boost never released");
  require(g.restoreHoldMs() == 30'000, "back-off survived the end of the load");
  // A 30 fps preset has no lower rate: boost only.
  ScreenLoadGovernor thirty;
  t = 0;
  for (int i = 0; i < 40; ++i) { t += 500; thirty.observe(t, true, true, false); }
  require(thirty.level() == L::boosted, "30 fps preset lost frame rate or boost");
}

}
int main() {
  using syrnike::windows_media::OutgoingNetworkObservation;
  using syrnike::windows_media::screenPacketQueueBackpressured;
  OutgoingNetworkObservation network;
  require(!screenPacketQueueBackpressured(network, 1000), "unknown queue blocked capture");
  network.packet_send_delay_us = 150'000;
  network.packet_send_delay_measured_at_ms = 1000;
  require(screenPacketQueueBackpressured(network, 1250), "fresh queue pressure ignored");
  require(!screenPacketQueueBackpressured(network, 1251), "stale queue blocked capture");
  require(!screenPacketQueueBackpressured(network, 999), "future queue blocked capture");
  network.packet_send_delay_us = 149'999;
  require(!screenPacketQueueBackpressured(network, 1000), "healthy queue blocked capture");
  network.packet_send_delay_measured_at_ms = 0;
  network.packet_send_delay_us = 200'000;
  require(!screenPacketQueueBackpressured(network, 100), "missing timestamp blocked capture");
  try {
    syrnike::windows_media::PacketSendDelayEstimator queue;
    require(!queue.observe("screen", 10, 1, 1000).delay_us, "first packet counter is not a delta");
    auto sample = queue.observe("screen", 20, 2, 1020);
    require(sample.delay_us == 100'000U && sample.measured_at_ms == 1020, "packet delay units changed");
    sample = queue.observe("screen", 20, 2, 1040);
    require(sample.delay_us == 100'000U && sample.measured_at_ms == 1020, "cached counters refreshed pressure");
    network.packet_send_delay_us = sample.delay_us;
    network.packet_send_delay_measured_at_ms = sample.measured_at_ms;
    require(!screenPacketQueueBackpressured(network, 1271), "unchanged counters starved capture");
    require(queue.observe("screen", 30, 2, 1060).delay_us == 0U, "new unqueued packets retained pressure");
    require(!queue.observe("other", 40, 3, 1080).delay_us, "different stream mixed counters");
    require(!queue.observe("other", 1, 1, 1100).delay_us, "reset counters invented pressure");
    require(!queue.observe("other", 2, 2, 1099).delay_us, "reversed time retained pressure");
    require(!queue.observe("other", 3, 3, 4000).delay_us, "stale counters invented pressure");
    require(!queue.observe("other", 4, std::numeric_limits<double>::quiet_NaN(), 4020).delay_us,
        "NaN packet delay became pressure");
    require(!queue.observe("other", 5, 0, 4040).delay_us, "missing packet delay became pressure");
    queue.reset();
    require(!queue.observe("screen", 99, 20, 4060).delay_us, "Room reset retained packet history");
    golden(); belowFloor(); boundaries(); longTraces(); mailboxFences(); keyframes();
    localPressure(); loadGovernor(); encoderRecoveryBudget();
    std::cout << "Fixed-preset bitrate golden traces and keyframe boundaries passed\n";
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
