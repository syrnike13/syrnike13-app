import {
  Track,
  type LocalAudioTrack,
  type LocalParticipant,
  type Room,
} from 'livekit-client'

import { voiceAudioProcessingConstraints } from '#/features/voice/voice-capture'
import { applyVoiceGateProcessor } from '#/features/voice/voice-gate-runtime'
import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'

type DenoiseProcessor = Awaited<
  ReturnType<typeof createDenoiseProcessor>
>

let processor: DenoiseProcessor | null = null
let processorLoad: Promise<DenoiseProcessor | null> | null = null

async function createDenoiseProcessor() {
  const { DenoiseTrackProcessor } = await import('livekit-rnnoise-processor')
  return new DenoiseTrackProcessor()
}

/** RNNoise только в браузере — пакет ломает Node SSR (ESM без расширений). */
async function loadDenoiseProcessor() {
  if (typeof window === 'undefined') return null
  if (processor) return processor
  if (!processorLoad) {
    processorLoad = createDenoiseProcessor()
      .then((instance) => {
        processor = instance
        return instance
      })
      .catch(() => null)
  }
  return processorLoad
}

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

  const gateApplied = await applyVoiceGateProcessor(
    audioTrack,
    prefs.voiceGateEnabled,
    prefs.voiceGateThreshold,
  )
  if (gateApplied) return

  if (prefs.noiseSuppression === 'enhanced') {
    const denoise = await loadDenoiseProcessor()
    if (denoise) {
      try {
        await audioTrack.setProcessor(denoise)
      } catch {
        // fallback: leave browser constraints only
      }
    }
  } else {
    try {
      await audioTrack.stopProcessor()
    } catch {
      // no processor attached
    }
  }
}

export async function refreshMicProcessing(room: Room | null) {
  if (!room) return
  await applyMicProcessing(room.localParticipant)
}
