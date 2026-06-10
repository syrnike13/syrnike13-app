# Windows Native Audio Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add separate, simple Windows native microphone toggles for noise suppression and echo cancellation, using the existing C++ media helper and removing AGC as a product feature.

**Architecture:** Use LiveKit SDK's `livekit::AudioProcessingModule`, which wraps WebRTC APM, as the native "Standard" processing path: noise suppression and high-pass filtering on microphone frames, plus AEC3 when a WASAPI render-loopback reference is available. Keep the UI simple with two independent checkboxes, but keep the native path explicit: no Krisp, no RNNoise/DeepFilter dependency, no automatic gain control. Share one microphone processing pipeline between publish and preview for noise suppression, volume, voice gate, and limiter; run AEC only in publish/call capture where the render reference is meaningful.

**Tech Stack:** TypeScript, React, Electron IPC, C++20, WASAPI, LiveKit Windows SDK, WebRTC Audio Processing Module through `livekit/audio_processing_module.h`, CMake, Vitest, CTest.

---

## Decisions

- Discord reference: Discord's own engineering post describes a C++ media engine built on WebRTC native library for desktop/mobile voice. Discord's Krisp support page documents Krisp as a separate noise suppression option. For this codebase, LiveKit/WebRTC APM is the correct "Standard-like" path; Krisp is intentionally out of scope.
- AGC policy: AGC is not a setting, not a diagnostic status, and not enabled in native processing. Native APM options must always set `auto_gain_control = false`. Browser `autoGainControl: false` stays only as a defensive constraint to prevent browser-side gain processing.
- Separate toggles: UI and runtime config expose `noiseSuppression` and `echoCancellation` independently. The checkboxes are separate and can be changed while a session is running.
- Defaults: both `noiseSuppression` and `echoCancellation` default to `true`, matching the current voice-quality intent and the existing default `echoCancellation: true`.
- Preview behavior: preview applies noise suppression through the same processor, but AEC is reported as unavailable in monitor preview because preview audio is rendered to the same output device that a loopback reference would capture. Running AEC there can cancel the user's monitored voice and hide real call behavior. AEC is validated through publish/call capture and diagnostics.
- No compatibility migration: do not add legacy preference aliases. Keep the existing `echoCancellation` preference name because it remains semantically correct, add `noiseSuppression`, and do not parse alternate old names.

## Source Notes

- Discord WebRTC media engine: https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc
- Discord Krisp FAQ: https://support.discord.com/hc/en-us/articles/360040843952-Krisp-FAQ
- Local LiveKit APM header: `apps/desktop/native/native-voice-win/build/_deps/livekit-sdk/livekit-sdk-windows-x64-1.0.0/include/livekit/audio_processing_module.h`
- Current native mic path: `apps/desktop/native/native-voice-win/src/microphone_publisher.cpp`
- Current preview path: `apps/desktop/native/native-voice-win/src/microphone_preview.cpp`
- Current stale docs mention DeepFilterNet3: `docs/native-media-engine.md`

## File Structure

Create:

- `apps/desktop/native/native-voice-win/src/microphone_audio_processor.hpp` - owns the per-10 ms microphone processing pipeline and exposes statuses/metrics.
- `apps/desktop/native/native-voice-win/src/microphone_audio_processor.cpp` - converts float PCM to `livekit::AudioFrame`, runs APM, volume, voice gate, limiter, and PCM16 conversion.
- `apps/desktop/native/native-voice-win/src/microphone_echo_reference.hpp` - bounded 10 ms render-reference frame buffer and capture API.
- `apps/desktop/native/native-voice-win/src/microphone_echo_reference.cpp` - WASAPI default-render loopback capture, downmix, frame queue, status.
- `apps/desktop/native/native-voice-win/tests/microphone_audio_processor_test.cpp` - pure processing config/order tests, including AGC disabled invariant.
- `apps/desktop/native/native-voice-win/tests/microphone_echo_reference_test.cpp` - bounded queue and stereo-to-mono frame tests.

Modify:

- `packages/platform/src/media.ts`
- `packages/platform/src/media.test.ts`
- `apps/desktop/src/main/native-media-engine.ts`
- `apps/desktop/src/main/native-media-engine.test.ts`
- `apps/desktop/src/main/native-media-engine-sidecar.ts`
- `apps/desktop/src/main/native-media-engine-sidecar.test.ts`
- `apps/web/src/components/settings/settings-voice-panel.tsx`
- `apps/web/src/features/voice/voice-preference-store.ts`
- `apps/web/src/features/voice/voice-preference-store.test.ts`
- `apps/web/src/features/voice/voice-preference-effects.ts`
- `apps/web/src/features/voice/voice-preference-effects.test.ts`
- `apps/web/src/features/voice/native-microphone-publish.ts`
- `apps/web/src/features/voice/native-microphone-publish.test.ts`
- `apps/web/src/features/voice/native-microphone-runtime-config.ts`
- `apps/web/src/features/voice/voice-mic-preview.ts`
- `apps/web/src/features/voice/voice-mic-preview.test.ts`
- `apps/web/src/features/voice/use-mic-preview-loopback.ts`
- `apps/web/src/features/voice/use-voice-gate-meter.ts`
- `apps/web/src/features/voice/voice-capture.ts`
- `apps/web/src/features/voice/voice-capture.test.ts`
- `apps/desktop/native/native-voice-win/CMakeLists.txt`
- `apps/desktop/native/native-voice-win/src/protocol.hpp`
- `apps/desktop/native/native-voice-win/src/protocol.cpp`
- `apps/desktop/native/native-voice-win/src/runtime_config.hpp`
- `apps/desktop/native/native-voice-win/src/runtime_config.cpp`
- `apps/desktop/native/native-voice-win/src/audio_processing.hpp`
- `apps/desktop/native/native-voice-win/src/audio_processing.cpp`
- `apps/desktop/native/native-voice-win/src/microphone_publisher.cpp`
- `apps/desktop/native/native-voice-win/src/microphone_preview.cpp`
- `docs/native-media-engine.md`

## Task 1: Contract Tests For Separate Toggles

**Files:**

- Modify: `packages/platform/src/media.test.ts`
- Modify: `apps/desktop/src/main/native-media-engine.test.ts`
- Modify: `apps/desktop/src/main/native-media-engine-sidecar.test.ts`
- Modify: `apps/web/src/features/voice/native-microphone-publish.test.ts`
- Modify: `apps/web/src/features/voice/voice-mic-preview.test.ts`
- Modify: `apps/web/src/features/voice/voice-preference-store.test.ts`
- Modify: `apps/web/src/features/voice/voice-preference-effects.test.ts`
- Modify: `apps/web/src/features/voice/voice-capture.test.ts`

