import { LocalVideoTrack, Track, type LocalParticipant, type Room } from 'livekit-client'
import { toast } from 'sonner'

import {
  screenShareAudioPublishOptions,
  screenShareCaptureOptions,
} from '#/features/voice/voice-capture'
import { createNativeScreenShareTrack } from '#/features/voice/native-screen-share-bridge'
import { createNativeScreenShareAudioTrack } from '#/features/voice/native-screen-share-audio-bridge'
import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import { defaultNativeMediaStreamMode } from '#/features/voice/native-screen-share-mode'
import { tuneScreenShareAfterPublish } from '#/features/voice/voice-screen-share-tuning'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import { getSyrnikeDesktop } from '#/platform/runtime'

export type NativeScreenShareSession = {
  publicationId?: string
  track: MediaStreamTrack
  stop: () => void
}

function hasNativeScreenShareAudio(
  withAudio: boolean,
  audioMode: string | undefined,
  audioPort: number | undefined,
) {
  return (
    withAudio &&
    audioPort != null &&
    (audioMode === 'process' || audioMode === 'system_exclude')
  )
}

export async function publishNativeScreenShare(
  room: Room,
  participant: LocalParticipant,
  sourceId: string,
  quality: ScreenShareQualityName,
  withAudio: boolean,
  onSidecarLost?: (message: string) => void,
): Promise<NativeScreenShareSession> {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }

  const capture = screenShareCaptureOptions(quality)
  const encoding = capture.publish.screenShareEncoding
  const streamMode = defaultNativeMediaStreamMode()

  const bridge = await createNativeScreenShareTrack(
    desktop,
    '__pending__',
    streamMode,
  )

  const session = await desktop.media.startSession({
    kind: 'screen',
    sourceId,
    width: capture.capture.resolution.width,
    height: capture.capture.resolution.height,
    fps: capture.capture.resolution.frameRate ?? 30,
    bitrate: encoding?.maxBitrate ?? 4_000_000,
    streamMode,
    audio: {
      requested: withAudio,
    },
  })

  bridge.bindSession(session.sessionId)

  const unsubscribeStats = desktop.media.onStats((event) => {
    if (event.sessionId !== session.sessionId) return
    nativeMediaEngineStatsStore.setNative(event.methods, event.activeMethod)
  })

  const unsubscribeSidecarLost = desktop.media.onSidecarLost((event) => {
    if (event.sessionId !== session.sessionId) return
    onSidecarLost?.(event.message)
  })

  bridge.track.contentHint = capture.capture.contentHint

  await bridge.waitForFirstFrame()

  const captureWidth = capture.capture.resolution.width
  const captureHeight = capture.capture.resolution.height
  const frameDims =
    bridge.getLastFrameDimensions() ?? {
      width: captureWidth,
      height: captureHeight,
    }

  try {
    await bridge.track.applyConstraints({
      width: { ideal: frameDims.width },
      height: { ideal: frameDims.height },
      aspectRatio: frameDims.width / frameDims.height,
    })
  } catch {
    // MediaStreamTrackGenerator may reject constraints on some builds.
  }

  const localTrack = new LocalVideoTrack(
    bridge.track,
    {
      width: frameDims.width,
      height: frameDims.height,
      aspectRatio: frameDims.width / frameDims.height,
    },
    false,
  )

  const publication = await participant.publishTrack(localTrack, {
    ...capture.publish,
    source: Track.Source.ScreenShare,
  })

  await tuneScreenShareAfterPublish(room, bridge.track, quality)

  let audioBridgeStop: (() => void) | null = null
  let screenShareAudioTrack: MediaStreamTrack | null = null

  if (withAudio) {
    if (session.audio?.mode === 'none') {
      toast.warning(
        'Звук экрана недоступен при демонстрации окна Syrnike',
      )
    } else if (
      hasNativeScreenShareAudio(
        withAudio,
        session.audio?.mode,
        session.audio?.port,
      )
    ) {
      const audioBridge = await createNativeScreenShareAudioTrack(
        desktop,
        session.sessionId,
      )
      audioBridgeStop = audioBridge.stop
      screenShareAudioTrack = audioBridge.track
      await participant.publishTrack(
        audioBridge.track,
        screenShareAudioPublishOptions(),
      )
    } else {
      toast.warning('Не удалось захватить звук экрана')
    }
  }

  const stop = () => {
    unsubscribeStats()
    unsubscribeSidecarLost()
    audioBridgeStop?.()
    if (screenShareAudioTrack) {
      screenShareAudioTrack.stop()
      void participant.unpublishTrack(screenShareAudioTrack)
      screenShareAudioTrack = null
    }
    bridge.stop()
    nativeMediaEngineStatsStore.reset()
    void participant.unpublishTrack(localTrack)
  }

  bridge.track.addEventListener('ended', () => {
    stop()
  })

  return {
    publicationId: publication.trackSid,
    track: bridge.track,
    stop,
  }
}
