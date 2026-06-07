import { LocalAudioTrack, Track, type LocalParticipant } from 'livekit-client'

import { createNativeAudioTrack } from '#/features/voice/native-screen-share-audio-bridge'
import { voiceMicPublishOptions } from '#/features/voice/voice-capture'
import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'
import { getSyrnikeDesktop } from '#/platform/runtime'

export type NativeMicrophoneSession = {
  publicationId?: string
  track: MediaStreamTrack
  sessionId: string
  stop: () => void
}

export type NativeMicrophoneStoppedHandler = (sessionId: string) => void

export function nativeMicrophoneDenoiseMode(
  prefs: Pick<VoicePreferenceState, 'noiseSuppression'>,
) {
  return prefs.noiseSuppression === 'enhanced'
    ? 'deep_filter_net3'
    : 'disabled'
}

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
    noiseSuppression: nativeMicrophoneDenoiseMode(prefs),
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
  const { desktop, session, bridge } = await startNativeMicrophoneTrack(
    readVoicePreferences(),
  )
  const localTrack = new LocalAudioTrack(bridge.track, undefined, false)

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    bridge.stop()
    bridge.track.stop()
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

  return {
    publicationId: publication.trackSid,
    sessionId: session.sessionId,
    track: bridge.track,
    stop,
  }
}