- [ ] **Step 1: Write failing tests for platform media types**

Add assertions that microphone start/config runtime shapes include both booleans and that statuses have explicit modes:

```ts
const microphoneStart = {
  kind: 'microphone',
  sampleRate: 48_000,
  channels: 1,
  noiseSuppression: true,
  echoCancellation: false,
  inputVolume: 1,
  livekit: {
    url: 'wss://example.test',
    token: 'token',
    participantIdentity: 'native-user',
  },
} satisfies NativeMediaMicrophoneSessionStartOptions

const runtimeConfig = {
  noiseSuppression: false,
  echoCancellation: true,
} satisfies NativeMicrophoneRuntimeConfig

const noiseStatus: NativeMediaNoiseSuppressionMode = 'software'
const echoStatus: NativeMediaEchoCancellationMode = 'unavailable'

expect(microphoneStart.noiseSuppression).toBe(true)
expect(runtimeConfig.echoCancellation).toBe(true)
expect(noiseStatus).toBe('software')
expect(echoStatus).toBe('unavailable')
```

- [ ] **Step 2: Write failing Electron IPC tests**

In `apps/desktop/src/main/native-media-engine.test.ts`, update the microphone start command expectation:

```ts
expect(writeJson).toHaveBeenCalledWith(
  expect.objectContaining({
    cmd: 'start',
    sessionKind: 'microphone',
    noiseSuppression: true,
    echoCancellation: false,
    inputVolume: 1.25,
    voiceGateEnabled: true,
  }),
)
```

Add a runtime configure expectation:

```ts
expect(writeJson).toHaveBeenCalledWith(
  expect.objectContaining({
    cmd: 'configure',
    sessionId,
    noiseSuppression: false,
    echoCancellation: true,
    inputVolume: 0.8,
  }),
)
```

- [ ] **Step 3: Write failing sidecar status tests**

In `apps/desktop/src/main/native-media-engine-sidecar.test.ts`, assert both status fields are mapped:

```ts
const event = mapNativeMediaEvent({
  type: 'session_lifecycle',
  session_id: 'mic-1',
  kind: 'microphone',
  status: 'running',
  audio_mode: 'microphone',
  audio_sample_rate: 48000,
  audio_channels: 1,
  noise_suppression: 'software',
  echo_cancellation: 'unavailable',
})

expect(event.audio?.noiseSuppression).toBe('software')
expect(event.audio?.echoCancellation).toBe('unavailable')
```

- [ ] **Step 4: Write failing web preference tests**

In `voice-preference-store.test.ts`, assert defaults and setters:

```ts
expect(voicePreferenceStore.getState()).toEqual(
  expect.objectContaining({
    noiseSuppression: true,
    echoCancellation: true,
  }),
)

voicePreferenceStore.setNoiseSuppression(false)
voicePreferenceStore.setEchoCancellation(false)

expect(voicePreferenceStore.getState().noiseSuppression).toBe(false)
expect(voicePreferenceStore.getState().echoCancellation).toBe(false)
```

In `voice-preference-effects.test.ts`, assert either toggle change triggers native runtime configuration:

```ts
expect(shouldReconfigureMicrophone(
  { noiseSuppression: true, echoCancellation: true },
  { noiseSuppression: false, echoCancellation: true },
)).toBe(true)

expect(shouldReconfigureMicrophone(
  { noiseSuppression: true, echoCancellation: true },
  { noiseSuppression: true, echoCancellation: false },
)).toBe(true)
```

- [ ] **Step 5: Write failing publish and preview tests**

Update `native-microphone-publish.test.ts` and `voice-mic-preview.test.ts` expected options:

```ts
expect(desktop.media.startSession).toHaveBeenCalledWith(
  expect.objectContaining({
    kind: 'microphone',
    noiseSuppression: true,
    echoCancellation: false,
    inputVolume: 1,
  }),
)

expect(desktop.media.configureMicrophone).toHaveBeenCalledWith(
  sessionId,
  expect.objectContaining({
    noiseSuppression: false,
    echoCancellation: true,
  }),
)
```

- [ ] **Step 6: Tighten browser AGC test wording**

Rename the browser constraint test to avoid treating AGC as a feature:

```ts
it('keeps browser-side voice processing disabled for web capture', () => {
  expect(options.audioCaptureDefaults?.noiseSuppression).toBe(false)
  expect(options.audioCaptureDefaults?.autoGainControl).toBe(false)
})
```

- [ ] **Step 7: Run tests and confirm failure**

Run:

```powershell
pnpm --filter @syrnike13/web exec vitest run --root ../.. packages/platform/src/media.test.ts apps/desktop/src/main/native-media-engine.test.ts apps/desktop/src/main/native-media-engine-sidecar.test.ts apps/web/src/features/voice/native-microphone-publish.test.ts apps/web/src/features/voice/voice-mic-preview.test.ts apps/web/src/features/voice/voice-preference-store.test.ts apps/web/src/features/voice/voice-preference-effects.test.ts apps/web/src/features/voice/voice-capture.test.ts
```

Expected: tests fail because `noiseSuppression` types, fields, and mappings do not exist yet.

## Task 2: TypeScript Contract And UI Implementation

**Files:**

- Modify: `packages/platform/src/media.ts`
- Modify: `apps/desktop/src/main/native-media-engine.ts`
- Modify: `apps/desktop/src/main/native-media-engine-sidecar.ts`
- Modify: `apps/web/src/components/settings/settings-voice-panel.tsx`
- Modify: `apps/web/src/features/voice/voice-preference-store.ts`
- Modify: `apps/web/src/features/voice/voice-preference-effects.ts`
- Modify: `apps/web/src/features/voice/native-microphone-publish.ts`
- Modify: `apps/web/src/features/voice/native-microphone-runtime-config.ts`
- Modify: `apps/web/src/features/voice/voice-mic-preview.ts`
- Modify: `apps/web/src/features/voice/use-mic-preview-loopback.ts`
- Modify: `apps/web/src/features/voice/use-voice-gate-meter.ts`
- Modify: `apps/web/src/features/voice/voice-capture.ts`

- [ ] **Step 1: Add platform status and option fields**

