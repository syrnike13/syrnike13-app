import type { RtcDebugSnapshot } from '#/features/voice/voice-rtc-debug'

type ScreenShareSound = 'screen_share.started' | 'screen_share.stopped'
type PlayScreenShareSound = (sound: ScreenShareSound) => void

export type ScreenShareTeardownReason =
  | 'browser-track-ended'
  | 'native-ended'
  | 'native-publication-lost'
  | 'native-runtime-lost'
  | 'user-toggle'

export type TeardownScreenShareDeps = {
  setScreenShareEnabled: (enabled: boolean) => void
  syncRoomParticipants: () => void
  playUiSound?: PlayScreenShareSound
}

export type TeardownScreenShareOptions = {
  reason: ScreenShareTeardownReason
  screenShareEnabled?: boolean
  playStoppedSound?: boolean
  beforeSync?: () => void
}

export function teardownScreenShare(
  deps: TeardownScreenShareDeps,
  options: TeardownScreenShareOptions,
) {
  deps.setScreenShareEnabled(options.screenShareEnabled ?? false)
  if (options.playStoppedSound) {
    deps.playUiSound?.('screen_share.stopped')
  }
  options.beforeSync?.()
  deps.syncRoomParticipants()
}

export function rtcDebugScreenSlice(snapshot: RtcDebugSnapshot) {
  const localScreen = snapshot.screenShares.find((screen) => screen.isLocal)
  const remoteScreen = snapshot.screenShares.find((screen) => !screen.isLocal)
  const outboundVideo = snapshot.outbound.find(
    (stream) => stream.pcRole === 'publisher' && stream.kind === 'video',
  )
  const inboundVideo = snapshot.inbound.find(
    (stream) => stream.pcRole === 'subscriber' && stream.kind === 'video',
  )

  return {
    transport: {
      availableOutgoingBitrate: snapshot.transport.availableOutgoingBitrate,
      availableIncomingBitrate: snapshot.transport.availableIncomingBitrate,
      outboundBitrate: snapshot.rates?.transport.outboundBitrate,
      inboundBitrate: snapshot.rates?.transport.inboundBitrate,
      pingMs: snapshot.transport.pingMs,
    },
    outboundVideo: outboundVideo
      ? {
          bitrate: outboundVideo.bitrate,
          targetBitrate: outboundVideo.targetBitrate,
          framesEncoded: outboundVideo.framesEncoded,
          framesPerSecond: outboundVideo.framesPerSecond,
          frameWidth: outboundVideo.frameWidth,
          frameHeight: outboundVideo.frameHeight,
          qualityLimitationReason: outboundVideo.qualityLimitationReason,
          nackCount: outboundVideo.nackCount,
          pliCount: outboundVideo.pliCount,
        }
      : null,
    inboundVideo: inboundVideo
      ? {
          bitrate: inboundVideo.bitrate,
          framesDecoded: inboundVideo.framesDecoded,
          framesDropped: inboundVideo.framesDropped,
          framesPerSecond: inboundVideo.framesPerSecond,
          frameWidth: inboundVideo.frameWidth,
          frameHeight: inboundVideo.frameHeight,
          packetsLost: inboundVideo.packetsLost,
          jitter: inboundVideo.jitter,
          freezeCount: inboundVideo.freezeCount,
        }
      : null,
    localScreen: localScreen
      ? {
          live: localScreen.live,
          subscribed: localScreen.subscribed,
          captureBackend: localScreen.captureBackend,
          maxBitrate: localScreen.maxBitrate,
          maxFramerate: localScreen.maxFramerate,
          sentBitrate: localScreen.sentBitrate,
          fps: localScreen.fps,
          frameWidth: localScreen.frameWidth,
          frameHeight: localScreen.frameHeight,
          captureWidth: localScreen.captureWidth,
          captureHeight: localScreen.captureHeight,
          captureFrameRate: localScreen.captureFrameRate,
          captureVideoPublished: localScreen.captureVideoPublished,
          captureVideoFrames: localScreen.captureVideoFrames,
          captureVideoIntervalFrames: localScreen.captureVideoIntervalFrames,
          captureVideoLateFrames: localScreen.captureVideoLateFrames,
          captureVideoNoFrameCount: localScreen.captureVideoNoFrameCount,
          captureVideoRepeatedFrameCount:
            localScreen.captureVideoRepeatedFrameCount,
          captureVideoAvgCaptureUs: localScreen.captureVideoAvgCaptureUs,
          captureVideoAvgReadbackUs: localScreen.captureVideoAvgReadbackUs,
          captureVideoAvgScaleUs: localScreen.captureVideoAvgScaleUs,
          captureVideoAvgPublishUs: localScreen.captureVideoAvgPublishUs,
          captureThreadMmcss: localScreen.captureThreadMmcss,
          captureAudioPublished: localScreen.captureAudioPublished,
          captureAudioFrames: localScreen.captureAudioFrames,
          captureAudioPackets: localScreen.captureAudioPackets,
        }
      : null,
    remoteScreen: remoteScreen
      ? {
          live: remoteScreen.live,
          subscribed: remoteScreen.subscribed,
          receivedBitrate: remoteScreen.receivedBitrate,
          fps: remoteScreen.fps,
          frameWidth: remoteScreen.frameWidth,
          frameHeight: remoteScreen.frameHeight,
          packetsLost: remoteScreen.packetsLost,
        }
      : null,
  }
}
