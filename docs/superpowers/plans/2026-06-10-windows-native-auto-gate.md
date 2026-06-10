# Windows Native Auto-Gate Rework Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Windows C++ microphone auto-gate so it behaves like a production voice gate for calls: stable in noise, does not chop syllables, matches preview/publish behavior, and keeps the UI as a simple gate on/off plus auto/manual threshold preference.

**Architecture:** Keep the processing inside `apps/desktop/native/native-voice-win` and replace the current fixed RMS gate with an adaptive speech gate. The gate should use 10 ms frames, a smoothed level detector, adaptive noise-floor estimation in auto mode, hysteresis, hangover, soft attenuation range, and a small lookahead/pre-roll buffer only when automatic voice gate is enabled. Do not add AGC, do not move this into browser code, and do not add a heavy ML dependency for the first implementation.

**Tech Stack:** C++20, WASAPI microphone capture, LiveKit/WebRTC APM output, CMake/CTest, Electron IPC, TypeScript/Vitest contract tests.

---

## Research Notes

- WebRTC VAD is a stronger model than plain RMS. Its source uses spectral features, GMM speech/noise hypotheses, aggressiveness modes, and internal overhang/hangover constants for 10/20/30 ms frames. Source: https://webrtc.googlesource.com/src/+/refs/heads/main/common_audio/vad/vad_core.c and API: https://webrtc.googlesource.com/src/+/refs/heads/main/common_audio/vad/include/webrtc_vad.h
- Standard noise gates use threshold, attack, hold, release, range, and often lookahead. Hysteresis and hold prevent chatter; range avoids complete hard muting when full silence is too aggressive. Source: https://en.wikipedia.org/wiki/Noise_gate
- Noise suppression is not the same feature as voice gate. RNNoise uses VAD internally to estimate speech/noise, but adding RNNoise here would overlap with the existing WebRTC noise suppression and increase dependency/QA surface. Source: https://jmvalin.ca/demo/rnnoise/
- The local LiveKit SDK exposes `livekit::AudioProcessingModule` but does not expose a public VAD API in `include/livekit`. Pulling WebRTC VAD directly would require vendoring source or adding another dependency.

## Current Problems

- `apps/desktop/native/native-voice-win/src/voice_gate.cpp` is a fixed RMS threshold gate. It only checks frame RMS against `open_threshold_db`/`close_threshold_db`, then applies a linear gain ramp.
- `apps/desktop/native/native-voice-win/src/audio_processing.cpp` hardcodes fixed gate parameters:

```cpp
gate_config.open_threshold_db = config.voice_gate_threshold_db;
gate_config.close_threshold_db = config.voice_gate_threshold_db - 6.0f;
gate_config.attack_ms = 8;
gate_config.hold_ms = 180;
gate_config.release_ms = 140;
gate_config.floor_gain = 0.0f;
```

- `voiceGateAutoThreshold` exists in TypeScript contracts, but C++ does not parse/store it:
  - `apps/desktop/native/native-voice-win/src/protocol.hpp` has no `voice_gate_auto_threshold`.
  - `apps/desktop/native/native-voice-win/src/runtime_config.hpp` has no `voice_gate_auto_threshold`.
- Native publish/preview explicitly force auto threshold off:

```ts
voiceGateAutoThreshold: false,
```

in `apps/web/src/features/voice/native-microphone-publish.ts` and `apps/web/src/features/voice/voice-mic-preview.ts`.

This means Windows native publish/preview cannot actually run the web-style auto gate, and the meter/runtime path can disagree with the published audio.

## Approaches

### Approach A: Adaptive Noise Gate Without New Dependency

Implement a proper adaptive gate in `voice_gate.cpp`:

- smoothed RMS/envelope per 10 ms frame;
- quiet-frame history and percentile noise-floor estimator;
- auto threshold = noise floor + margin, with clamp and slow upward movement;
- open/close hysteresis;
- speech hangover after voice is detected;
- soft floor gain around `-18 dB` to `-24 dB` instead of hard zero;
- short lookahead/pre-roll, ideally 20 ms, only in auto mode to avoid chopping first syllables.

Pros: small, maintainable, low-risk, works with existing native helper.  
Cons: still energy-based; keyboard clicks near speech level can open the gate.

### Approach B: Vendor WebRTC VAD And Use It As A Speech Decision

Add WebRTC VAD C sources under native helper and combine `WebRtcVad_Process()` with the adaptive gate:

- VAD mode 1 or 2 for voice chat;
- VAD opens gate even when energy threshold is uncertain;
- energy gate remains as a fallback and for metrics;
- same hangover/lookahead/soft attenuation envelope.

