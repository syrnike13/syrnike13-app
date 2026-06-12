import {
  Track,
  type LocalAudioTrack,
  type LocalParticipant,
  type Room,
} from 'livekit-client'

import { voiceAudioProcessingConstraints } from '#/features/voice/voice-capture'
import {
  createMicProcessorConfigFromPrefs,
  micProcessingNeeded,
  SYRNIKE_MIC_PROCESSOR_NAME,
  SyrnikeMicProcessor,
} from '#/features/voice/voice-mic-processor'
import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'

async function applyMicCaptureConstraints(
  audioTrack: LocalAudioTrack,
  prefs: VoicePreferenceState,
) {
  try {
    await audioTrack.mediaStreamTrack.applyConstraints(
      voiceAudioProcessingConstraints(prefs),
    )
  } catch {
    // Some browsers reject live constraint changes; keep the existing capture.
  }
}

export async function applyMicProcessing(participant: LocalParticipant) {
  const prefs = readVoicePreferences()
  const audioTrack = participant.getTrackPublication(
    Track.Source.Microphone,
  )?.audioTrack

  if (!audioTrack) {
    return
  }

  await applyMicCaptureConstraints(audioTrack, prefs)

  const config = createMicProcessorConfigFromPrefs(prefs)
  const current = audioTrack.getProcessor()

  if (!micProcessingNeeded(config)) {
    if (current?.name === SYRNIKE_MIC_PROCESSOR_NAME) {
      try {
        await audioTrack.stopProcessor()
      } catch {
        // no processor attached
      }
    }
    return
  }

  if (current?.name === SYRNIKE_MIC_PROCESSOR_NAME) {
    try {
      await audioTrack.stopProcessor()
    } catch {
      // no processor attached
    }
  }

  try {
    await audioTrack.setProcessor(new SyrnikeMicProcessor(config))
  } catch (error) {
    console.warn('[voice] setProcessor failed', error)
  }
}

export async function refreshMicProcessing(room: Room | null) {
  if (!room) return
  await applyMicProcessing(room.localParticipant)
}
