# Voice Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conservative, testable voice quality controls for microphone gate and listener-side auto balance.

**Architecture:** Keep processing client-side. Store new preferences in the existing voice preference store, expose controls in the existing voice settings panel, and make audio math deterministic before any runtime DSP wiring.

**Tech Stack:** React, TypeScript, Vitest, LiveKit client, browser audio element volume controls.

---

### Task 1: Voice Preference Model

**Files:**
- Modify: `apps/web/src/features/voice/voice-preference-store.ts`
- Test: `apps/web/src/features/voice/voice-preference-store.test.ts`

- [ ] Add failing tests for default voice gate and auto balance settings.
- [ ] Add failing tests for clamping numeric settings loaded from localStorage.
- [ ] Add `voiceGateEnabled`, `voiceGateThreshold`, `autoBalanceEnabled`, and `autoBalanceStrength` to `VoicePreferenceState`.
- [ ] Add setters for each new preference.
- [ ] Run `pnpm --filter @syrnike13/web test -- --run apps/web/src/features/voice/voice-preference-store.test.ts`.

### Task 2: Gate Math Helpers

**Files:**
- Create: `apps/web/src/features/voice/voice-gate.ts`
- Test: `apps/web/src/features/voice/voice-gate.test.ts`

- [ ] Add failing tests for disabled gate always open.
- [ ] Add failing tests for threshold comparison.
- [ ] Add failing tests for threshold clamping.
- [ ] Implement pure helpers:
  - `normalizeVoiceGateThreshold(value: unknown): number`
  - `voiceGateOpen(level: number, threshold: number, enabled: boolean): boolean`
- [ ] Run `pnpm --filter @syrnike13/web test -- --run apps/web/src/features/voice/voice-gate.test.ts`.

### Task 3: Runtime Microphone Gate

**Files:**
- Modify: `apps/web/src/features/voice/voice-mic-processing.ts`
- Create: `apps/web/src/features/voice/voice-gate-runtime.ts`

- [ ] Add a small runtime controller that samples the microphone track with `AudioContext` and `AnalyserNode`.
- [ ] When gate is enabled and RMS remains below threshold, call `audioTrack.mute()`.
- [ ] When RMS rises above threshold, call `audioTrack.unmute()`.
- [ ] Stop the controller when microphone is disabled, track is missing, or gate is disabled.
- [ ] Keep RNNoise/browser processing behavior unchanged.
- [ ] Run `pnpm --filter @syrnike13/web build`.

### Task 4: Remote Auto Balance Math

**Files:**
- Modify: `apps/web/src/features/voice/remote-audio-settings.ts`
- Test: `apps/web/src/features/voice/remote-audio-settings.test.ts`

- [ ] Add failing tests that auto balance gain increases quiet participants and attenuates loud participants.
- [ ] Add failing tests that muted/deafened output remains zero.
- [ ] Add failing tests that final element volume stays within `0..1`.
- [ ] Implement pure helpers:
  - `normalizeAutoBalanceStrength(value: unknown): number`
  - `remoteAutoBalanceGain(inputLevel: number, strength: number, enabled: boolean): number`
  - Extend `remoteAudioElementVolume` with optional auto-balance gain.
- [ ] Run `pnpm --filter @syrnike13/web test -- --run apps/web/src/features/voice/remote-audio-settings.test.ts`.

### Task 5: Runtime Remote Auto Balance

**Files:**
- Create: `apps/web/src/features/voice/remote-audio-gain.ts`
- Modify: `apps/web/src/features/voice/remote-audio-settings.ts`
- Modify: `apps/web/src/features/voice/voice-provider.tsx`

- [ ] Add WebAudio gain-node support for remote audio elements where available.
- [ ] Store LiveKit participant `audioLevel` on matching remote audio elements.
- [ ] Re-apply remote audio settings when active speaker levels change.
- [ ] Release gain-node entries when remote audio elements are removed.
- [ ] Run `pnpm --filter @syrnike13/web build`.

### Task 6: Settings UI

**Files:**
- Modify: `apps/web/src/components/settings/settings-voice-panel.tsx`

- [ ] Add voice gate toggle and threshold slider under audio processing.
- [ ] Add auto balance toggle and strength slider under incoming voice.
- [ ] Use existing label/range/input patterns; do not introduce new UI dependencies.
- [ ] Run `pnpm web:test`.

### Task 7: Verification

**Files:**
- No new files.

- [ ] Run `pnpm web:test`.
- [ ] Run `pnpm web:build`.
- [ ] Run `git diff --check`.
- [ ] Revert unrelated `version:sync` churn if `pnpm web:build` touches version/package files.