Update `packages/platform/src/media.ts`:

```ts
export type NativeMediaNoiseSuppressionMode =
  | 'disabled'
  | 'software'
  | 'unavailable'

export type NativeMediaEchoCancellationMode =
  | 'disabled'
  | 'software'
  | 'unavailable'

export type NativeMediaMicrophoneSessionStartOptions = {
  kind: 'microphone'
  deviceId?: string
  sampleRate: 48_000
  channels: 1
  noiseSuppression: boolean
  echoCancellation: boolean
  inputVolume: number
  audioBitrate?: number
  voiceGateEnabled?: boolean
  voiceGateThresholdDb?: number
  voiceGateAutoThreshold?: boolean
  muted?: boolean
  livekit: NativeMediaLiveKitCredentials
}

export type NativeMicrophoneRuntimeConfig = {
  inputVolume?: number
  voiceGateEnabled?: boolean
  voiceGateThresholdDb?: number
  voiceGateAutoThreshold?: boolean
  noiseSuppression?: boolean
  echoCancellation?: boolean
}
```

Add `noiseSuppression?: NativeMediaNoiseSuppressionMode` anywhere microphone audio metadata is exposed.

- [ ] **Step 2: Pass both toggles through Electron commands**

Update microphone start and configure command builders in `apps/desktop/src/main/native-media-engine.ts`:

```ts
{
  cmd: 'start',
  sessionKind: 'microphone',
  deviceId: options.deviceId,
  noiseSuppression: options.noiseSuppression,
  echoCancellation: options.echoCancellation,
  inputVolume: options.inputVolume,
  voiceGateEnabled: options.voiceGateEnabled ?? true,
  voiceGateThresholdDb: options.voiceGateThresholdDb,
  muted: options.muted ?? false,
}
```

For runtime config:

```ts
{
  cmd: 'configure',
  sessionId,
  noiseSuppression: config.noiseSuppression,
  echoCancellation: config.echoCancellation,
  inputVolume: config.inputVolume,
  voiceGateEnabled: config.voiceGateEnabled,
  voiceGateThresholdDb: config.voiceGateThresholdDb,
}
```

- [ ] **Step 3: Map sidecar statuses**

Update `apps/desktop/src/main/native-media-engine-sidecar.ts`:

```ts
export function mapNoiseSuppressionMode(
  value: unknown,
): NativeMediaNoiseSuppressionMode | undefined {
  if (value === 'disabled' || value === 'software' || value === 'unavailable') {
    return value
  }
  return undefined
}

export function mapEchoCancellationMode(
  value: unknown,
): NativeMediaEchoCancellationMode | undefined {
  if (value === 'disabled' || value === 'software' || value === 'unavailable') {
    return value
  }
  return undefined
}
```

Map `event.noise_suppression` to `audio.noiseSuppression` and `event.echo_cancellation` to `audio.echoCancellation`.

- [ ] **Step 4: Add preference state and setters**

Update `apps/web/src/features/voice/voice-preference-store.ts`:

```ts
export type VoicePreferenceState = {
  micEnabled: boolean
  deafened: boolean
  preferredAudioInputDevice?: string
  preferredAudioOutputDevice?: string
  preferredVideoDevice?: string
  inputVolume: number
  outputVolume: number
  noiseSuppression: boolean
  echoCancellation: boolean
  voiceGateEnabled: boolean
  voiceGateThresholdDb: number
  voiceGateAutoThreshold: boolean
  screenShareQuality: ScreenShareQualityName
  screenShareCodec: ScreenShareCodec
  screenShareAudio: boolean
  screenShareCaptureMode: ScreenShareCaptureMode
}

const DEFAULT_STATE: VoicePreferenceState = {
  micEnabled: true,
  deafened: false,
  inputVolume: 1,
  outputVolume: 1,
  noiseSuppression: true,
  echoCancellation: true,
  voiceGateEnabled: true,
  voiceGateThresholdDb: DEFAULT_VOICE_GATE_THRESHOLD_DB,
  voiceGateAutoThreshold: true,
  screenShareQuality: defaultScreenShareQuality(),
  screenShareCodec: 'auto',
  screenShareAudio: true,
  screenShareCaptureMode: 'auto',
}
```

Parse the new field only by exact name:

```ts
noiseSuppression:
  typeof parsed.noiseSuppression === 'boolean'
    ? parsed.noiseSuppression
    : DEFAULT_STATE.noiseSuppression,
echoCancellation:
  typeof parsed.echoCancellation === 'boolean'
    ? parsed.echoCancellation
    : DEFAULT_STATE.echoCancellation,
```

Add store methods:

```ts
setNoiseSuppression: (noiseSuppression: boolean) => {
  if (state.noiseSuppression === noiseSuppression) return
  patch({ noiseSuppression })
},
setEchoCancellation: (echoCancellation: boolean) => {
  if (state.echoCancellation === echoCancellation) return
  patch({ echoCancellation })
},
```

- [ ] **Step 5: Render two independent settings checkboxes**

In `apps/web/src/components/settings/settings-voice-panel.tsx`, replace the single processing checkbox with two rows:

```tsx
<label className="flex items-center justify-between gap-3">
  <span>Шумоподавление</span>
  <input
    type="checkbox"
    checked={prefs.noiseSuppression}
    onChange={(event) =>
      voicePreferenceStore.setNoiseSuppression(event.target.checked)
    }
  />
</label>

<label className="flex items-center justify-between gap-3">
  <span>Эхоподавление</span>
  <input
    type="checkbox"
    checked={prefs.echoCancellation}
    onChange={(event) =>
      voicePreferenceStore.setEchoCancellation(event.target.checked)
    }
  />
</label>
```

Keep existing component styling conventions; do not introduce a new settings abstraction.

- [ ] **Step 6: Pass preferences to native publish, preview, meter, and runtime config**

Update `native-microphone-publish.ts`:

```ts
return {
  kind: 'microphone' as const,
  deviceId,
  sampleRate: 48_000 as const,
  channels: 1 as const,
  audioBitrate: clampVoiceChannelAudioBitrateKbps(audioBitrateKbps) * 1000,
  noiseSuppression: prefs.noiseSuppression,
  echoCancellation: prefs.echoCancellation,
  inputVolume: prefs.inputVolume,
  voiceGateEnabled: prefs.voiceGateEnabled,
  voiceGateThresholdDb: prefs.voiceGateThresholdDb,
  voiceGateAutoThreshold: false,
  muted,
  livekit,
}
```

