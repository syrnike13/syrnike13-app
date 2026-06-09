import type { LocalParticipant, Room } from 'livekit-client'
import { toast } from 'sonner'

import { screenShareCaptureOptions } from '#/features/voice/voice-capture'
import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import type { NativeMicrophoneLiveKitCredentials } from '#/features/voice/native-microphone-publish'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import {
  clampVoiceChannelAudioBitrateKbps,
  DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
} from '#/lib/channel-audio-bitrate'
import { getSyrnikeDesktop } from '#/platform/runtime'

export type NativeScreenShareSession = {
  publicationId?: string
  nativeParticipantIdentity?: string
  stop: () => Promise<void>
}

function nativeScreenShareBitrateFloor(quality: ScreenShareQualityName) {
  switch (quality) {
    case 'high60':
      return 16_000_000
    case 'high':
      return 10_000_000
    case 'text':
      return 6_000_000
    case 'low':
    default:
      return 5_000_000
  }
}

export async function publishNativeScreenShare(
  _room: Room,
  _participant: LocalParticipant,
  sourceId: string,
  quality: ScreenShareQualityName,
  withAudio: boolean,
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
  onSidecarLost?: (message: string) => void,
  livekit?: NativeMicrophoneLiveKitCredentials,
): Promise<NativeScreenShareSession> {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }
  if (!livekit) {
    throw new Error('LiveKit credentials are required for native screen share')
  }

  const capture = screenShareCaptureOptions(quality)
  const encoding = capture.publish.screenShareEncoding

  const debugStartedAt = Date.now()
  // #region debug log
  fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'A-ipc', location: 'native-screen-share-publish.ts:publishNativeScreenShare', message: 'desktop media startSession requested', data: { quality, withAudio, width: capture.capture.resolution.width, height: capture.capture.resolution.height, fps: capture.capture.resolution.frameRate ?? 30, bitrate: Math.max(encoding?.maxBitrate ?? 0, nativeScreenShareBitrateFloor(quality)), sourceKind: sourceId.split(':')[0] }, timestamp: Date.now() }) }).catch(() => {})
  // #endregion
  const session = await desktop.media.startSession({
    kind: 'screen',
    sourceId,
    width: capture.capture.resolution.width,
    height: capture.capture.resolution.height,
    fps: capture.capture.resolution.frameRate ?? 30,
    bitrate: Math.max(
      encoding?.maxBitrate ?? 0,
      nativeScreenShareBitrateFloor(quality),
    ),
    audioBitrate: clampVoiceChannelAudioBitrateKbps(audioBitrateKbps) * 1000,
    audio: {
      requested: withAudio,
    },
    livekit,
  })
  if (session.kind !== 'screen') {
    throw new Error('Native screen share did not start')
  }
  // #region debug log
  fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'A-ipc', location: 'native-screen-share-publish.ts:publishNativeScreenShare', message: 'desktop media startSession resolved', data: { nativeSessionId: session.sessionId, width: session.width, height: session.height, fps: session.fps, bitrate: session.bitrate, audioMode: session.audio?.mode, elapsedMs: Date.now() - debugStartedAt }, timestamp: Date.now() }) }).catch(() => {})
  // #endregion

  const unsubscribeStats = desktop.media.onStats((event) => {
    if (event.sessionId !== session.sessionId) return
    const audio = session.audio
    nativeMediaEngineStatsStore.setNative(event.methods, event.activeMethod, {
      mode: audio?.mode,
      loopbackMode: audio?.loopbackMode,
      targetProcessId: audio?.targetProcessId,
    }, {
      width: session.width,
      height: session.height,
      fps: session.fps,
      bitrate: session.bitrate,
      publishedVideo: event.publishedVideo,
      publishedAudio: event.publishedAudio,
      audioFrames: event.audioFrames,
      audioPackets: event.audioPackets,
      audioPeakDb: event.audioPeakDb,
      audioRmsDb: event.audioRmsDb,
      videoFrames: event.videoFrames,
      videoIntervalFrames: event.videoIntervalFrames,
      videoLateFrames: event.videoLateFrames,
      videoAvgCaptureUs: event.videoAvgCaptureUs,
    })
  })

  const unsubscribeSidecarLost = desktop.media.onSidecarLost((event) => {
    if (event.sessionId !== session.sessionId) return
    onSidecarLost?.(event.message)
  })

  if (withAudio && session.audio?.mode === 'none') {
    toast.warning('Звук выбранного источника пока не подключён в native helper')
  }

  const stop = () => {
    unsubscribeStats()
    unsubscribeSidecarLost()
    nativeMediaEngineStatsStore.reset()
    return desktop.media.stopSession(session.sessionId)
  }

  return {
    nativeParticipantIdentity: session.nativeParticipantIdentity,
    stop,
  }
}
