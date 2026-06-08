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
      bitrate: 16_000_000,
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
      'high60',
      true,
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
        sourceId: 'game:1234',
        width: 1920,
        height: 1080,
        fps: 60,
        audio: { requested: true },
        bitrate: 16_000_000,
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
      bitrate: 16_000_000,
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

    session.stop()
    expect(stopSession).toHaveBeenCalledWith('native-screen-1')
  })

  it('requires LiveKit credentials', async () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {},
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    await expect(
      publishNativeScreenShare({} as never, {} as never, 'screen:1', 'high', false),
    ).rejects.toThrow('LiveKit credentials are required')
  })
})