Update runtime config calls:

```ts
configureNativeMicrophoneRuntime(session?.sessionId, {
  noiseSuppression: prefs.noiseSuppression,
  echoCancellation: prefs.echoCancellation,
  inputVolume: prefs.inputVolume,
  voiceGateEnabled: prefs.voiceGateEnabled,
  voiceGateThresholdDb: prefs.voiceGateThresholdDb,
  voiceGateAutoThreshold: false,
})
```

Update preview and gate-meter option comparisons so either `noiseSuppression` or `echoCancellation` changes restarts/configures the native preview path.

- [ ] **Step 7: Keep browser capture processing disabled**

In `voice-capture.ts`, keep browser constraints disabled:

```ts
audio: {
  deviceId,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}
```

Do not wire `prefs.noiseSuppression` into browser `getUserMedia`; native processing is the Windows quality path, and browser processing would double-process audio.

- [ ] **Step 8: Run TypeScript contract tests**

Run:

```powershell
pnpm --filter @syrnike13/web exec vitest run --root ../.. packages/platform/src/media.test.ts apps/desktop/src/main/native-media-engine.test.ts apps/desktop/src/main/native-media-engine-sidecar.test.ts apps/web/src/features/voice/native-microphone-publish.test.ts apps/web/src/features/voice/voice-mic-preview.test.ts apps/web/src/features/voice/voice-preference-store.test.ts apps/web/src/features/voice/voice-preference-effects.test.ts apps/web/src/features/voice/voice-capture.test.ts
```

Expected: TypeScript-side tests pass; native C++ tests still do not cover the new processing.

## Task 3: Native Protocol, Runtime Config, And Diagnostics Tests

**Files:**

- Modify: `apps/desktop/native/native-voice-win/src/protocol.hpp`
- Modify: `apps/desktop/native/native-voice-win/src/protocol.cpp`
- Modify: `apps/desktop/native/native-voice-win/src/runtime_config.hpp`
- Modify: `apps/desktop/native/native-voice-win/src/runtime_config.cpp`
- Modify: `apps/desktop/native/native-voice-win/src/audio_processing.hpp`
- Modify: `apps/desktop/native/native-voice-win/src/audio_processing.cpp`

- [ ] **Step 1: Add native command fields**

Update `StartCommand`:

```cpp
struct StartCommand {
  // existing fields
  bool noise_suppression = true;
  bool echo_cancellation = true;
  float input_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
  bool muted = false;
};
```

Update `parseStartCommand`:

```cpp
command.noise_suppression = boolField(json, "noiseSuppression", true);
command.echo_cancellation = boolField(json, "echoCancellation", true);
```

- [ ] **Step 2: Add runtime config fields**

Update `RuntimeConfig`:

```cpp
struct RuntimeConfig {
  float input_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
  bool noise_suppression_enabled = true;
  bool echo_cancellation_enabled = true;
};
```

Update `updateRuntimeConfig` to write both new fields:

```cpp
runtime_config.noise_suppression_enabled = command.noise_suppression;
runtime_config.echo_cancellation_enabled = command.echo_cancellation;
```

- [ ] **Step 3: Add explicit status helpers**

In `audio_processing.hpp`:

```cpp
struct MicrophoneProcessingStatus {
  std::string noise_suppression;
  std::string echo_cancellation;
};
```

Extend diagnostics:

```cpp
void emitMicrophoneDiagnostics(
  const std::string& session_id,
  const std::string& mode,
  std::uint64_t frames,
  std::uint32_t interval_frames,
  float input_db,
  float output_peak,
  std::uint32_t clipped_samples,
  std::uint32_t gated_frames,
  std::uint32_t max_frame_gap_ms,
  std::uint32_t max_capture_frame_us,
  const RuntimeConfig& config,
  const MicrophoneProcessingStatus& processing_status
);
```

Include status JSON:

```cpp
",\"noise_suppression\":\"" + jsonEscape(processing_status.noise_suppression) + "\"" +
",\"echo_cancellation\":\"" + jsonEscape(processing_status.echo_cancellation) + "\""
```

- [ ] **Step 4: Build native helper and confirm current callers fail**

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
```

Expected: compile fails because `emitMicrophoneDiagnostics` callers still pass the old argument list.

## Task 4: Native Microphone Audio Processor Tests

**Files:**

- Create: `apps/desktop/native/native-voice-win/src/microphone_audio_processor.hpp`
- Create: `apps/desktop/native/native-voice-win/src/microphone_audio_processor.cpp`
- Create: `apps/desktop/native/native-voice-win/tests/microphone_audio_processor_test.cpp`
- Modify: `apps/desktop/native/native-voice-win/CMakeLists.txt`

- [ ] **Step 1: Add processor header signatures**

Create `microphone_audio_processor.hpp`:

```cpp
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "runtime_config.hpp"
#include "voice_gate.hpp"

namespace livekit {
class AudioProcessingModule;
}

namespace syrnike::voice {

struct MicrophoneAudioProcessingOptions {
  bool noise_suppression = false;
  bool echo_cancellation = false;
  bool high_pass_filter = false;
  bool auto_gain_control = false;
};

struct MicrophoneAudioProcessorStatus {
  std::string noise_suppression = "disabled";
  std::string echo_cancellation = "disabled";
};

struct MicrophoneAudioProcessorFrame {
  std::vector<std::int16_t> pcm;
  VoiceGateFrameMetrics gate_metrics;
  std::uint32_t clipped_samples = 0;
  float output_peak = 0.0f;
  MicrophoneAudioProcessorStatus status;
};

MicrophoneAudioProcessingOptions microphoneApmOptions(
  const RuntimeConfig& config,
  bool echo_reference_available
);

class MicrophoneAudioProcessor {
public:
  MicrophoneAudioProcessor();

  MicrophoneAudioProcessorFrame processFrame(
    const std::vector<float>& raw_frame,
    const RuntimeConfig& config,
    const std::vector<std::int16_t>* echo_reference_frame
  );

private:
  void ensureApm(const MicrophoneAudioProcessingOptions& options);

  VoiceGateProcessor gate_;
  MicrophoneAudioProcessingOptions active_options_{};
  std::unique_ptr<livekit::AudioProcessingModule> apm_;
};

}  // namespace syrnike::voice
```

- [ ] **Step 2: Write pure option tests**

Create `microphone_audio_processor_test.cpp`:

```cpp
#include "microphone_audio_processor.hpp"

