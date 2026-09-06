#include "screen/adaptive_screen_policy.hpp"
#include "core/network_observation.hpp"
#include "core/packet_send_delay.hpp"
#include <limits>
#include "screen/screen_keyframe_control.hpp"
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
  bool operator==(const Change&) const = default;
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
      require(decision.target_bitrate >= preset.min_bitrate &&
              decision.target_bitrate <= preset.max_bitrate, "bitrate escaped preset bounds");
      changes.push_back({sample.now_ms, decision.target_bitrate, decision.reason});
      state = recordAdaptiveBitrateAttempt(state, sample.now_ms);
      if (apply) sample.applied_bitrate = decision.target_bitrate;
    }
    sample.now_ms += 500;
    return decision;
  }
  void ticks(unsigned count) { while (count--) tick(); }
};
void golden() {
  Trace collapse;
  collapse.sample.available_outgoing_bitrate = 1'000'000;
  collapse.ticks(10);
  require(collapse.changes == std::vector<Change>{{500, 2'000'000, AdaptiveReason::network}},
          "collapse golden differs");
  require(collapse.state.warning, "below minimum must warn without terminating");
  collapse.sample.available_outgoing_bitrate = 20'000'000;
  collapse.ticks(41);
  require(collapse.changes == std::vector<Change>{{500, 2'000'000, AdaptiveReason::network},
      {25000, 2'500'000, AdaptiveReason::healthy}}, "recovery golden differs");
  require(!collapse.state.warning, "sustained recovery did not clear warning");
  require(collapse.sample.selected_preset == 4, "automatic control changed user intent");

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
  }
}
void boundaries() {
  Trace t;
  t.sample.available_outgoing_bitrate = 1'000'000;
  t.tick();
  auto duplicate = t.sample;
  duplicate.now_ms = 0;
  for (unsigned i = 0; i < 1000; ++i) {
    auto d = evaluateAdaptiveScreenPolicy(duplicate, t.state);
    require(d.action == AdaptiveAction::keep && d.next.pressure_samples == 1,
            "duplicate samples built pressure");
  }
  t.sample.now_ms += 2000;
  require(t.tick().action == AdaptiveAction::keep, "gap built pressure");
  t.sample.update_pending = true;
  t.ticks(30);
  require(t.changes.empty(), "pending operation created another command");

  Trace unconfirmed;
  unconfirmed.sample.available_outgoing_bitrate = 1'000'000;
  unconfirmed.tick(false); unconfirmed.tick(false);
  require(unconfirmed.sample.applied_bitrate == 8'000'000,
          "policy pretended requested bitrate was applied");
  unconfirmed.sample.live_update_available = false;
  unconfirmed.ticks(2400);
  require(unconfirmed.changes.size() == 1 && unconfirmed.state.warning,
          "unsupported update retried or cleared warning");
  unconfirmed.sample.available_outgoing_bitrate = 20'000'000;
  unconfirmed.ticks(2400);
  require(unconfirmed.state.warning, "healthy network pretended capability recovered");

  for (int missing = 0; missing < 3; ++missing) {
    Trace unknown;
    unknown.sample.applied_bitrate = 2'000'000;
    unknown.state.warning = true;
    if (missing == 0) unknown.sample.network_measurement_fresh = false;
    if (missing == 1) unknown.sample.local_measurements_fresh = false;
    if (missing == 2) unknown.sample.available_outgoing_bitrate.reset();
    unknown.ticks(2400);
    require(unknown.changes.empty() && unknown.state.warning,
            "partially stale measurements proved recovery");
  }
  Trace static_screen;
  static_screen.sample.encoder_inputs = static_screen.sample.encoder_outputs = 0;
  static_screen.sample.local_measurements_fresh = false;
  static_screen.sample.publish_age_ms = 60000;
  static_screen.ticks(2400);
  require(static_screen.changes.empty(), "static last-value diagnostics changed bitrate");

  for (std::size_t preset = 0; preset < kAdaptiveScreenProfiles.size(); ++preset) {
    Trace minimum;
    minimum.sample.selected_preset = preset;
    minimum.sample.applied_bitrate = kAdaptiveScreenProfiles[preset].min_bitrate;
    minimum.sample.available_outgoing_bitrate = 1;
    minimum.ticks(2400);
    require(minimum.changes.empty() && minimum.state.warning, "minimum did not continue bounded");
  }
}
void longTraces() {
  Trace noisy, stable, contention;
  for (unsigned i = 0; i < 2400; ++i) {
    noisy.sample.available_outgoing_bitrate = i % 2 ? 20'000'000 : 1'000'000;
    noisy.tick(); stable.tick();
    contention.sample.publication_gpu_pressure_permille = i % 120 < 20 ? 990 : 200;
    contention.tick();
  }
  require(noisy.changes.empty() && stable.changes.empty(), "stable/noisy trace oscillated");
  require(!contention.changes.empty(), "contention exercised no updates");
  for (const auto& change : contention.changes) {
    unsigned count = 0;
    for (const auto& other : contention.changes)
      if (other.time <= change.time && change.time - other.time < 60000) ++count;
    require(count <= kAdaptiveMaxChangesPerMinute, "rolling update budget exceeded");
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
          "rejected updates exceeded finite lifetime budget");
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
}

}
int main() {
  using syrnike::windows_media::OutgoingNetworkObservation;
  using syrnike::windows_media::screenPacketQueueBackpressured;
  OutgoingNetworkObservation network;
  require(!screenPacketQueueBackpressured(network, 1000), "unknown queue blocked capture");
  network.packet_send_delay_us = 30'000;
  network.packet_send_delay_measured_at_ms = 1000;
  require(screenPacketQueueBackpressured(network, 1250), "fresh queue pressure ignored");
  require(!screenPacketQueueBackpressured(network, 1251), "stale queue blocked capture");
  require(!screenPacketQueueBackpressured(network, 999), "future queue blocked capture");
  network.packet_send_delay_us = 29'999;
  require(!screenPacketQueueBackpressured(network, 1000), "healthy queue blocked capture");
  network.packet_send_delay_measured_at_ms = 0;
  network.packet_send_delay_us = 100'000;
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
    golden(); boundaries(); longTraces(); mailboxFences(); keyframes();
    std::cout << "Fixed-preset bitrate golden traces and keyframe boundaries passed\n";
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
