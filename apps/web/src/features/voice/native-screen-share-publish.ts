import { LocalVideoTrack, Track, type LocalParticipant, type Room } from 'livekit-client'

import { screenShareCaptureOptions } from '#/features/voice/voice-capture'
import { createNativeScreenShareTrack } from '#/features/voice/native-screen-share-bridge'
import { createNativeScreenShareAudioTrack } from '#/features/voice/native-screen-share-audio-bridge'
import { nativeCaptureStatsStore } from '#/features/voice/native-capture-stats'
import { defaultNativeCaptureStreamMode } from '#/features/voice/native-screen-share-mode'
import { tuneScreenShareAfterPublish } from '#/features/voice/voice-screen-share-tuning'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import { getSyrnikeDesktop } from '#/platform/runtime'

export type NativeScreenShareSession = {
  publicationId?: string
  track: MediaStreamTrack
  stop: () => void
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
  const streamMode = defaultNativeCaptureStreamMode()

  const bridge = await createNativeScreenShareTrack(
    desktop,
    '__pending__',
    streamMode,
  )

  const session = await desktop.capture.start({
    sourceId,
    width: capture.capture.resolution.width,
    height: capture.capture.resolution.height,
    fps: capture.capture.resolution.frameRate ?? 30,
    bitrate: encoding?.maxBitrate ?? 4_000_000,
    streamMode,
    withAudio,
  })

  bridge.bindSession(session.sessionId)

  const unsubscribeStats = desktop.capture.onStats((event) => {
    if (event.sessionId !== session.sessionId) return
    nativeCaptureStatsStore.setNative(event.methods, event.activeMethod)
  })

  const unsubscribeSidecarLost = desktop.capture.onSidecarLost((event) => {
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
    if (session.audioMode === 'process' && session.audioPort) {
      const audioBridge = await createNativeScreenShareAudioTrack(
        desktop,
        session.sessionId,
      )
      audioBridgeStop = audioBridge.stop
      screenShareAudioTrack = audioBridge.track
      await participant.publishTrack(audioBridge.track, {
        source: Track.Source.ScreenShareAudio,
      })
    } else {
      await desktop.capture.prepareSystemAudio(sourceId)
      screenShareAudioTrack = await publishSystemScreenShareAudio(participant)
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
      void desktop.capture.clearSystemAudio()
    }
    bridge.stop()
    nativeCaptureStatsStore.reset()
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

async function publishSystemScreenShareAudio(
  participant: LocalParticipant,
): Promise<MediaStreamTrack | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: false,
      audio: true,
    })
    const [audioTrack] = stream.getAudioTracks()
    if (!audioTrack) return null

    await participant.publishTrack(audioTrack, {
      source: Track.Source.ScreenShareAudio,
    })
    return audioTrack
  } catch {
    return null
  }
}
