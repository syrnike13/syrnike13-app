import {
  Track,
  type LocalAudioTrack,
  type LocalParticipant,
  type Room,
} from 'livekit-client'
import { Effect } from 'effect'

import { voiceAudioProcessingConstraints } from '#/features/voice/voice-capture'
import {
  createMicProcessorConfigFromPrefs,
  micProcessingNeeded,
  SYRNIKE_MIC_PROCESSOR_NAME,
  SyrnikeMicProcessor,
} from '#/features/voice/voice-mic-processor'
import type { VoiceMediaDesiredState } from '@syrnike13/platform'

export type VoiceMicProcessingPreferences = Pick<
  VoiceMediaDesiredState,
  | 'automaticGainControl'
  | 'echoCancellation'
  | 'noiseSuppression'
  | 'inputVolume'
  | 'voiceGateEnabled'
  | 'voiceGateThresholdDb'
  | 'voiceGateAutoThreshold'
>

function applyMicCaptureConstraintsEffect(
  audioTrack: LocalAudioTrack,
  prefs: VoiceMicProcessingPreferences,
) {
  return Effect.tryPromise({
    try: () =>
      audioTrack.mediaStreamTrack.applyConstraints(
        voiceAudioProcessingConstraints(prefs),
      ),
    catch: (cause) => cause,
  }).pipe(
    // Some browsers reject live constraint changes; keep the existing capture.
    Effect.catch(() => Effect.void),
  )
}

export function applyMicProcessing(
  participant: LocalParticipant,
  prefs: VoiceMicProcessingPreferences,
) {
  return Effect.runPromise(applyMicProcessingEffect(participant, prefs))
}

export function applyMicProcessingEffect(
  participant: LocalParticipant,
  prefs: VoiceMicProcessingPreferences,
) {
  return Effect.gen(function*() {
    const audioTrack = participant.getTrackPublication(
      Track.Source.Microphone,
    )?.audioTrack

    if (!audioTrack) return

    yield* applyMicCaptureConstraintsEffect(audioTrack, prefs)

    const config = createMicProcessorConfigFromPrefs(prefs)
    const current = audioTrack.getProcessor()

    if (!micProcessingNeeded(config)) {
      if (current?.name === SYRNIKE_MIC_PROCESSOR_NAME) {
        yield* stopProcessorEffect(audioTrack)
      }
      return
    }

    if (current?.name === SYRNIKE_MIC_PROCESSOR_NAME) {
      yield* stopProcessorEffect(audioTrack)
    }

    yield* Effect.tryPromise({
      try: () => audioTrack.setProcessor(new SyrnikeMicProcessor(config)),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => console.warn('[voice] setProcessor failed', error)),
      ),
    )
  })
}

function stopProcessorEffect(audioTrack: LocalAudioTrack) {
  return Effect.tryPromise({
    try: () => audioTrack.stopProcessor(),
    catch: (cause) => cause,
  }).pipe(
    // LiveKit can report that the processor disappeared between reads.
    Effect.catch(() => Effect.void),
  )
}

export function refreshMicProcessing(
  room: Room | null,
  prefs: VoiceMicProcessingPreferences,
) {
  return Effect.runPromise(refreshMicProcessingEffect(room, prefs))
}

export function refreshMicProcessingEffect(
  room: Room | null,
  prefs: VoiceMicProcessingPreferences,
) {
  return room
    ? applyMicProcessingEffect(room.localParticipant, prefs)
    : Effect.void
}
