import { LocalAudioTrack, type LocalParticipant } from 'livekit-client'

import { createNativeAudioTrack } from '#/features/voice/native-screen-share-audio-bridge'
import { voiceMicPublishOptions } from '#/features/voice/voice-capture'
import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'
import {
  createMicProcessorConfigFromPrefs,
  SyrnikeMicProcessor,
} from '#/features/voice/voice-mic-processor'
import { getSyrnikeDesktop } from '#/platform/runtime'

export type NativeMicrophoneSession = {
  publicationId?: string
  track: MediaStreamTrack
  sessionId: string
  stop: () => void
}

export type NativeMicrophoneStoppedHandler = (sessionId: string) => void

export function shouldUseNativeMicrophone() {
  return getSyrnikeDesktop()?.platform.os === 'win32'
}

export function nativeMicrophoneSessionOptions(
  prefs: VoicePreferenceState,
  deviceId = prefs.preferredAudioInputDevice,
) {
  return {
    kind: 'microphone' as const,
    deviceId,
    sampleRate: 48_000 as const,
    channels: 1 as const,
    echoCancellation: prefs.echoCancellation,
    inputVolume: prefs.inputVolume,
  }
}

export async function startNativeMicrophoneTrack(
  prefs: VoicePreferenceState,
  deviceId?: string,
) {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }

  const session = await desktop.media.startSession(
    nativeMicrophoneSessionOptions(prefs, deviceId),
  )

  if (session.kind !== 'microphone') {
    throw new Error('Native media engine returned a non-microphone session')
  }

  let bridge: Awaited<ReturnType<typeof createNativeAudioTrack>>
  try {
    bridge = await createNativeAudioTrack(desktop, session.sessionId, {
      sampleRate: session.audio.sampleRate,
      channels: session.audio.channels,
    })
  } catch (error) {
    await desktop.media.stopSession(session.sessionId)
    throw error
  }

  return { desktop, session, bridge }
}

export async function publishNativeMicrophone(
  participant: LocalParticipant,
  onStopped?: NativeMicrophoneStoppedHandler,
): Promise<NativeMicrophoneSession> {
  const prefs = readVoicePreferences()
  const { desktop, session, bridge } = await startNativeMicrophoneTrack(
    prefs,
  )
  const processorContext = new AudioContext()
  const processor = new SyrnikeMicProcessor({
    ...createMicProcessorConfigFromPrefs({
      ...prefs,
      // Native helper already applies input volume before streaming PCM.
      inputVolume: 1,
    }),
    inputVolume: 1,
  })
  await processor.init({
    audioContext: processorContext,
    track: bridge.track,
  })
  const processedTrack = processor.processedTrack ?? bridge.track
  const localTrack = new LocalAudioTrack(processedTrack, undefined, false)

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    void processor.destroy()
    void processorContext.close()
    bridge.stop()
    bridge.track.stop()
    if (processedTrack !== bridge.track) processedTrack.stop()
    void participant.unpublishTrack(localTrack)
    void desktop.media.stopSession(session.sessionId)
    onStopped?.(session.sessionId)
  }

  let publication: Awaited<ReturnType<LocalParticipant['publishTrack']>>
  try {
    publication = await participant.publishTrack(
      localTrack,
      voiceMicPublishOptions(),
    )
  } catch (error) {
    stop()
    throw error
  }

  bridge.track.addEventListener('ended', stop)
  processedTrack.addEventListener('ended', stop)

  return {
    publicationId: publication.trackSid,
    sessionId: session.sessionId,
    track: processedTrack,
    stop,
  }
}