#include <cassert>

using syrnike::voice::RuntimeConfig;
using syrnike::voice::microphoneApmOptions;

int main() {
  RuntimeConfig config;
  config.noise_suppression_enabled = true;
  config.echo_cancellation_enabled = true;

  const auto enabled = microphoneApmOptions(config, true);
  assert(enabled.noise_suppression);
  assert(enabled.echo_cancellation);
  assert(enabled.high_pass_filter);
  assert(!enabled.auto_gain_control);

  const auto no_reference = microphoneApmOptions(config, false);
  assert(no_reference.noise_suppression);
  assert(!no_reference.echo_cancellation);
  assert(no_reference.high_pass_filter);
  assert(!no_reference.auto_gain_control);

  config.noise_suppression_enabled = false;
  config.echo_cancellation_enabled = false;
  const auto disabled = microphoneApmOptions(config, true);
  assert(!disabled.noise_suppression);
  assert(!disabled.echo_cancellation);
  assert(!disabled.high_pass_filter);
  assert(!disabled.auto_gain_control);

  return 0;
}
```

- [ ] **Step 3: Add CMake target wiring for the new test**

Modify the test executable in `CMakeLists.txt`:

```cmake
add_executable(syrnike-native-voice-win-tests
  tests/voice_gate_processor_test.cpp
  tests/microphone_audio_processor_test.cpp
  src/audio_processing.cpp
  src/microphone_audio_processor.cpp
  src/protocol.cpp
  src/runtime_config.cpp
  src/voice_gate.cpp
)

target_link_libraries(syrnike-native-voice-win-tests PRIVATE
  LiveKit::livekit
)
```

If the existing single `main()` test style prevents multiple test files in one executable, split into two CTest executables:

```cmake
add_executable(syrnike-native-microphone-audio-processor-tests
  tests/microphone_audio_processor_test.cpp
  src/audio_processing.cpp
  src/microphone_audio_processor.cpp
  src/protocol.cpp
  src/runtime_config.cpp
  src/voice_gate.cpp
)
target_include_directories(syrnike-native-microphone-audio-processor-tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)
target_link_libraries(syrnike-native-microphone-audio-processor-tests PRIVATE
  LiveKit::livekit
)
add_test(
  NAME syrnike-native-microphone-audio-processor-tests
  COMMAND syrnike-native-microphone-audio-processor-tests
)
```

- [ ] **Step 4: Run CTest and confirm option tests fail before implementation**

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
ctest --test-dir apps\desktop\native\native-voice-win\build -C Release --output-on-failure
```

Expected: build or test fails until `microphoneApmOptions` and processor implementation exist.

## Task 5: Native Echo Reference Buffer Tests

**Files:**

- Create: `apps/desktop/native/native-voice-win/src/microphone_echo_reference.hpp`
- Create: `apps/desktop/native/native-voice-win/src/microphone_echo_reference.cpp`
- Create: `apps/desktop/native/native-voice-win/tests/microphone_echo_reference_test.cpp`
- Modify: `apps/desktop/native/native-voice-win/CMakeLists.txt`

- [ ] **Step 1: Define a small bounded frame buffer**

Create `microphone_echo_reference.hpp`:

```cpp
#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace syrnike::voice {

struct MicrophoneEchoReferenceStatus {
  bool available = false;
  std::string reason;
};

class MicrophoneEchoReferenceBuffer {
public:
  explicit MicrophoneEchoReferenceBuffer(std::size_t max_frames);

  void pushInterleavedFloatStereo(const float* samples, std::size_t frames, bool silent);
  std::optional<std::vector<std::int16_t>> popFrame();
  std::size_t queuedFrames() const;

private:
  std::size_t max_frames_;
  std::vector<float> pending_mono_;
  std::vector<std::vector<std::int16_t>> frames_;
  mutable std::mutex mutex_;
};

class MicrophoneEchoReference {
public:
  MicrophoneEchoReference();
  ~MicrophoneEchoReference();

  void start();
  void stop();
  std::optional<std::vector<std::int16_t>> popFrame();
  MicrophoneEchoReferenceStatus status() const;

private:
  void captureLoop();

  std::atomic_bool running_{false};
  std::thread thread_;
  MicrophoneEchoReferenceBuffer buffer_;
  mutable std::mutex status_mutex_;
  MicrophoneEchoReferenceStatus status_;
};

}  // namespace syrnike::voice
```

- [ ] **Step 2: Write buffer tests**

Create `microphone_echo_reference_test.cpp`:

```cpp
#include "microphone_echo_reference.hpp"
#include "audio_constants.hpp"

#include <cassert>
#include <vector>

using syrnike::voice::MicrophoneEchoReferenceBuffer;

int main() {
  MicrophoneEchoReferenceBuffer buffer(2);

  std::vector<float> stereo(static_cast<std::size_t>(syrnike::voice::kSamplesPer10Ms) * 2);
  for (std::size_t frame = 0; frame < syrnike::voice::kSamplesPer10Ms; ++frame) {
    stereo[frame * 2] = 0.5f;
    stereo[frame * 2 + 1] = -0.25f;
  }

  buffer.pushInterleavedFloatStereo(stereo.data(), syrnike::voice::kSamplesPer10Ms, false);
  const auto mono = buffer.popFrame();
  assert(mono.has_value());
  assert(mono->size() == syrnike::voice::kSamplesPer10Ms);
  assert((*mono)[0] > 3000);
  assert((*mono)[0] < 5000);

  buffer.pushInterleavedFloatStereo(stereo.data(), syrnike::voice::kSamplesPer10Ms, false);
  buffer.pushInterleavedFloatStereo(stereo.data(), syrnike::voice::kSamplesPer10Ms, false);
  buffer.pushInterleavedFloatStereo(stereo.data(), syrnike::voice::kSamplesPer10Ms, false);
  assert(buffer.queuedFrames() == 2);

  buffer.pushInterleavedFloatStereo(stereo.data(), syrnike::voice::kSamplesPer10Ms, true);
  const auto silent = buffer.popFrame();
  assert(silent.has_value());

  return 0;
}
```

- [ ] **Step 3: Add CMake test target**

Add:

