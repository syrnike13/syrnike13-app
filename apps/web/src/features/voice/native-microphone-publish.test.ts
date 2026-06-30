import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readVoicePreferences } from '#/features/voice/voice-preference-store'
import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  configureNativeMicrophoneSession,
  nativeMicrophoneSessionOptions,
  publishNativeMicrophone,
  shouldUseNativeMicrophone,
  shouldRestartNativeMicrophonePublisher,
} from './native-microphone-publish'

vi.mock('livekit-client', () => ({
  AudioPresets: {
    speech: 'speech',
  },
  LocalAudioTrack: vi.fn(function LocalAudioTrack(track: MediaStreamTrack) {
    return { mediaStreamTrack: track }
  }),
  ScreenSharePresets: {
    h1080fps30: {
      encoding: {},
      resolution: { width: 1920, height: 1080, frameRate: 30 },
    },
  },
  Track: {
    Source: {
      Microphone: 'microphone',
    },
  },
}))

vi.mock('#/platform/runtime', () => ({
  getSyrnikeDesktop: vi.fn(() => null),
}))

vi.mock('#/features/voice/voice-preference-store', () => ({
  readVoicePreferences: vi.fn(),
}))

function preferences() {
  return {
    preferredAudioInputDevice: 'mic-1',
    preferredAudioOutputDevice: 'speaker-1',
    preferredVideoDevice: undefined,
    micEnabled: true,
    deafened: false,
    cameraEnabled: false,
    screenShareEnabled: false,
    screenShareQuality: 'high',
    screenShareCodec: 'auto',
    screenShareAudio: true,
    screenShareCaptureMode: 'auto',
    noiseSuppression: true,
    echoCancellation: true,
    voiceGateEnabled: true,
    voiceGateThresholdDb: -45,
    voiceGateAutoThreshold: false,
    inputVolume: 0.75,
    outputVolume: 0.5,
  } as const
}