Pros: closer to proven voice-call behavior than RMS-only; still lightweight.  
Cons: more vendored C code/licensing surface; not currently exposed by LiveKit SDK, so this is not a one-line API use.

### Approach C: Add ML VAD/NS Dependency

Use RNNoise/Silero-like model to detect speech probability.

Pros: best potential accuracy in difficult noise.  
Cons: much larger dependency/runtime surface, overlaps existing WebRTC noise suppression, and is too much for this issue.

## Recommendation

Implement Approach A first. It directly fixes the current Windows native bug class without introducing a new dependency. Keep the design open for Approach B by naming the detector layer clearly, but do not vendor WebRTC VAD until manual QA proves the adaptive gate is still insufficient.

The user-facing behavior should be:

- Manual mode: threshold slider is respected exactly.
- Auto mode: helper estimates a threshold from quiet/noise frames and emits the effective threshold in metrics.
- Gate off: processor still emits metrics but leaves samples at unity gate gain.
- Preview and publish use the same C++ gate decisions.

## File Structure

Modify:

- `apps/desktop/native/native-voice-win/src/protocol.hpp` - add `voice_gate_auto_threshold`.
- `apps/desktop/native/native-voice-win/src/protocol.cpp` - parse `voiceGateAutoThreshold`.
- `apps/desktop/native/native-voice-win/src/runtime_config.hpp` - store `voice_gate_auto_threshold`.
- `apps/desktop/native/native-voice-win/src/runtime_config.cpp` - update runtime config from start/configure commands.
- `apps/desktop/native/native-voice-win/src/voice_gate.hpp` - add adaptive config, metrics, and internal state.
- `apps/desktop/native/native-voice-win/src/voice_gate.cpp` - implement adaptive gate.
- `apps/desktop/native/native-voice-win/src/audio_processing.cpp` - pass auto/manual gate mode and emit effective threshold.
- `apps/desktop/native/native-voice-win/src/microphone_audio_processor.cpp` - keep processing order stable and pass back gate metrics.
- `apps/desktop/native/native-voice-win/tests/voice_gate_processor_test.cpp` - replace/expand tests for adaptive behavior.
- `apps/desktop/src/main/native-media-engine.test.ts` - assert IPC keeps `voiceGateAutoThreshold`.
- `apps/web/src/features/voice/native-microphone-publish.ts` - stop forcing native auto off.
- `apps/web/src/features/voice/native-microphone-publish.test.ts` - assert native publish passes the preference.
- `apps/web/src/features/voice/voice-mic-preview.ts` - stop forcing native auto off.
- `apps/web/src/features/voice/voice-mic-preview.test.ts` - assert native preview passes the preference.
- `apps/web/src/features/voice/use-voice-gate-meter.ts` - keep meter/runtime behavior aligned with publish/preview.

Create only if the `voice_gate.cpp` file becomes too broad:

- `apps/desktop/native/native-voice-win/src/voice_gate_level.hpp`
- `apps/desktop/native/native-voice-win/src/voice_gate_level.cpp`

Do not split unless it actually reduces complexity.

## Task 1: Contract Tests For Native Auto Flag

- [ ] Add C++ protocol tests if the helper already has protocol test target; otherwise add checks through existing C++ test binary.
- [ ] Assert `parseStartCommand()` reads `voiceGateAutoThreshold: true`.
- [ ] Assert `updateRuntimeConfig()` stores `voice_gate_auto_threshold`.
- [ ] Update Electron/native media tests so start/configure preserve `voiceGateAutoThreshold`.
- [ ] Update web publish/preview tests so Windows native paths pass `prefs.voiceGateAutoThreshold`, not `false`.

Expected failure before implementation: tests show C++ ignores the auto flag and TS native paths force it off.

## Task 2: Add Adaptive Gate Config And Metrics

- [ ] Extend `VoiceGateConfig`:

```cpp
bool auto_threshold = true;
float manual_threshold_db = -28.0f;
float auto_margin_db = 8.0f;
float hysteresis_db = 6.0f;
int attack_ms = 4;
int hold_ms = 240;
int release_ms = 120;
float floor_gain = 0.125f; // about -24 dB, not hard mute
```

- [ ] Extend `VoiceGateFrameMetrics`:

```cpp
float input_db = -60.0f;
float noise_floor_db = -60.0f;
float threshold_db = -28.0f;
float gain = 1.0f;
bool open = true;
bool auto_threshold = false;
```

- [ ] Clamp thresholds to `[-60 dB, 0 dB]`.
- [ ] Keep manual mode deterministic: effective threshold equals the manual threshold.

