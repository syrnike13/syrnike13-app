import { describe, expect, it, vi } from 'vitest'

import {
  disconnectNativeMediaForHandoff,
  refreshNativeLiveKitCredentials,
  resetNativeMediaState,
  setNativeMicrophoneMuted,
  startNativeMicrophone,
} from '#/features/voice/voice-native-media'

describe('voice native media helpers', () => {
  it('resets native microphone, screen session, desktop starts, and watched screens', () => {
    const nativeMicrophone = { disconnect: vi.fn() }
    const nativeScreenShare = { stop: vi.fn(async () => {}) }
    const cancelPendingStarts = vi.fn(async () => {})
    const disconnectPreparedScreenSession = vi.fn(async () => {})
    const resetNativeMediaEngineStats = vi.fn()
    const watchedRemoteScreenIds = new Set(['remote-user:screen'])
    const pendingScreenWatchIds = new Set(['pending-user:screen'])

    resetNativeMediaState({
      nativeMicrophoneStartGenerationRef: { current: 1 },
      nativeMicrophoneStartRef: { current: Promise.resolve(true) },
      screenShareStartGenerationRef: { current: 2 },
      screenShareStartingRef: { current: true },
      pendingScreenShareStartRef: {
        current: { quality: 'medium', withAudio: true },
      },
      nativeMicrophoneRef: { current: nativeMicrophone },
      nativeMicrophoneMutedRef: { current: true },
      selfMonitoringRef: {
        current: { active: true, restorePublishing: true, sequence: 4 },
      },
      nativeScreenShareRef: { current: nativeScreenShare },
      stoppedNativeScreenIdentityRef: { current: 'screen-identity' },
      nativeScreenPublicationLossKeyRef: { current: 'loss-key' },
      watchedRemoteScreenIdsRef: { current: watchedRemoteScreenIds },
      pendingScreenWatchIdsRef: { current: pendingScreenWatchIds },
      resetNativeMediaEngineStats,
      getDesktop: () => ({
        platform: { os: 'win32' },
        media: {
          cancelPendingStarts,
          disconnectPreparedScreenSession,
        },
      }),
      clearWatchedScreenIds: true,
      resetStatsWithoutActiveScreen: false,
    })

    expect(nativeMicrophone.disconnect).toHaveBeenCalled()
    expect(nativeScreenShare.stop).toHaveBeenCalled()
    expect(cancelPendingStarts).toHaveBeenCalled()
    expect(disconnectPreparedScreenSession).toHaveBeenCalled()
    expect(resetNativeMediaEngineStats).toHaveBeenCalled()
    expect(watchedRemoteScreenIds.size).toBe(0)
    expect(pendingScreenWatchIds.size).toBe(0)
  })

  it('can reset stats for handoff even without an active native screen session', () => {
    const resetNativeMediaEngineStats = vi.fn()

    resetNativeMediaState({
      nativeMicrophoneStartGenerationRef: { current: 1 },
      nativeMicrophoneStartRef: { current: null },
      screenShareStartGenerationRef: { current: 2 },
      screenShareStartingRef: { current: false },
      pendingScreenShareStartRef: { current: null },
      nativeMicrophoneRef: { current: null },
      nativeMicrophoneMutedRef: { current: false },
      selfMonitoringRef: {
        current: { active: false, restorePublishing: false, sequence: 0 },
      },
      nativeScreenShareRef: { current: null },
      stoppedNativeScreenIdentityRef: { current: null },
      nativeScreenPublicationLossKeyRef: { current: null },
      resetNativeMediaEngineStats,
      getDesktop: () => null,
      clearWatchedScreenIds: false,
      resetStatsWithoutActiveScreen: true,
    })

    expect(resetNativeMediaEngineStats).toHaveBeenCalled()
  })

  it('rolls native microphone mute state back when muting fails', async () => {
    const error = new Error('native mute failed')
    const nativeMicrophoneRef = {
      current: {
        disconnect: vi.fn(),
        setMuted: vi.fn(async () => {
          throw error
        }),
      },
    }
    const nativeMicrophoneMutedRef = { current: false }
    const setMicPublishing = vi.fn()

    await expect(
      setNativeMicrophoneMuted({
        nativeMicrophoneRef,
        nativeMicrophoneMutedRef,
        setMicPublishing,
        setSelfSpeaking: vi.fn(),
        syncRoomParticipants: vi.fn(),
      }, true),
    ).rejects.toBe(error)

    expect(nativeMicrophoneMutedRef.current).toBe(false)
    expect(setMicPublishing).toHaveBeenLastCalledWith(true)
  })

  it('reuses current native LiveKit credentials while the media token is fresh', async () => {
    const current = {
      microphone: {
        url: 'wss://voice',
        token: 'fresh-mic-token',
        participantIdentity: 'user:desktop-native:microphone',
      },
      screen: {
        url: 'wss://voice',
        token: 'fresh-screen-token',
        participantIdentity: 'user:desktop-native:screen',
      },
      camera: {
        url: 'wss://voice',
        token: 'fresh-camera-token',
        participantIdentity: 'user:desktop-native:camera',
      },
    }
    const requestCredentialsRefresh = vi.fn()

    const credentials = await refreshNativeLiveKitCredentials({
      liveKitCredentialsRef: { current },
      channelIdRef: { current: 'voice-a' },
      readCurrentVoiceFlags: () => ({ selfMute: false, selfDeaf: false }),
      shouldRefreshLiveKitToken: () => false,
      runVoiceRequest: vi.fn(),
      requestCredentialsRefresh,
      createOperationId: vi.fn(),
      nativeCredentialsFromJoinResponse: vi.fn(),
      getDesktop: () => null,
    }, 'microphone')

    expect(credentials).toBe(current.microphone)
    expect(requestCredentialsRefresh).not.toHaveBeenCalled()
  })

  it('refreshes native LiveKit credentials and prepares screen credentials on Windows', async () => {
    const next = {
      microphone: {
        url: 'wss://voice',
        token: 'next-mic-token',
        participantIdentity: 'user:desktop-native:microphone',
      },
      screen: {
        url: 'wss://voice',
        token: 'next-screen-token',
        participantIdentity: 'user:desktop-native:screen',
      },
      camera: {
        url: 'wss://voice',
        token: 'next-camera-token',
        participantIdentity: 'user:desktop-native:camera',
      },
    }
    const liveKitCredentialsRef = { current: null }
    const requestCredentialsRefresh = vi.fn(async () => ({ url: 'raw' }))
    const runVoiceRequest = vi.fn(async (_key, request) => request())
    const prepareScreenSession = vi.fn(async () => {})

    const credentials = await refreshNativeLiveKitCredentials({
      liveKitCredentialsRef,
      channelIdRef: { current: 'voice-a' },
      readCurrentVoiceFlags: () => ({ selfMute: true, selfDeaf: false }),
      shouldRefreshLiveKitToken: () => true,
      runVoiceRequest,
      requestCredentialsRefresh,
      createOperationId: () => 'op-refresh',
      nativeCredentialsFromJoinResponse: () => next,
      getDesktop: () => ({
        platform: { os: 'win32' },
        media: {
          cancelPendingStarts: vi.fn(),
          disconnectPreparedScreenSession: vi.fn(),
          prepareScreenSession,
        },
      }),
    }, 'screen', true)

    expect(runVoiceRequest).toHaveBeenCalledWith(
      'voice_refresh:voice-a:native',
      expect.any(Function),
      10_000,
    )
    expect(requestCredentialsRefresh).toHaveBeenCalledWith(
      'voice-a',
      true,
      false,
      'op-refresh',
    )
    expect(liveKitCredentialsRef.current).toBe(next)
    expect(prepareScreenSession).toHaveBeenCalledWith({ livekit: next.screen })
    expect(credentials).toBe(next.screen)
  })

  it('disconnects native media for controlled handoff and resets UI media state', () => {
    const nativeMicrophone = { disconnect: vi.fn() }
    const resetNativeMediaEngineStats = vi.fn()
    const setMicPublishing = vi.fn()
    const setSelfSpeaking = vi.fn()
    const setScreenShareEnabled = vi.fn()
    const setScreenShareStarting = vi.fn()
    const setCameraEnabled = vi.fn()
    const dispatchNativeMedia = vi.fn()

    disconnectNativeMediaForHandoff({
      nativeMicrophoneStartGenerationRef: { current: 1 },
      nativeMicrophoneStartRef: { current: Promise.resolve(true) },
      screenShareStartGenerationRef: { current: 2 },
      screenShareStartingRef: { current: true },
      pendingScreenShareStartRef: {
        current: { quality: 'medium', withAudio: true },
      },
      nativeMicrophoneRef: { current: nativeMicrophone },
      nativeMicrophoneMutedRef: { current: true },
      selfMonitoringRef: {
        current: { active: false, restorePublishing: true, sequence: 7 },
      },
      nativeScreenShareRef: { current: null },
      stoppedNativeScreenIdentityRef: { current: 'screen-identity' },
      nativeScreenPublicationLossKeyRef: { current: 'loss-key' },
      resetNativeMediaEngineStats,
      getDesktop: () => null,
      setMicPublishing,
      setSelfSpeaking,
      setScreenShareEnabled,
      setScreenShareStarting,
      setCameraEnabled,
      dispatchNativeMedia,
    })

    expect(nativeMicrophone.disconnect).toHaveBeenCalled()
    expect(resetNativeMediaEngineStats).toHaveBeenCalled()
    expect(setMicPublishing).toHaveBeenCalledWith(false)
    expect(setSelfSpeaking).toHaveBeenCalledWith(false)
    expect(setScreenShareEnabled).toHaveBeenCalledWith(false)
    expect(setScreenShareStarting).toHaveBeenCalledWith(false)
    expect(setCameraEnabled).toHaveBeenCalledWith(false)
    expect(dispatchNativeMedia).toHaveBeenCalledWith({ type: 'reset' })
  })

  it('reuses an active native microphone session by applying the requested mute state', async () => {
    const room = { localParticipant: {} }
    const activeSession = {
      sessionId: 'native-mic-1',
      channelId: 'voice-a',
      disconnect: vi.fn(),
      setMuted: vi.fn(async () => {}),
    }
    const setNativeMicrophoneMuted = vi.fn(async () => {})
    const publishNativeMicrophone = vi.fn()

    const started = await startNativeMicrophone({
      room,
      muted: true,
      getTargetChannelId: () => 'voice-a',
      isCurrentVoiceSession: () => true,
      nativeMicrophoneRef: { current: activeSession },
      nativeMicrophoneStartRef: { current: null },
      nativeMicrophoneStartGenerationRef: { current: 0 },
      nativeMicrophoneMutedRef: { current: false },
      setNativeMicrophoneMuted,
      publishNativeMicrophone,
      refreshNativeLiveKitCredentials: vi.fn(),
      activeChannelAudioBitrateKbps: () => 64,
      createRequestId: () => 'request-1',
      onNativeMicrophoneStopped: vi.fn(),
      setNativeMicrophoneSession: vi.fn(),
      setMicPublishing: vi.fn(),
      setSelfSpeaking: vi.fn(),
      syncRoomParticipants: vi.fn(),
    })

    expect(started).toBe(true)
    expect(setNativeMicrophoneMuted).toHaveBeenCalledWith(true)
    expect(publishNativeMicrophone).not.toHaveBeenCalled()
  })

  it('reconnects an active native microphone session when the voice channel changes', async () => {
    const room = { localParticipant: {} }
    const activeSession = {
      sessionId: 'native-mic-1',
      channelId: 'voice-a',
      disconnect: vi.fn(),
      setMuted: vi.fn(async () => {}),
      reconnect: vi.fn(async () => {}),
    }
    const refreshNativeLiveKitCredentials = vi.fn(async () => ({
      url: 'wss://voice-b',
      token: 'native-token-b',
      participantIdentity: 'user-a:desktop-native:microphone-b',
    }))
    const setMicPublishing = vi.fn()
    const setSelfSpeaking = vi.fn()
    const syncRoomParticipants = vi.fn()
    const publishNativeMicrophone = vi.fn()

    const started = await startNativeMicrophone({
      room,
      muted: true,
      getTargetChannelId: () => 'voice-b',
      isCurrentVoiceSession: () => true,
      nativeMicrophoneRef: { current: activeSession },
      nativeMicrophoneStartRef: { current: null },
      nativeMicrophoneStartGenerationRef: { current: 0 },
      nativeMicrophoneMutedRef: { current: false },
      setNativeMicrophoneMuted: vi.fn(),
      publishNativeMicrophone,
      refreshNativeLiveKitCredentials,
      activeChannelAudioBitrateKbps: () => 96,
      createRequestId: () => 'request-reconnect',
      onNativeMicrophoneStopped: vi.fn(),
      setNativeMicrophoneSession: vi.fn(),
      setMicPublishing,
      setSelfSpeaking,
      syncRoomParticipants,
    })

    expect(started).toBe(true)
    expect(refreshNativeLiveKitCredentials).toHaveBeenCalledWith('microphone')
    expect(activeSession.reconnect).toHaveBeenCalledWith(
      {
        url: 'wss://voice-b',
        token: 'native-token-b',
        participantIdentity: 'user-a:desktop-native:microphone-b',
      },
      'request-reconnect',
      true,
      96,
    )
    expect(activeSession.channelId).toBe('voice-b')
    expect(setMicPublishing).toHaveBeenCalledWith(false)
    expect(setSelfSpeaking).toHaveBeenCalledWith(false)
    expect(syncRoomParticipants).toHaveBeenCalled()
    expect(publishNativeMicrophone).not.toHaveBeenCalled()
  })

  it('publishes a new native microphone session and syncs participant state', async () => {
    const room = { localParticipant: { identity: 'user-a' } }
    const session = {
      sessionId: 'native-mic-1',
      disconnect: vi.fn(),
      setMuted: vi.fn(),
    }
    const nativeMicrophoneRef: { current: typeof session | null } = {
      current: null,
    }
    const nativeMicrophoneStartRef = { current: null }
    const refreshNativeLiveKitCredentials = vi.fn(async () => ({
      url: 'wss://voice',
      token: 'native-token',
      participantIdentity: 'user-a:desktop-native:microphone',
    }))
    const publishNativeMicrophone = vi.fn(async () => session)
    const setMicPublishing = vi.fn()
    const setSelfSpeaking = vi.fn()
    const syncRoomParticipants = vi.fn()

    const started = await startNativeMicrophone({
      room,
      muted: false,
      getTargetChannelId: () => 'voice-a',
      isCurrentVoiceSession: () => true,
      nativeMicrophoneRef,
      nativeMicrophoneStartRef,
      nativeMicrophoneStartGenerationRef: { current: 0 },
      nativeMicrophoneMutedRef: { current: false },
      setNativeMicrophoneMuted: vi.fn(),
      publishNativeMicrophone,
      refreshNativeLiveKitCredentials,
      activeChannelAudioBitrateKbps: () => 96,
      createRequestId: () => 'request-1',
      onNativeMicrophoneStopped: vi.fn(),
      setNativeMicrophoneSession: (nextSession) => {
        nativeMicrophoneRef.current = nextSession
      },
      setMicPublishing,
      setSelfSpeaking,
      syncRoomParticipants,
    })

    expect(started).toBe(true)
    expect(refreshNativeLiveKitCredentials).toHaveBeenCalledWith('microphone')
    expect(publishNativeMicrophone).toHaveBeenCalledWith(
      room.localParticipant,
      expect.any(Function),
      {
        url: 'wss://voice',
        token: 'native-token',
        participantIdentity: 'user-a:desktop-native:microphone',
      },
      'request-1',
      false,
      96,
    )
    expect(nativeMicrophoneRef.current).toBe(session)
    expect(nativeMicrophoneStartRef.current).toBeNull()
    expect(setMicPublishing).toHaveBeenCalledWith(true)
    expect(setSelfSpeaking).not.toHaveBeenCalled()
    expect(syncRoomParticipants).toHaveBeenCalled()
  })

  it('disconnects a native microphone session that resolves after the voice session becomes stale', async () => {
    const room = { localParticipant: {} }
    const session = {
      sessionId: 'native-mic-1',
      disconnect: vi.fn(),
      setMuted: vi.fn(),
    }
    const isCurrentVoiceSession = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    const setNativeMicrophoneSession = vi.fn()
    const setMicPublishing = vi.fn()
    const syncRoomParticipants = vi.fn()

    const started = await startNativeMicrophone({
      room,
      muted: false,
      getTargetChannelId: () => 'voice-a',
      isCurrentVoiceSession,
      nativeMicrophoneRef: { current: null },
      nativeMicrophoneStartRef: { current: null },
      nativeMicrophoneStartGenerationRef: { current: 0 },
      nativeMicrophoneMutedRef: { current: false },
      setNativeMicrophoneMuted: vi.fn(),
      publishNativeMicrophone: vi.fn(async () => session),
      refreshNativeLiveKitCredentials: vi.fn(async () => ({
        url: 'wss://voice',
        token: 'native-token',
        participantIdentity: 'user-a:desktop-native:microphone',
      })),
      activeChannelAudioBitrateKbps: () => 64,
      createRequestId: () => 'request-1',
      onNativeMicrophoneStopped: vi.fn(),
      setNativeMicrophoneSession,
      setMicPublishing,
      setSelfSpeaking: vi.fn(),
      syncRoomParticipants,
    })

    expect(started).toBe(false)
    expect(session.disconnect).toHaveBeenCalled()
    expect(setNativeMicrophoneSession).not.toHaveBeenCalled()
    expect(setMicPublishing).not.toHaveBeenCalled()
    expect(syncRoomParticipants).not.toHaveBeenCalled()
  })
})
