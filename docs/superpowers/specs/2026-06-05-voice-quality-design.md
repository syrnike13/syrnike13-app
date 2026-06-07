# Voice Quality Design

## Goal

Improve voice channel audio quality with predictable client-side controls:
noise suppression, microphone gate, and listener-side participant auto balance.

## Current State

- `apps/web/src/features/voice/voice-capture.ts` captures microphone audio as mono for non-Windows web fallback paths.
- Windows desktop microphone capture is owned by the native Rust media engine, with enhanced denoise mapped to DeepFilterNet3.
- `apps/web/src/features/voice/remote-audio-settings.ts` controls remote audio element volume with global output volume and per-user volume/mute.
- `apps/web/src/components/settings/settings-voice-panel.tsx` already exposes voice device and audio processing settings.

## Architecture

Keep web-only fallback DSP at the web client layer. Windows desktop microphone
capture and microphone denoise must stay inside the native Rust media engine.
Do not patch the LiveKit fork for this feature.

Outgoing microphone quality:
- Do not reintroduce RNNoise. Windows enhanced microphone denoise is DeepFilterNet3 in the native media engine.
- Keep browser microphone processing only as a non-Windows fallback.
- Add a configurable voice gate preference.
- Implement gate state as pure math helpers first, then wire it through a LiveKit audio `TrackProcessor`.
- The gate must not call LiveKit track `mute()`/`unmute()` during silence because that would publish mute state changes and make remote UI flicker.

Incoming participant balance:
- Add listener-side auto balance preferences.
- Compute a deterministic effective remote audio volume from per-user volume, global output volume, mute/deafen, and a per-participant auto-balance gain.
- Keep the gain capped to the browser audio element range. This avoids surprise clipping and keeps behavior predictable.

## UX

Add controls under voice settings:
- Voice gate enabled toggle.
- Voice gate threshold slider.
- Auto balance enabled toggle.
- Auto balance strength slider.

Defaults must be conservative:
- Gate disabled by default.
- Auto balance disabled by default until users opt in.

## Testing

Use TDD:
- Preference loading clamps/parses new settings.
- Gate helper classifies signal levels around threshold.
- Remote audio volume combines auto-balance gain predictably and still respects mute/deafen.
- Settings panel writes the new preferences through the existing store.

## Non-Goals

- No LiveKit fork DSP changes in this pass.
- No server-side audio mixing.
- No aggressive loudness normalization that can clip or distort voices.
- No RNNoise dependency or browser RNNoise assets.