describe('native microphone publish', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function AudioContext() {
        return {
          close: vi.fn(async () => {}),
        }
      }),
    )
    vi.mocked(getSyrnikeDesktop).mockReturnValue(null)
    vi.mocked(readVoicePreferences).mockReturnValue(preferences())
  })

  it('builds native microphone session options from voice preferences', () => {
    expect(
      nativeMicrophoneSessionOptions({
        ...preferences(),
        voiceGateAutoThreshold: true,
      }, {
        url: 'wss://livekit.example',
        token: 'livekit-token',
        participantIdentity: 'user-1:desktop-native',
      }, 'mic-request-1', undefined, false, 48),
    ).toEqual({
      kind: 'microphone',
      requestId: 'mic-request-1',
      deviceId: 'mic-1',
      sampleRate: 48_000,
      channels: 1,
      audioBitrate: 48_000,
      noiseSuppression: true,
      echoCancellation: true,
      inputVolume: 0.75,
      voiceGateEnabled: true,
      voiceGateThresholdDb: -45,
      voiceGateAutoThreshold: true,
      muted: false,
      livekit: {
        url: 'wss://livekit.example',
        token: 'livekit-token',
        participantIdentity: 'user-1:desktop-native',
      },
    })
  })

  it('detects Windows desktop as native microphone runtime', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    expect(shouldUseNativeMicrophone()).toBe(true)
  })

  it('starts native microphone publisher without creating a renderer audio track', async () => {
    const stopSession = vi.fn(async () => {})
    const startSession = vi.fn(async () => ({
      kind: 'microphone',
      sessionId: 'native-mic-1',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
    }))
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession,
        stopSession,
        setMicrophoneMuted: vi.fn(async () => {}),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const participant = {
      identity: 'user-1',
      publishTrack: vi.fn(),
      unpublishTrack: vi.fn(),
    }

    const session = await publishNativeMicrophone(participant as never, undefined, {
      url: 'wss://livekit.example',
      token: 'native-livekit-token',
      participantIdentity: 'user-1:desktop-native',
    }, 'mic-request-1', false, 32)

    expect(session.nativeParticipantIdentity).toBe(
      'user-1:desktop-native:native-mic-1',
    )
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'microphone',
        requestId: 'mic-request-1',
        audioBitrate: 32_000,
        livekit: {
          url: 'wss://livekit.example',
          token: 'native-livekit-token',
          participantIdentity: 'user-1:desktop-native',
        },
      }),
    )
    expect(participant.publishTrack).not.toHaveBeenCalled()
    expect(participant.unpublishTrack).not.toHaveBeenCalled()
  })

  it('disconnects native microphone publisher without touching local LiveKit tracks', async () => {
    const stopSession = vi.fn(async () => {})
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession: vi.fn(async () => ({
          kind: 'microphone',
          sessionId: 'native-mic-1',
          audio: {
            mode: 'microphone',
            sampleRate: 48_000,
            channels: 1,
            noiseSuppression: 'software',
            echoCancellation: 'software',
          },
          nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
        })),
        stopSession,
        setMicrophoneMuted: vi.fn(async () => {}),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const participant = {
      identity: 'user-1',
      publishTrack: vi.fn(),
      unpublishTrack: vi.fn(),
    }
    const onStopped = vi.fn()

    const session = await publishNativeMicrophone(participant as never, onStopped, {
      url: 'wss://livekit.example',
      token: 'native-livekit-token',
      participantIdentity: 'user-1:desktop-native',
    }, 'mic-request-1')
    session.disconnect()

    expect(stopSession).toHaveBeenCalledWith('native-mic-1')
    expect(participant.publishTrack).not.toHaveBeenCalled()
    expect(participant.unpublishTrack).not.toHaveBeenCalled()
    expect(onStopped).toHaveBeenCalledWith('native-mic-1')
  })

  it('notifies when the native microphone session disconnects after publishing', async () => {
    const stopSession = vi.fn(async () => {})
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession: vi.fn(async () => ({
          kind: 'microphone',
          sessionId: 'native-mic-1',
          audio: {
            mode: 'microphone',
            sampleRate: 48_000,
            channels: 1,
            noiseSuppression: 'software',
            echoCancellation: 'software',
          },
          nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
        })),
        stopSession,
        setMicrophoneMuted: vi.fn(async () => {}),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const participant = {
      identity: 'user-1',
      publishTrack: vi.fn(),
      unpublishTrack: vi.fn(),
    }
    const onStopped = vi.fn()

    const session = await publishNativeMicrophone(
      participant as never,
      onStopped,
      {
        url: 'wss://livekit.example',
        token: 'native-livekit-token',
        participantIdentity: 'user-1:desktop-native',
      },
      'mic-request-1',
    )
    session.disconnect()

    expect(stopSession).toHaveBeenCalledWith('native-mic-1')
    expect(onStopped).toHaveBeenCalledWith('native-mic-1')
  })

  it('mutes native microphone publisher without stopping capture', async () => {
    const stopSession = vi.fn(async () => {})
    const setMicrophoneMuted = vi.fn(async () => {})
    const startSession = vi.fn(async () => ({
      kind: 'microphone',
      sessionId: 'native-mic-1',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
    }))
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession,
        stopSession,
        setMicrophoneMuted,
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const session = await publishNativeMicrophone(
      { identity: 'user-1' } as never,
      undefined,
      {
        url: 'wss://livekit.example',
        token: 'native-livekit-token',
        participantIdentity: 'user-1:desktop-native',
      },
      'mic-request-1',
      true,
    )

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'microphone', muted: true }),
    )

    await session.setMuted(false)

    expect(setMicrophoneMuted).toHaveBeenCalledWith('native-mic-1', false)
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('reconnects native microphone publisher through desktop media without stopping capture', async () => {
    const stopSession = vi.fn(async () => {})
    const reconnectMicrophoneSession = vi.fn(async () => ({
      kind: 'microphone',
      sessionId: 'native-mic-1',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1-reconnected',
    }))
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession: vi.fn(async () => ({
          kind: 'microphone',
          sessionId: 'native-mic-1',
          audio: {
            mode: 'microphone',
            sampleRate: 48_000,
            channels: 1,
            noiseSuppression: 'software',
            echoCancellation: 'software',
          },
          nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
        })),
        stopSession,
        setMicrophoneMuted: vi.fn(async () => {}),
        reconnectMicrophoneSession,
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const session = await publishNativeMicrophone(
      { identity: 'user-1' } as never,
      undefined,
      {
        url: 'wss://livekit-a.example',
        token: 'native-livekit-token-a',
        participantIdentity: 'user-1:desktop-native:a',
      },
      'mic-request-1',
      false,
      32,
    )

    await session.reconnect(
      {
        url: 'wss://livekit-b.example',
        token: 'native-livekit-token-b',
        participantIdentity: 'user-1:desktop-native:b',
      },
      'mic-request-2',
      true,
      48,
    )

    expect(reconnectMicrophoneSession).toHaveBeenCalledWith(
      'native-mic-1',
      expect.objectContaining({
        kind: 'microphone',
        requestId: 'mic-request-2',
        muted: true,
        audioBitrate: 48_000,
        livekit: {
          url: 'wss://livekit-b.example',
          token: 'native-livekit-token-b',
          participantIdentity: 'user-1:desktop-native:b',
        },
      }),
    )
    expect(session.nativeParticipantIdentity).toBe(
      'user-1:desktop-native:native-mic-1-reconnected',
    )
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('notifies once when the native media engine stops the microphone session', async () => {
    const stopSession = vi.fn(async () => {})
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
          kind: 'microphone',
          sessionId: 'native-mic-1',
          audio: {
            mode: 'microphone',
            sampleRate: 48_000,
            channels: 1,
            noiseSuppression: 'software',
            echoCancellation: 'software',
          },
          nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
        })),
        stopSession,
        setMicrophoneMuted: vi.fn(async () => {}),
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

    const onStopped = vi.fn()
    const session = await publishNativeMicrophone(
      { identity: 'user-1' } as never,
      onStopped,
      {
        url: 'wss://livekit.example',
        token: 'native-livekit-token',
        participantIdentity: 'user-1:desktop-native',
      },
      'mic-request-1',
    )

    onStreamEndedHandler?.('other-session')
    expect(onStopped).not.toHaveBeenCalled()

    onStreamErrorHandler?.({
      sessionId: 'native-mic-1',
      message: 'capture failed',
    })
    onStreamEndedHandler?.('native-mic-1')
    onSidecarLostHandler?.({
      sessionId: 'native-mic-1',
      message: 'sidecar exited',
    })

    expect(onStopped).toHaveBeenCalledTimes(1)
    expect(onStopped).toHaveBeenCalledWith('native-mic-1')
    expect(unsubscribeEnded).toHaveBeenCalledTimes(1)
    expect(unsubscribeError).toHaveBeenCalledTimes(1)
    expect(unsubscribeSidecar).toHaveBeenCalledTimes(1)

    session.disconnect()
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('restarts native microphone only while the user still wants to publish', () => {
    expect(
      shouldRestartNativeMicrophonePublisher({
        voiceConnected: true,
        wantsMic: true,
        deafened: false,
        selfMonitoringActive: false,
      }),
    ).toBe(true)

    expect(
      shouldRestartNativeMicrophonePublisher({
        voiceConnected: false,
        wantsMic: true,
        deafened: false,
        selfMonitoringActive: false,
      }),
    ).toBe(false)
    expect(
      shouldRestartNativeMicrophonePublisher({
        voiceConnected: true,
        wantsMic: false,
        deafened: false,
        selfMonitoringActive: false,
      }),
    ).toBe(false)
    expect(
      shouldRestartNativeMicrophonePublisher({
        voiceConnected: true,
        wantsMic: true,
        deafened: true,
        selfMonitoringActive: false,
      }),
    ).toBe(false)
    expect(
      shouldRestartNativeMicrophonePublisher({
        voiceConnected: true,
        wantsMic: true,
        deafened: false,
        selfMonitoringActive: true,
      }),
    ).toBe(false)
  })

  it('debounces runtime config updates for native microphone publishing', async () => {
    vi.useFakeTimers()
    const configureMicrophoneRuntime = vi.fn(async () => {})
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        configureMicrophoneRuntime,
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)

    const session = {
      sessionId: 'native-mic-1',
      nativeParticipantIdentity: 'user-1:desktop-native',
      setMuted: vi.fn(async () => {}),
      reconnect: vi.fn(async () => {}),
      disconnect: vi.fn(),
    }

    configureNativeMicrophoneSession(session, {
      ...preferences(),
      voiceGateThresholdDb: -32,
    })
    configureNativeMicrophoneSession(session, {
      ...preferences(),
      inputVolume: 1.8,
      voiceGateEnabled: false,
      voiceGateAutoThreshold: true,
    })
    await vi.advanceTimersByTimeAsync(39)

    expect(configureMicrophoneRuntime).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(configureMicrophoneRuntime).toHaveBeenCalledTimes(1)
    expect(configureMicrophoneRuntime).toHaveBeenCalledWith(
      'native-mic-1',
      expect.objectContaining({
        inputVolume: 1.8,
        noiseSuppression: true,
        voiceGateEnabled: false,
        voiceGateAutoThreshold: true,
      }),
    )
  })
})