## Task 3: Implement Adaptive Noise-Floor Estimator

- [ ] Maintain a bounded ring/history of quiet frame levels, around 1.5-2 seconds.
- [ ] Add frames to quiet history only when the gate is closed or confidently below close threshold.
- [ ] Estimate noise floor from a low percentile of quiet history, not the mean.
- [ ] Update `noise_floor_db` slowly upward and faster downward, so a sudden keyboard hit does not raise the gate.
- [ ] Compute auto threshold as:

```text
effective_threshold_db = clamp(noise_floor_db + auto_margin_db, -50 dB, -18 dB)
close_threshold_db = effective_threshold_db - hysteresis_db
```

- [ ] Reset history when device/session starts or auto mode toggles.

## Task 4: Implement Gate State Machine

- [ ] Keep 10 ms frame processing.
- [ ] Open immediately when level crosses open threshold.
- [ ] Close only after `hold_ms` below close threshold.
- [ ] Keep hangover for short pauses between words.
- [ ] Apply exponential/one-pole smoothing for gain instead of per-sample linear stepping.
- [ ] Use soft closed range (`floor_gain`) rather than full zero by default.
- [ ] Add 20 ms lookahead/pre-roll only when `voiceGateAutoThreshold` is enabled. Manual mode must not add this latency.

Recommended default:

```text
attack_ms = 4
hold_ms = 240
release_ms = 120
floor_gain = 0.125
lookahead_ms = 20
auto_margin_db = 8
hysteresis_db = 6
```

## Task 5: Align Native Publish, Preview, And Meter

- [ ] Stop forcing `voiceGateAutoThreshold: false` in native publish.
- [ ] Stop forcing `voiceGateAutoThreshold: false` in native preview.
- [ ] Parse/store the auto flag in C++ runtime config.
- [ ] Emit the effective threshold in `microphone_metrics.threshold_db`.
- [ ] Emit `voice_gate_auto_threshold`, `voice_gate_noise_floor_db`, and effective `voice_gate_threshold_db` in diagnostics.
- [ ] Keep browser fallback behavior unchanged unless a separate task explicitly changes browser voice.

## Task 6: Tests

- [ ] C++: disabled gate leaves audio unchanged but still reports input/effective threshold metrics.
- [ ] C++: manual mode uses exact manual threshold and hysteresis.
- [ ] C++: auto mode raises threshold above steady room noise.
- [ ] C++: auto mode does not raise threshold after a short loud transient.
- [ ] C++: speech-like frames after quiet open quickly and do not hard-zero the first frame.
- [ ] C++: short pauses shorter than hold do not close the gate.
- [ ] C++: release is smooth and never clicks/hard-zeros one frame.
- [ ] C++: toggling auto/manual does not leave the gate stuck closed.
- [ ] TS: native publish/preview pass `voiceGateAutoThreshold` from preferences.
- [ ] TS: runtime configure includes `voiceGateAutoThreshold`.

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
ctest --test-dir apps\desktop\native\native-voice-win\build -C Release --output-on-failure
pnpm --filter @syrnike13/web exec vitest run --root ../.. apps/web/src/features/voice/native-microphone-publish.test.ts apps/web/src/features/voice/voice-mic-preview.test.ts apps/desktop/src/main/native-media-engine.test.ts packages/platform/src/media.test.ts
pnpm desktop:typecheck
```

## Task 7: Manual QA Matrix

Use the Windows desktop build and compare preview plus real voice publish:

1. Quiet room, normal speech:
   - first syllable is not chopped;
   - pauses between words do not close too aggressively;
   - metrics threshold stabilizes near room floor + margin.

2. Keyboard/fan noise:
   - auto gate stays closed on steady fan noise;
   - short keyboard clicks do not permanently raise the threshold;
   - speech still opens the gate without needing manual slider changes.

3. Low voice / far microphone:
   - auto gate does not become so aggressive that it eats quiet speech;
   - manual mode can still override threshold.

4. Loud background:
   - gate does not promise noise suppression while open;
   - noise suppression checkbox remains the feature for reducing noise during speech.

5. Runtime toggles:
   - auto/manual can be switched while preview/publish is running;
   - gate off leaves audio open immediately;
   - no stuck muted state after repeated toggles.

## Decision Needed Before Implementation

Resolved: 20 ms lookahead/pre-roll is acceptable only when automatic voice gate is enabled. Manual voice gate must not add this latency.

Also confirm whether vendoring WebRTC VAD is allowed if Approach A is still not good enough after QA. It is not needed for the first pass, but it is the clean next step if energy-based detection remains unreliable.
