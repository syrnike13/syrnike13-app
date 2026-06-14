import type { LocalParticipant, Room } from 'livekit-client'
import { toast } from 'sonner'

import { screenShareCaptureOptions } from '#/features/voice/voice-capture'
import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import type { NativeMicrophoneLiveKitCredentials } from '#/features/voice/native-microphone-publish'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import {
  clampVoiceChannelAudioBitrateKbps,
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
  audioBitrateKbps: number,
  onSidecarLost: ((message: string) => void) | undefined,
  livekit: NativeMicrophoneLiveKitCredentials,
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
      videoNoFrameCount: event.videoNoFrameCount,
      videoRepeatedFrameCount: event.videoRepeatedFrameCount,
      videoRecoverableLostCount: event.videoRecoverableLostCount,
      videoAvgCaptureUs: event.videoAvgCaptureUs,
      videoAvgReadbackUs: event.videoAvgReadbackUs,
      videoAvgScaleUs: event.videoAvgScaleUs,
      videoAvgPublishUs: event.videoAvgPublishUs,
      videoSourceWidth: event.videoSourceWidth,
      videoSourceHeight: event.videoSourceHeight,
      videoContentWidth: event.videoContentWidth,
      videoContentHeight: event.videoContentHeight,
      captureThreadMmcss: event.captureThreadMmcss,
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