describe('native microphone provider boundary', () => {
  it('routes Windows desktop microphone toggles before LiveKit browser capture', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const source = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )
    const localSetupSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-local-setup.ts'),
      'utf8',
    )

    const nativeBranchIndex = localSetupSource.indexOf(
      'if (deps.shouldUseNativeMicrophone)',
    )
    const liveKitCaptureIndex = localSetupSource.indexOf(
      'await room.localParticipant.setMicrophoneEnabled(',
    )

    expect(nativeBranchIndex).toBeGreaterThanOrEqual(0)
    expect(liveKitCaptureIndex).toBeGreaterThan(nativeBranchIndex)
    expect(source).toContain('finishLocalVoiceSetup as finishLocalVoiceSetupFromDeps')
    expect(localSetupSource).toContain('await deps.startNativeMicrophone(')
    expect(source).toContain('setNativeMicrophoneMuted')
    expect(source).toContain('nativeMicrophoneMutedRef.current')
    expect(localSetupSource).toContain('!deps.shouldUseNativeMicrophone')
    expect(localSetupSource).toContain(
      'await deps.applyMicProcessing(room.localParticipant)',
    )
  })

  it('temporarily suspends voice publishing while settings self-monitoring is active', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )
    const localSetupSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-local-setup.ts'),
      'utf8',
    )
    const contextSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-context.ts'),
      'utf8',
    )
    const settingsSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/components/settings/settings-voice-panel.tsx'),
      'utf8',
    )

    expect(contextSource).toContain(
      'setSelfMonitoringActive: (active: boolean) => void',
    )
    expect(providerSource).toContain(
      'selfMonitoringActive: selfMonitoringRef.current.active',
    )
    expect(localSetupSource).toContain(
      'deps.selfMonitoringActive && prefs.micEnabled',
    )
    expect(providerSource).toContain(
      'selfMonitoringRef.current.restorePublishing = wantsMic',
    )
    expect(providerSource).toContain('void setNativeMicrophoneMuted(true)')
    expect(providerSource).toContain('void startNativeMicrophone(room, true)')
    expect(providerSource).toContain('syncVoiceFlagsToGateway(activeChannelId, true')
    expect(settingsSource).toContain(
      'setSelfMonitoringActiveRef.current(micTestActive)',
    )
  })

  it('repairs a stopped native microphone publisher without leaving the room', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )

    expect(providerSource).toContain('shouldRestartNativeMicrophonePublisher')
    expect(providerSource).toContain("statusRef.current === 'connected'")
    expect(providerSource).toContain('void startNativeMicrophone(room, false)')
    expect(providerSource).toContain('syncVoiceFlagsToGateway(')
  })

  it('coalesces concurrent native microphone starts before publishing resolves', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )
    const nativeMediaSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-native-media.ts'),
      'utf8',
    )

    expect(providerSource).toContain(
      'const nativeMicrophoneStartRef = useRef<Promise<boolean> | null>(null)',
    )
    expect(providerSource).toContain('startNativeMicrophoneFromDeps({')
    expect(providerSource).toContain('getTargetChannelId: () => channelIdRef.current')
    expect(nativeMediaSource).toContain(
      'const targetChannelId = deps.getTargetChannelId()',
    )
    expect(nativeMediaSource).toContain(
      'if (!started || !deps.isCurrentVoiceSession(deps.room, targetChannelId))',
    )
    expect(nativeMediaSource).toContain(
      'const pendingNativeMicrophoneStart = deps.nativeMicrophoneStartRef.current',
    )
    expect(nativeMediaSource).toContain('await pendingNativeMicrophoneStart')
    expect(nativeMediaSource).toContain('deps.nativeMicrophoneStartRef.current = start')
  })

  it('suppresses native microphone stop side effects during controlled voice disconnects', () => {
    const repoRoot = resolve(
      fileURLToPath(new URL('../../../../..', import.meta.url)),
    )
    const providerSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-provider.tsx'),
      'utf8',
    )
    const nativeMediaSource = readFileSync(
      resolve(repoRoot, 'apps/web/src/features/voice/voice-native-media.ts'),
      'utf8',
    )

    const controlledStops = nativeMediaSource.match(
      /const activeNativeMicrophone = deps\.nativeMicrophoneRef\.current[\s\S]*?deps\.nativeMicrophoneRef\.current = null[\s\S]*?activeNativeMicrophone\.disconnect\(\)/g,
    )

    expect(providerSource).toContain('resetNativeMediaState({')
    expect(controlledStops).toHaveLength(1)
  })
})
