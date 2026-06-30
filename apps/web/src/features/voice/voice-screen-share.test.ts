import { describe, expect, it, vi } from 'vitest'

import {
  handleNativeScreenPublicationLost,
  rtcDebugScreenSlice,
  startBrowserScreenShare,
  startLocalScreenShare,
  stopNativeScreenShare,
} from '#/features/voice/voice-screen-share'
import type { NativeMediaState } from '#/features/voice/native-media-coordinator'
import type { RtcDebugSnapshot } from '#/features/voice/voice-rtc-debug'

describe('voice screen share helpers', () => {
  it('builds the screen-share rtc debug log slice', () => {
    const snapshot = {
      timestamp: 1,
      transport: {
        availableOutgoingBitrate: 6_000_000,
        availableIncomingBitrate: 7_000_000,
        pingMs: 42,
      },
      outbound: [
        {
          id: 'publisher-video',
          pcRole: 'publisher',
          kind: 'video',
          bitrate: 1_200_000,
          targetBitrate: 2_000_000,
          framesEncoded: 120,
          framesPerSecond: 60,
          frameWidth: 1920,
          frameHeight: 1080,
          qualityLimitationReason: 'none',
          nackCount: 1,
          pliCount: 2,
        },
      ],
      inbound: [
        {
          id: 'subscriber-video',
          pcRole: 'subscriber',
          kind: 'video',
          bitrate: 900_000,
          framesDecoded: 100,
          framesDropped: 3,
          framesPerSecond: 55,
          frameWidth: 1280,
          frameHeight: 720,
          packetsLost: 4,
          jitter: 0.02,
          freezeCount: 1,
        },
      ],
      screenShares: [
        {
          id: 'local-screen',
          ownerUserId: 'user-a',
          isLocal: true,
          live: true,
          subscribed: true,
          captureBackend: 'native',
          maxBitrate: 8_000_000,
          maxFramerate: 60,
          sentBitrate: 1_100_000,
          fps: 60,
          frameWidth: 1920,
          frameHeight: 1080,
          captureWidth: 1920,
          captureHeight: 1080,
          captureFrameRate: 60,
          captureVideoPublished: true,
          captureVideoFrames: 600,
          captureVideoIntervalFrames: 60,
          captureVideoLateFrames: 1,
          captureVideoNoFrameCount: 0,
          captureVideoRepeatedFrameCount: 2,
          captureVideoAvgCaptureUs: 300,
          captureVideoAvgReadbackUs: 400,
          captureVideoAvgScaleUs: 500,
          captureVideoAvgPublishUs: 600,
          captureThreadMmcss: true,
          captureAudioPublished: true,
          captureAudioFrames: 300,
          captureAudioPackets: 100,
        },
        {
          id: 'remote-screen',
          ownerUserId: 'user-b',
          isLocal: false,
          live: true,
          subscribed: false,
          receivedBitrate: 800_000,
          fps: 30,
          frameWidth: 1280,
          frameHeight: 720,
          packetsLost: 5,
        },
      ],
      rates: {
        transport: {
          outboundBitrate: 1_500_000,
          inboundBitrate: 1_000_000,
        },
        outbound: {},
        inbound: {},
      },
    } as RtcDebugSnapshot

    expect(rtcDebugScreenSlice(snapshot)).toEqual({
      transport: {
        availableOutgoingBitrate: 6_000_000,
        availableIncomingBitrate: 7_000_000,
        outboundBitrate: 1_500_000,
        inboundBitrate: 1_000_000,
        pingMs: 42,
      },
      outboundVideo: {
        bitrate: 1_200_000,
        targetBitrate: 2_000_000,
        framesEncoded: 120,
        framesPerSecond: 60,
        frameWidth: 1920,
        frameHeight: 1080,
        qualityLimitationReason: 'none',
        nackCount: 1,
        pliCount: 2,
      },
      inboundVideo: {
        bitrate: 900_000,
        framesDecoded: 100,
        framesDropped: 3,
        framesPerSecond: 55,
        frameWidth: 1280,
        frameHeight: 720,
        packetsLost: 4,
        jitter: 0.02,
        freezeCount: 1,
      },
      localScreen: {
        live: true,
        subscribed: true,
        captureBackend: 'native',
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        sentBitrate: 1_100_000,
        fps: 60,
        frameWidth: 1920,
        frameHeight: 1080,
        captureWidth: 1920,
        captureHeight: 1080,
        captureFrameRate: 60,
        captureVideoPublished: true,
        captureVideoFrames: 600,
        captureVideoIntervalFrames: 60,
        captureVideoLateFrames: 1,
        captureVideoNoFrameCount: 0,
        captureVideoRepeatedFrameCount: 2,
        captureVideoAvgCaptureUs: 300,
        captureVideoAvgReadbackUs: 400,
        captureVideoAvgScaleUs: 500,
        captureVideoAvgPublishUs: 600,
        captureThreadMmcss: true,
        captureAudioPublished: true,
        captureAudioFrames: 300,
        captureAudioPackets: 100,
      },
      remoteScreen: {
        live: true,
        subscribed: false,
        receivedBitrate: 800_000,
        fps: 30,
        frameWidth: 1280,
        frameHeight: 720,
        packetsLost: 5,
      },
    })
  })

  it('stops the active native screen share and clears native screen refs', async () => {
    const active = {
      nativeParticipantIdentity: 'user-a:desktop-native:screen-1',
      stop: vi.fn(async () => {}),
    }
    const nativeScreenShareRef = { current: active }
    const nativeScreenPublicationLossKeyRef = { current: 'loss-key' }
    const screenShareStartingRef = { current: true }
    const stoppedNativeScreenIdentityRef = { current: null }
    const resetNativeMediaEngineStats = vi.fn()
    const dispatchNativeMedia = vi.fn()
    const logVoiceDebugAgent = vi.fn()

    await stopNativeScreenShare({
      nativeScreenShareRef,
      nativeScreenPublicationLossKeyRef,
      screenShareStartingRef,
      stoppedNativeScreenIdentityRef,
      resetNativeMediaEngineStats,
      dispatchNativeMedia,
      logVoiceDebugAgent,
    })

    expect(nativeScreenShareRef.current).toBeNull()
    expect(nativeScreenPublicationLossKeyRef.current).toBeNull()
    expect(screenShareStartingRef.current).toBe(false)
    expect(stoppedNativeScreenIdentityRef.current).toBe(
      'user-a:desktop-native:screen-1',
    )
    expect(resetNativeMediaEngineStats).toHaveBeenCalled()
    expect(dispatchNativeMedia).toHaveBeenCalledWith({ type: 'screen_stopped' })
    expect(logVoiceDebugAgent).toHaveBeenCalledWith({
      hypothesis: 'H3-stage-native-screen-loss,H4-native-stop-timeout',
      event: 'web-stop-native-screen-share',
      hasNativeParticipantIdentity: true,
    })
    expect(active.stop).toHaveBeenCalled()
  })

  it('clears native screen state once when publication is lost without an active native session', () => {
    const nativeMediaStateRef = {
      current: {
        microphone: { status: 'idle' },
        screen: {
          status: 'published',
          operationId: 'op-screen',
          channelId: 'voice-a',
          participantIdentity: 'user-a:desktop-native:screen-1',
          publicationSid: 'TR_screen',
          visibleInRoom: true,
        },
      } as NativeMediaState,
    }
    const nativeScreenPublicationLossKeyRef = { current: null }
    const deps = {
      nativeMediaStateRef,
      nativeScreenPublicationLossKeyRef,
      nativeScreenShareRef: { current: null },
      dispatchNativeMedia: vi.fn(),
      setScreenShareEnabled: vi.fn(),
      syncRoomParticipants: vi.fn(),
      toastError: vi.fn(),
      stopNativeScreenShare: vi.fn(async () => {}),
      logVoiceDebugAgent: vi.fn(),
    }
    const loss = {
      reason: 'track-unpublished' as const,
      participantIdentity: 'user-a:desktop-native:screen-1',
      publicationSid: 'TR_screen',
    }

    handleNativeScreenPublicationLost(deps, loss)
    handleNativeScreenPublicationLost(deps, loss)

    expect(deps.dispatchNativeMedia).toHaveBeenCalledTimes(1)
    expect(deps.dispatchNativeMedia).toHaveBeenCalledWith({
      type: 'screen_stopped',
    })
    expect(deps.setScreenShareEnabled).toHaveBeenCalledWith(false)
    expect(deps.syncRoomParticipants).toHaveBeenCalledTimes(1)
    expect(deps.toastError).toHaveBeenCalledWith(
      'Демонстрация экрана отключилась',
    )
    expect(deps.stopNativeScreenShare).not.toHaveBeenCalled()
    expect(deps.logVoiceDebugAgent).toHaveBeenCalledWith({
      hypothesis: 'H3-stage-native-screen-loss',
      event: 'native-screen-publication-lost',
      reason: 'track-unpublished',
      participantIdentity: 'user-a:desktop-native:screen-1',
      publicationSid: 'TR_screen',
      remoteParticipants: undefined,
    })
  })

  it('starts browser screen share with capture options and marks Chromium stats', async () => {
    const publication: Record<string, unknown> = {}
    const setScreenShareEnabled = vi.fn(async () => publication)
    const room = {
      localParticipant: {
        setScreenShareEnabled,
        trackPublications: new Map(),
      },
    }
    const setChromiumNativeMediaStats = vi.fn()

    await startBrowserScreenShare({
      room: room as never,
      quality: 'high',
      withAudio: false,
      activeChannelAudioBitrateKbps: () => 64,
      setScreenShareEnabled: vi.fn(),
      syncRoomParticipants: vi.fn(),
      playUiSound: vi.fn(),
      setChromiumNativeMediaStats,
    })

    expect(setScreenShareEnabled).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        audio: false,
        contentHint: expect.any(String),
      }),
      expect.objectContaining({
        screenShareEncoding: expect.any(Object),
      }),
    )
    expect(publication.options).toEqual(
      expect.objectContaining({
        screenShareEncoding: expect.any(Object),
      }),
    )
    expect(setChromiumNativeMediaStats).toHaveBeenCalled()
  })

  it('defers local screen share start until local voice setup is ready', async () => {
    const pendingScreenShareStartRef = { current: null }
    const logVoiceDebugAgent = vi.fn()
    const setScreenShareDebugRun = vi.fn()
    const setScreenShareStarting = vi.fn()
    const dispatchNativeMedia = vi.fn()
    const room = {
      state: 'connected',
      localParticipant: {
        setScreenShareEnabled: vi.fn(),
        trackPublications: new Map(),
      },
    }

    await startLocalScreenShare({
      quality: 'high',
      withAudio: true,
      roomRef: { current: room as never },
      channelIdRef: { current: 'voice-a' },
      statusRef: { current: 'connected' },
      localVoiceReadyRef: { current: false },
      screenShareStartingRef: { current: false },
      pendingScreenShareStartRef,
      screenShareStartGenerationRef: { current: 0 },
      screenShareDebugUntilRef: { current: 0 },
      nativeScreenShareRef: { current: null },
      stoppedNativeScreenIdentityRef: { current: null },
      nativeScreenPublicationLossKeyRef: { current: null },
      getActiveVoiceOperationId: () => null,
      getUserId: () => 'user-a',
      isCurrentVoiceSession: () => true,
      createRequestId: () => 'screen-request-1',
      nowMs: () => 1_000,
      performanceNow: () => 10,
      setScreenShareDebugRun,
      setScreenShareStarting,
      setScreenShareEnabled: vi.fn(),
      dispatchNativeMedia,
      syncRoomParticipants: vi.fn(),
      stopNativeScreenShare: vi.fn(async () => {}),
      startBrowserScreenShare: vi.fn(async () => {}),
      refreshNativeLiveKitCredentials: vi.fn(),
      activeChannelAudioBitrateKbps: () => 64,
      logVoiceDebugAgent,
      toastError: vi.fn(),
      playUiSound: vi.fn(),
      warn: vi.fn(),
      readVoicePreferences: () => ({ screenShareCaptureMode: 'auto' }),
      setScreenShareQualityPreference: vi.fn(),
      setScreenShareAudioPreference: vi.fn(),
      getDesktop: () => null,
      shouldUseNativeScreenShare: () => false,
      resolveScreenShareCaptureLimits: vi.fn(),
      waitForNativePickerSelection: vi.fn(),
      clearNativePickerSelection: vi.fn(),
      rejectNativePickerSelection: vi.fn(),
      publishNativeScreenShare: vi.fn(),
      findNativeScreenPublication: vi.fn(),
      waitForNativeScreenPublication: vi.fn(),
      isLiveKitTokenFailure: () => false,
      resetNativeMediaEngineStats: vi.fn(),
    })

    expect(pendingScreenShareStartRef.current).toEqual({
      quality: 'high',
      withAudio: true,
    })
    expect(logVoiceDebugAgent).toHaveBeenCalledWith({
      hypothesis: 'H6-screen-start-before-local-voice-ready',
      event: 'screen-start-deferred-local-voice-not-ready',
      voiceStatus: 'connected',
      roomState: 'connected',
    })
    expect(setScreenShareDebugRun).not.toHaveBeenCalled()
    expect(setScreenShareStarting).not.toHaveBeenCalled()
    expect(dispatchNativeMedia).not.toHaveBeenCalled()
  })
})
