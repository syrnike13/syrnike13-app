import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeMediaStatsEvent } from '@syrnike13/platform'

import { getSyrnikeDesktop } from '#/platform/runtime'

import { publishNativeScreenShare } from './native-screen-share-publish'
import { nativeMediaEngineStatsStore } from './native-media-engine-stats'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
  },
}))

vi.mock('livekit-client', () => ({
  ScreenSharePresets: {
    h1080fps30: {
      encoding: { maxBitrate: 8_000_000 },
      resolution: { width: 1920, height: 1080, frameRate: 60 },
    },
  },
}))

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: vi.fn(() => null),
}))

describe('native screen share publish', () => {
  beforeEach(() => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
    nativeMediaEngineStatsStore.reset()
  })

  it('starts native screen publisher with LiveKit credentials and no renderer track', async () => {
    const startSession = vi.fn(async () => ({
      kind: 'screen',
      sessionId: 'native-screen-1',
      encoder: 'media_foundation',
      width: 1920,
      height: 1038,
      fps: 60,
      bitrate: 8_000_000,
      audio: {
        mode: 'process',
        loopbackMode: 'include_target_process_tree',
        targetProcessId: 777,
      },
      nativeParticipantIdentity: 'user-1:desktop-native',
    }))
    const stopSession = vi.fn(async () => {})
    const onStats = vi.fn((handler: (event: NativeMediaStatsEvent) => void) => {
      void handler
      return vi.fn()
    })
    const onSidecarLost = vi.fn(() => vi.fn())

    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession,
        stopSession,
        onStats,
        onSidecarLost,
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const participant = {
      publishTrack: vi.fn(),
      unpublishTrack: vi.fn(),
    }

    const session = await publishNativeScreenShare(
      {} as never,
      participant as never,
      'game:1234',
      'screen-request-1',
      'high60',
      true,
      48,
      undefined,
      undefined,
      {
        url: 'wss://livekit.example',
        token: 'native-screen-token',
        participantIdentity: 'user-1:desktop-native',
      },
    )

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'screen',
        requestId: 'screen-request-1',
        sourceId: 'game:1234',
        width: 1920,
        height: 1080,
        fps: 60,
        audio: { requested: true },
        audioBitrate: 48_000,
        bitrate: 8_000_000,
        livekit: {
          url: 'wss://livekit.example',
          token: 'native-screen-token',
          participantIdentity: 'user-1:desktop-native',
        },
      }),
    )
    expect(participant.publishTrack).not.toHaveBeenCalled()
    expect(participant.unpublishTrack).not.toHaveBeenCalled()

    const statsHandler = onStats.mock.calls[0]?.[0]
    if (!statsHandler) {
      throw new Error('native stats handler was not registered')
    }
    statsHandler({
      sessionId: 'native-screen-1',
      methods: { wgc: 3, dxgi: 0, gdi_blt: 0, gdi_print: 0 },
      activeMethod: 'wgc',
      publishedVideo: true,
      publishedAudio: true,
      audioFrames: 96_000,
      audioPackets: 100,
      audioPeakDb: -6.5,
      audioRmsDb: -18.25,
      videoFrames: 120,
      videoIntervalFrames: 60,
      videoLateFrames: 0,
      videoAvgCaptureUs: 3200,
    })
    expect(nativeMediaEngineStatsStore.getState()).toMatchObject({
      backend: 'native',
      activeMethod: 'wgc',
      audioMode: 'process',
      audioLoopbackMode: 'include_target_process_tree',
      audioTargetProcessId: 777,
      width: 1920,
      height: 1038,
      fps: 60,
      bitrate: 8_000_000,
      publishedVideo: true,
      publishedAudio: true,
      audioFrames: 96_000,
      audioPackets: 100,
      audioPeakDb: -6.5,
      audioRmsDb: -18.25,
      videoFrames: 120,
      videoIntervalFrames: 60,
      videoLateFrames: 0,
      videoAvgCaptureUs: 3200,
    })

    await expect(session.stop()).resolves.toBeUndefined()
    expect(stopSession).toHaveBeenCalledWith('native-screen-1')
  })

  it('requires LiveKit credentials', async () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {},
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    await expect(
      publishNativeScreenShare(
        {} as never,
        {} as never,
        'screen:1',
        'screen-request-1',
        'high',
        false,
        64,
        undefined,
        undefined,
        undefined as unknown as Parameters<typeof publishNativeScreenShare>[9],
      ),
    ).rejects.toThrow('LiveKit credentials are required')
  })

  it('does not exceed server bitrate limits with the native startup bitrate floor', async () => {
    const startSession = vi.fn(async () => ({
      kind: 'screen',
      sessionId: 'native-screen-1',
      encoder: 'media_foundation',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 4_000_000,
      nativeParticipantIdentity: 'user-1:desktop-native:op-join:screen',
    }))

    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession,
        stopSession: vi.fn(async () => {}),
        onStats: vi.fn(() => vi.fn()),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    await publishNativeScreenShare(
      {} as never,
      {} as never,
      'screen:1',
      'screen-request-1',
      'high60',
      false,
      48,
      undefined,
      undefined,
      {
        url: 'wss://livekit.example',
        token: 'native-screen-token',
        participantIdentity: 'user-1:desktop-native:op-join:screen',
      },
      {
        maxWidth: 1920,
        maxHeight: 1080,
        maxPixels: 1920 * 1080,
        maxBitrate: 4_000_000,
      },
    )

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bitrate: 4_000_000,
      }),
    )
  })

  it('cleans up once when the native screen capture ends externally', async () => {
    const stopSession = vi.fn(async () => {})
    const unsubscribeStats = vi.fn()
    const unsubscribeEnded = vi.fn()
    const unsubscribeError = vi.fn()
    const unsubscribeSidecar = vi.fn()
    let onStreamEndedHandler: ((sessionId: string) => void) | undefined
    let onStreamErrorHandler:
      | ((event: { sessionId: string; message: string }) => void)
      | undefined
    let onSidecarLostHandler:
      | ((event: { sessionId: string; message: string }) => void)
      | undefined

    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession: vi.fn(async () => ({
          kind: 'screen',
          sessionId: 'native-screen-1',
          encoder: 'webrtc',
          width: 1920,
          height: 1080,
          fps: 60,
          bitrate: 16_000_000,
          nativeParticipantIdentity: 'user-1:desktop-native',
        })),
        stopSession,
        onStats: vi.fn(() => unsubscribeStats),
        onStreamEnded: vi.fn((handler) => {
          onStreamEndedHandler = handler
          return unsubscribeEnded
        }),
        onStreamError: vi.fn((handler) => {
          onStreamErrorHandler = handler
          return unsubscribeError
        }),
        onSidecarLost: vi.fn((handler) => {
          onSidecarLostHandler = handler
          return unsubscribeSidecar
        }),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const onEnded = vi.fn()
    const onSidecarLost = vi.fn()
    const session = await publishNativeScreenShare(
      {} as never,
      {} as never,
      'window:1234',
      'screen-request-1',
      'high60',
      false,
      48,
      onSidecarLost,
      onEnded,
      {
        url: 'wss://livekit.example',
        token: 'native-screen-token',
        participantIdentity: 'user-1:desktop-native',
      },
    )

    onStreamEndedHandler?.('other-session')
    expect(onEnded).not.toHaveBeenCalled()

    onStreamEndedHandler?.('native-screen-1')
    onStreamErrorHandler?.({
      sessionId: 'native-screen-1',
      message: 'capture failed',
    })
    onSidecarLostHandler?.({
      sessionId: 'native-screen-1',
      message: 'sidecar exited',
    })

    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(onSidecarLost).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
    expect(unsubscribeStats).toHaveBeenCalledTimes(1)
    expect(unsubscribeEnded).toHaveBeenCalledTimes(1)
    expect(unsubscribeError).toHaveBeenCalledTimes(1)
    expect(unsubscribeSidecar).toHaveBeenCalledTimes(1)

    await session.stop()
    expect(stopSession).not.toHaveBeenCalled()
  })
})