```cmake
add_executable(syrnike-native-microphone-echo-reference-tests
  tests/microphone_echo_reference_test.cpp
  src/audio_processing.cpp
  src/microphone_echo_reference.cpp
  src/protocol.cpp
)
target_include_directories(syrnike-native-microphone-echo-reference-tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)
target_link_libraries(syrnike-native-microphone-echo-reference-tests PRIVATE
  Mmdevapi
  avrt
  ole32
)
add_test(
  NAME syrnike-native-microphone-echo-reference-tests
  COMMAND syrnike-native-microphone-echo-reference-tests
)
```

- [ ] **Step 4: Run and confirm failures**

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
ctest --test-dir apps\desktop\native\native-voice-win\build -C Release --output-on-failure
```

Expected: tests fail until the buffer implementation exists.

## Task 6: Implement Echo Reference Capture

**Files:**

- Modify: `apps/desktop/native/native-voice-win/src/microphone_echo_reference.cpp`
- Modify: `apps/desktop/native/native-voice-win/CMakeLists.txt`

- [ ] **Step 1: Implement bounded buffer conversion**

In `microphone_echo_reference.cpp`:

```cpp
namespace {
std::int16_t floatToPcm16(float value) {
  const float clamped = std::clamp(value, -1.0f, 1.0f);
  return static_cast<std::int16_t>(clamped * 32767.0f);
}
}

void MicrophoneEchoReferenceBuffer::pushInterleavedFloatStereo(
  const float* samples,
  std::size_t frames,
  bool silent
) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (std::size_t index = 0; index < frames; ++index) {
    const float mono = silent ? 0.0f : (samples[index * 2] + samples[index * 2 + 1]) * 0.5f;
    pending_mono_.push_back(mono);
    if (pending_mono_.size() == kSamplesPer10Ms) {
      std::vector<std::int16_t> frame;
      frame.reserve(kSamplesPer10Ms);
      for (float sample : pending_mono_) frame.push_back(floatToPcm16(sample));
      frames_.push_back(std::move(frame));
      pending_mono_.clear();
      while (frames_.size() > max_frames_) frames_.erase(frames_.begin());
    }
  }
}
```

- [ ] **Step 2: Implement WASAPI loopback capture**

Use the existing screen audio pattern without process exclusion:

```cpp
ComPtr<IMMDevice> render_device = getRenderDevice();
ComPtr<IAudioClient> audio_client;
HRESULT hr = render_device->Activate(
  __uuidof(IAudioClient),
  CLSCTX_ALL,
  nullptr,
  reinterpret_cast<void**>(audio_client.GetAddressOf())
);
```

Initialize as 48 kHz stereo float:

```cpp
WAVEFORMATEX format{};
format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
format.nChannels = 2;
format.nSamplesPerSec = 48000;
format.wBitsPerSample = 32;
format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

