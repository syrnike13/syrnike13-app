# Adaptive screen quality (#124)

Implementation status: policy and keyframe control are integrated with the
production sender. Golden traces, superseded-setting integration, full quality
recovery, late subscription and stalled preview pass locally. The required
20-minute contention acceptance also passes on the published SDK. Dependency
#123 is merged. Local Release tests pass 23/23, focused ASan tests 3/3 and
Media Lab tests 18/18. Protocol generation and staged artifacts also verify.

The real SFU reproduction exposed stale MSID signalling when the SDK reused a
sender for a replacement track, followed by a null-track accessor crash while
inspecting inactive transceivers. Both fixes and their regression tests are
merged in SDK PR #1, release tag `v1.10.0-syrnike.5`. The seven-platform release
build passed. The Windows release artifact decoded 47,484 frames during the
20-minute contention run: 26 ms p95 age, 101 ms maximum, 119 ms maximum frame gap.

## Profiles

The finite profile order is also the user ceiling order; dimensions and FPS
must each fit the selected ceiling. A 1080p30 ceiling excludes 720p60. A
downgrade never increases FPS. Admission requires an
explicit capability bit for the exact hardware H264, GPU conversion and
publication memory configuration. Optional preview memory is excluded from
publication pressure. The policy owns no resources and probes no capabilities.

| Profile | Dimensions | FPS | Target / maximum bitrate | Frame-age budget |
| --- | --- | --- | --- | --- |
| 540p30 | 960 × 540 | 30 | 625 / 625 kbit/s | 150 ms |
| 720p30 | 1280 × 720 | 30 | 2 / 2 Mbit/s | 150 ms |
| 720p60 | 1280 × 720 | 60 | 4 / 4 Mbit/s | 150 ms |
| 1080p30 | 1920 × 1080 | 30 | 6 / 6 Mbit/s | 150 ms |
| 1080p60 | 1920 × 1080 | 60 | 8 / 8 Mbit/s | 150 ms |

These configurations stay within the current project SFU's screen policy.
1440p requires a separate product/SFU decision and is not admitted here.

## Decision rules

Evaluation consumes an immutable measurement and previous policy state and
returns a decision plus next state. The caller supplies monotonic milliseconds;
the policy does not read a clock. All history occupies six fixed entries.

| Input | Pressure threshold | Recovery threshold |
| --- | --- | --- |
| Fresh network estimate | Less than 90% of current target, or poor quality | At least 110% of the next profile maximum |
| Encoder cadence | Outputs below 70% of inputs, with at least four inputs | Outputs at least 90% of inputs |
| Publication GPU pressure | At least 850 permille | Below 600 permille |
| Capture / convert / publish age | Any above 150 ms | All below 75 ms |
| Backpressure | At least 250 permille | Below 50 permille |

Sampling is at least 500 ms apart. Duplicate, out-of-order, or faster samples
cannot build hysteresis. A gap over 1500 ms resets accumulated evidence. Missing
or stale network estimates cannot authorize an upgrade. A pending
reconfiguration resets evidence; enforcing a superseding user setting during
that operation belongs to the sender owner.

Normal downgrade requires three consecutive samples with the same pressure
reason. Emergency downgrade requires two: age at least 300 ms, available bitrate
below half the target, or GPU pressure at least 980 permille. Normal cooldown is
5 seconds; emergency reduction bypasses it. Upgrade requires a continuous
20-second healthy interval with enough bandwidth for the next profile and moves
one level at a time.

At most six reconfiguration attempts are admitted in a rolling minute, including
failed and superseded attempts. Upgrades reserve one attempt for an emergency.
If the budget is full when a user ceiling or capability loss forbids the current
profile, the decision is terminal rather than silently violating the constraint.
The caller records an attempt only when it actually starts reconfiguration.

## Keyframe control

Each generation begins with keyframe intent. Requested, issued and acknowledged
watermarks preserve intent arriving after a previous request. A keyframe from
the matching generation and a sequence after issuance acknowledges only the
issued watermark. Delta frames and stale generations/sequences cannot acknowledge
it. Requests are limited to one per second, with three attempts before an
explicit exhausted result. Exhaustion retains pending intent for the owner to
handle as a terminal recovery failure. SDK callbacks must enqueue into the single
sender control lane; they must not mutate this object concurrently.
An interval without new encoder input does not spend retries: static capture
retains the pending keyframe intent until a new input can satisfy it.

## Sender ownership and measurements

One sender worker owns decisions and profile replacement. It stops frame
admission, drains encoder and publication leases, destroys the old resources,
and only then allocates the next generation. A monotonic capture-time fence also
rejects leases acquired by the producer before drain and submitted after restart.
Drain, encoder initialization and publication share one 10-second deadline.
Room remains connected. A newer desired revision is revalidated before admission;
a delayed publication response cannot commit a superseded setting.

The Room transport owns one public `Room::getStats()` sampler with at most one
outstanding future across profile replacements. Requests are spaced by 500 ms;
only the selected publisher ICE candidate pair contributes available bandwidth.
Samples older than two seconds are unknown, including late responses (timestamped
at request time). Preview measurements do not enter the policy. A real fixed
1080p60 preview/SFU run produced 206 bandwidth measurements, 7.30–9.90 Mbit/s,
while the observer decoded 775 frames at 25 ms p95 frame age.

Encoded output older than 150 ms is discarded before SDK admission and queues
keyframe recovery intent. Static capture does not reuse stale last-value
diagnostics as fresh GPU/age pressure.

## Local validation

`adaptive-screen-policy` runs without a GPU, sleeps or wall-clock dependencies.
Golden decisions cover bandwidth collapse/recovery and separate encoder, GPU,
age and backpressure causes. Stable and noisy 20-minute synthetic traces require
zero switches. Alternating contention checks the rolling change-rate bound.
Boundary tests cover unknown network measurements, missing samples, duplicate
samples, user ceilings, capability loss, emergency cooldown bypass, and keyframe
intent arriving while an earlier request is in flight.

## Observer acceptance

- The published SDK artifact is pinned. Late subscription and recovery decoded
  2,675 frames across six publications, at 23 ms p95 and 41 ms maximum age, with
  zero observer reconnects. The rolling maximum was three changes per minute.
  The transition and 20-minute release-artifact evidence is
  in [adaptive-screen-quality-acceptance.json](adaptive-screen-quality-acceptance.json).
- One earlier run crossed an SDK Room reconnection after a server
  connection timeout, leaving two replacements without decoded frames and
  exceeding the handle allowance. This is rejected, even though frame-age p95
  remained 26 ms. The oracle also explicitly rejects Room reconnection. The
  qualifying run had no profile changes, constant publication bytes, queue depth
  at most two, and 1.7 ms additional p95 age. Process handle mean changed by 34.4
  within the fixed 64-handle allowance; thread mean decreased by seven. D3D handle
  types remained constant in additional live snapshots. This is a bounded
  20-minute observation, not a claim that every OS/driver cache is allocation-free.

Existing local evidence: full recovery decoded 3,227 frames across six
publications (25 ms p95, 43 ms maximum); delayed subscription decoded 2,644
frames (24 ms p95, 40 ms maximum), with each replacement's first frame within
2.5 seconds of subscription. A stalled preview at the admitted 720p60 ceiling
left publication at that ceiling with zero quality changes and zero reconnects.
These short runs do not replace the contention acceptance.