hr = audio_client->Initialize(
  AUDCLNT_SHAREMODE_SHARED,
  AUDCLNT_STREAMFLAGS_LOOPBACK |
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
  kBufferDurationHns,
  0,
  &format,
  nullptr
);
```

Capture packets and push:

```cpp
const auto* samples = reinterpret_cast<const float*>(data);
buffer_.pushInterleavedFloatStereo(
  samples,
  frames,
  (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr
);
```

- [ ] **Step 3: Set status without stopping microphone capture**

If loopback activation or capture fails, update status and return from the reference thread:

```cpp
{
  std::lock_guard<std::mutex> lock(status_mutex_);
  status_.available = false;
  status_.reason = error.what();
}
```

When running:

```cpp
{
  std::lock_guard<std::mutex> lock(status_mutex_);
  status_.available = true;
  status_.reason.clear();
}
```

The microphone publisher must continue when reference capture is unavailable; only AEC status becomes `unavailable`.

- [ ] **Step 4: Run echo reference tests**

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
ctest --test-dir apps\desktop\native\native-voice-win\build -C Release --output-on-failure
```

Expected: echo reference buffer tests pass. On machines without a render device, unit tests still pass because they only exercise the buffer.

## Task 7: Implement Microphone Audio Processor

**Files:**

- Modify: `apps/desktop/native/native-voice-win/src/microphone_audio_processor.cpp`
- Modify: `apps/desktop/native/native-voice-win/src/microphone_audio_processor.hpp`

- [ ] **Step 1: Implement APM option selection**

In `microphone_audio_processor.cpp`:

```cpp
MicrophoneAudioProcessingOptions microphoneApmOptions(
  const RuntimeConfig& config,
  bool echo_reference_available
) {
  MicrophoneAudioProcessingOptions options;
  options.noise_suppression = config.noise_suppression_enabled;
  options.echo_cancellation =
    config.echo_cancellation_enabled && echo_reference_available;
  options.high_pass_filter =
    options.noise_suppression || options.echo_cancellation;
  options.auto_gain_control = false;
  return options;
}
```

- [ ] **Step 2: Recreate APM only when options change**

```cpp
void MicrophoneAudioProcessor::ensureApm(
  const MicrophoneAudioProcessingOptions& options
) {
  if (options == active_options_) return;
  active_options_ = options;

  if (!options.noise_suppression &&
      !options.echo_cancellation &&
      !options.high_pass_filter) {
    apm_.reset();
    return;
  }

  livekit::AudioProcessingModule::Options livekit_options;
  livekit_options.noise_suppression = options.noise_suppression;
  livekit_options.echo_cancellation = options.echo_cancellation;
  livekit_options.high_pass_filter = options.high_pass_filter;
  livekit_options.auto_gain_control = false;
  apm_ = std::make_unique<livekit::AudioProcessingModule>(livekit_options);
}
```

Define `operator==` for `MicrophoneAudioProcessingOptions` directly in the struct or compare fields inline.

- [ ] **Step 3: Process a 10 ms frame in the correct order**

Frame order:

1. Convert raw mic float samples to PCM16 for APM input.
2. If AEC is active and a reference frame is present, call `processReverseStream`.
3. Call `processStream`.
4. Convert processed PCM16 back to float.
5. Apply input volume.
6. Apply voice gate.
7. Apply soft limiter and output PCM16.

Core implementation shape:

```cpp
MicrophoneAudioProcessorFrame MicrophoneAudioProcessor::processFrame(
  const std::vector<float>& raw_frame,
  const RuntimeConfig& config,
  const std::vector<std::int16_t>* echo_reference_frame
) {
  const bool has_reference =
    echo_reference_frame != nullptr && echo_reference_frame->size() == kSamplesPer10Ms;
  const auto options = microphoneApmOptions(config, has_reference);
  ensureApm(options);

  std::vector<std::int16_t> mic_pcm;
  mic_pcm.reserve(kSamplesPer10Ms);
  for (float sample : raw_frame) mic_pcm.push_back(clampToPcm16(sample));

  if (apm_) {
    if (options.echo_cancellation && echo_reference_frame) {
      livekit::AudioFrame reverse(
        std::vector<std::int16_t>(*echo_reference_frame),
        kSampleRate,
        kChannels,
        kSamplesPer10Ms
      );
      apm_->processReverseStream(reverse);
      apm_->setStreamDelayMs(50);
    }

    livekit::AudioFrame forward(
      std::move(mic_pcm),
      kSampleRate,
      kChannels,
      kSamplesPer10Ms
    );
    apm_->processStream(forward);
    mic_pcm = forward.data();
  }

  std::vector<float> processed;
  processed.reserve(kSamplesPer10Ms);
  for (std::int16_t sample : mic_pcm) {
    processed.push_back((static_cast<float>(sample) / 32768.0f) * config.input_volume);
  }

  gate_.updateConfig(voiceGateConfigFromRuntimeConfig(config));
  const VoiceGateFrameMetrics gate_metrics = gate_.processFrame(processed);

  MicrophoneAudioProcessorFrame result;
  result.gate_metrics = gate_metrics;
  result.status.noise_suppression =
    config.noise_suppression_enabled ? (options.noise_suppression ? "software" : "unavailable") : "disabled";
  result.status.echo_cancellation =
    config.echo_cancellation_enabled ? (options.echo_cancellation ? "software" : "unavailable") : "disabled";

  result.pcm.reserve(kSamplesPer10Ms);
  for (float sample : processed) {
    if (std::abs(sample) > 1.0f) result.clipped_samples += 1;
    const float limited = softLimitSample(sample);
    result.output_peak = std::max(result.output_peak, std::abs(limited));
    result.pcm.push_back(clampToPcm16(limited));
  }

  return result;
}
```

- [ ] **Step 4: Do not silently enable AGC**

Add a runtime assertion in debug builds near APM construction:

```cpp
assert(!livekit_options.auto_gain_control);
```

Do not add UI, IPC fields, docs, or diagnostics for AGC.

- [ ] **Step 5: Run processor tests**

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
ctest --test-dir apps\desktop\native\native-voice-win\build -C Release --output-on-failure
```

Expected: processor option tests pass.

## Task 8: Wire Processor Into Publisher And Preview

**Files:**

- Modify: `apps/desktop/native/native-voice-win/src/microphone_publisher.cpp`
- Modify: `apps/desktop/native/native-voice-win/src/microphone_preview.cpp`
- Modify: `apps/desktop/native/native-voice-win/CMakeLists.txt`

- [ ] **Step 1: Add new source files to main native executable**

In `CMakeLists.txt`:

```cmake
add_executable(syrnike-native-voice-win
  src/audio_devices.cpp
  src/audio_processing.cpp
  src/main.cpp
  src/microphone_audio_processor.cpp
  src/microphone_echo_reference.cpp
  src/microphone_preview.cpp
  src/microphone_publisher.cpp
  src/microphone_warmup.cpp
  src/protocol.cpp
  src/runtime_config.cpp
  src/screen_audio_capture.cpp
  src/screen_preflight.cpp
  src/screen_publisher.cpp
  src/screen_sources.cpp
  src/screen_video_capture.cpp
  src/voice_gate.cpp
)
```

- [ ] **Step 2: Replace duplicated publish processing**

In `microphone_publisher.cpp`, include:

```cpp
#include "microphone_audio_processor.hpp"
#include "microphone_echo_reference.hpp"
```

Before the capture loop:

```cpp
MicrophoneAudioProcessor processor;
MicrophoneEchoReference echo_reference;
if (command.echo_cancellation) {
  echo_reference.start();
}
```

Inside each 10 ms frame:

```cpp
const RuntimeConfig config = readRuntimeConfig();
if (config.echo_cancellation_enabled) {
  echo_reference.start();
} else {
  echo_reference.stop();
}

const auto reference_frame = echo_reference.popFrame();
const auto processed = processor.processFrame(
  raw_frame,
  config,
  reference_frame.has_value() ? &reference_frame.value() : nullptr
);

const float input_db = processed.gate_metrics.input_db;
const bool open = processed.gate_metrics.open;
last_input_db = input_db;
if (!open) gated_frames += 1;
clipped_samples += processed.clipped_samples;
max_output_peak = std::max(max_output_peak, processed.output_peak);

if (state->publishing.load()) {
  livekit::AudioFrame audio_frame(
    std::vector<std::int16_t>(processed.pcm),
    kSampleRate,
    kChannels,
    kSamplesPer10Ms
  );
  audio_source->captureFrame(audio_frame);
}
```

Pass `processed.status` to diagnostics and lifecycle events.

- [ ] **Step 3: Emit ready and lifecycle statuses for publish**

When microphone session starts:

```cpp
emit("{\"type\":\"ready\",\"port\":0,\"stream_mode\":\"audio\",\"audio_mode\":\"microphone\","
     "\"audio_sample_rate\":48000,\"audio_channels\":1,"
     "\"noise_suppression\":\"" + status.noise_suppression + "\","
     "\"echo_cancellation\":\"" + status.echo_cancellation + "\"}");
```

For initial status before the first frame, use:

```cpp
MicrophoneAudioProcessorStatus initial_status;
initial_status.noise_suppression = command.noise_suppression ? "software" : "disabled";
initial_status.echo_cancellation = command.echo_cancellation ? "unavailable" : "disabled";
```

The first diagnostics event updates echo to `software` once reference frames are available.

- [ ] **Step 4: Replace duplicated preview processing without AEC**

In `microphone_preview.cpp`, include `microphone_audio_processor.hpp`.

Use:

```cpp
MicrophoneAudioProcessor processor;
```

For preview, copy runtime config and force AEC off:

```cpp
RuntimeConfig config = readRuntimeConfig();
config.echo_cancellation_enabled = false;
const auto processed = processor.processFrame(raw_frame, config, nullptr);
MicrophoneAudioProcessorStatus preview_status = processed.status;
preview_status.echo_cancellation =
  readRuntimeConfig().echo_cancellation_enabled ? "unavailable" : "disabled";
```

Render `processed.pcm` back to float:

```cpp
for (std::int16_t sample : processed.pcm) {
  queued_samples.push_back(static_cast<float>(sample) / 32768.0f);
}
```

Emit preview ready/lifecycle:

```cpp
"\"noise_suppression\":\"" + preview_status.noise_suppression + "\","
"\"echo_cancellation\":\"" + preview_status.echo_cancellation + "\""
```

- [ ] **Step 5: Run native build and CTest**

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
ctest --test-dir apps\desktop\native\native-voice-win\build -C Release --output-on-failure
```

Expected: native helper builds and all native tests pass.

## Task 9: Docs And AGC Cleanup

**Files:**

- Modify: `docs/native-media-engine.md`
- Modify: `apps/web/src/features/voice/voice-capture.test.ts`
- Search all tracked files except `node_modules`

- [ ] **Step 1: Replace stale DeepFilterNet3 docs**

Update `docs/native-media-engine.md` to describe:

```md
## Windows Microphone Processing

The Windows native voice helper uses LiveKit SDK's WebRTC Audio Processing Module
for standard microphone cleanup:

- `noiseSuppression`: software WebRTC noise suppression.
- `echoCancellation`: software WebRTC AEC3 when a WASAPI render-loopback
  reference is available.
- `autoGainControl`: not exposed and not enabled.

Preview applies noise suppression but reports echo cancellation as unavailable
because monitor preview audio is rendered to the same output device that a
loopback AEC reference would capture.
```

Remove `deep_filter_net3` from this document.

- [ ] **Step 2: Scan for AGC remnants**

Run:

```powershell
$files = git ls-files | Where-Object { $_ -notmatch '(^|/)node_modules/' }
Select-String -Path $files -Pattern 'AGC','autoGainControl','auto_gain_control','gain_control' -CaseSensitive:$false |
  ForEach-Object { "{0}:{1}: {2}" -f $_.Path.Replace((Get-Location).Path + '\',''), $_.LineNumber, $_.Line.Trim() }
```

Expected remaining intentional lines:

```text
apps\web\src\features\voice\voice-capture.ts: autoGainControl: false
apps\web\src\features\voice\voice-capture.test.ts: expect(...autoGainControl).toBe(false)
apps\desktop\native\native-voice-win\src\microphone_audio_processor.cpp: livekit_options.auto_gain_control = false
apps\desktop\native\native-voice-win\tests\microphone_audio_processor_test.cpp: assert(!...auto_gain_control)
```

Binary asset false positives from backend image fixtures can be ignored if the command scans binary files; do not modify asset files.

- [ ] **Step 3: Remove obsolete status values**

Remove `windows` from `NativeMediaEchoCancellationMode` and tests unless another real Windows-native echo cancellation implementation is added in this same branch.

- [ ] **Step 4: Run docs/type checks**

Run:

```powershell
pnpm desktop:typecheck
```

Expected: TypeScript typecheck passes.

## Task 10: Full Verification

**Files:**

- All modified files

- [ ] **Step 1: Run targeted Vitest suite**

Run:

```powershell
pnpm --filter @syrnike13/web exec vitest run --root ../.. apps/web/src/features/voice/native-microphone-publish.test.ts apps/web/src/features/voice/voice-mic-preview.test.ts apps/web/src/features/voice/voice-capture.test.ts apps/web/src/features/voice/voice-preference-store.test.ts apps/web/src/features/voice/voice-preference-effects.test.ts apps/desktop/src/main/native-media-engine.test.ts apps/desktop/src/main/native-media-engine-sidecar.test.ts packages/platform/src/media.test.ts packages/platform/src/ipc.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run desktop typecheck**

Run:

```powershell
pnpm desktop:typecheck
```

Expected: command exits successfully.

- [ ] **Step 3: Build native helper**

Run:

```powershell
pnpm --filter @syrnike13/desktop run build:native-voice
```

Expected: native helper builds in Release.

- [ ] **Step 4: Run native CTest**

Run:

```powershell
ctest --test-dir apps\desktop\native\native-voice-win\build -C Release --output-on-failure
```

Expected: all native tests pass.

- [ ] **Step 5: Manual Windows voice QA**

Run the desktop app and verify these cases:

```text
1. Headphones, quiet room:
   - Noise suppression on/off does not add obvious artifacts.
   - Echo cancellation on reports disabled/unavailable only when no render reference exists.

2. Speakers, remote audio playing:
   - Echo cancellation on reports software after reference frames arrive.
   - Remote speaker audio is reduced in the published mic track.
   - Echo cancellation off leaves the reference path stopped and reports disabled.

3. Keyboard/fan noise:
   - Noise suppression on reduces stationary noise.
   - Noise suppression off keeps raw mic character except volume/gate/limiter.

4. Runtime toggles:
   - Changing either checkbox while connected sends configure.
   - No helper restart is required for normal toggle changes.
   - No clicks, crashes, or stuck muted state after repeated toggles.

5. Preview:
   - Noise suppression affects monitor preview.
   - Echo cancellation reports unavailable in preview if the checkbox is on.
```

Collect at least one diagnostics sample with:

```json
{
  "noise_suppression": "software",
  "echo_cancellation": "software"
}
```

and one with:

```json
{
  "noise_suppression": "disabled",
  "echo_cancellation": "disabled"
}
```

## Risks And Mitigations

- AEC quality depends on reference timing. Start with `setStreamDelayMs(50)` and expose diagnostics for max frame gap/reference availability; adjust only after manual QA evidence.
- AEC quality depends on the correct render device. Current `getRenderDevice()` uses the default render endpoint; if the app later supports a non-default output device, echo reference should follow that device.
- WASAPI loopback can include all system audio. That is useful for speaker leakage, but diagnostics must make it clear when reference frames are unavailable or silent.
- Preview is not a reliable AEC proof because monitor output can become its own echo reference. Use real publish/call QA for AEC.
- WebRTC noise suppression is the Standard-like path, not Krisp-level ML cancellation. Do not promise Krisp quality in UI or docs.

## Completion Criteria

- Two independent UI checkboxes exist: `Шумоподавление` and `Эхоподавление`.
- Native start/configure commands include both `noiseSuppression` and `echoCancellation`.
- Native microphone publish uses LiveKit/WebRTC APM for noise suppression and AEC when available.
- Native preview uses the same processor for noise suppression, voice gate, input volume, and limiter.
- AGC is not exposed and native APM always sets `auto_gain_control = false`.
- Stale DeepFilterNet3 docs are removed.
- Targeted Vitest, `pnpm desktop:typecheck`, native build, and CTest pass.
- Manual QA has diagnostics proving enabled and disabled states.
