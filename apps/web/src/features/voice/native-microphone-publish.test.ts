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
      nativeMicrophoneSessionOptions(preferences(), {
        url: 'wss://livekit.example',
        token: 'livekit-token',
        participantIdentity: 'user-1:desktop-native',
      }),
    ).toEqual({
      kind: 'microphone',
      deviceId: 'mic-1',
      sampleRate: 48_000,
      channels: 1,
      echoCancellation: true,
      inputVolume: 0.75,
      voiceGateEnabled: true,
      voiceGateThresholdDb: -45,
      voiceGateAutoThreshold: false,
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
        echoCancellation: 'windows',
      },
      nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
    }))
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession,
        stopSession,
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
    })

    expect(session.nativeParticipantIdentity).toBe(
      'user-1:desktop-native:native-mic-1',
    )
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'microphone',
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

  it('stops native microphone publisher without touching local LiveKit tracks', async () => {
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
            echoCancellation: 'windows',
          },
          nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
        })),
        stopSession,
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
    })
    session.stop()

    expect(stopSession).toHaveBeenCalledWith('native-mic-1')
    expect(participant.publishTrack).not.toHaveBeenCalled()
    expect(participant.unpublishTrack).not.toHaveBeenCalled()
    expect(onStopped).toHaveBeenCalledWith('native-mic-1')
  })

  it('notifies when the native microphone session stops after publishing', async () => {
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
            echoCancellation: 'windows',
          },
          nativeParticipantIdentity: 'user-1:desktop-native:native-mic-1',
        })),
        stopSession,
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
    )
    session.stop()

    expect(stopSession).toHaveBeenCalledWith('native-mic-1')
    expect(onStopped).toHaveBeenCalledWith('native-mic-1')
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
      stop: vi.fn(),
    }

    configureNativeMicrophoneSession(session, {
      ...preferences(),
      voiceGateThresholdDb: -32,
    })
    configureNativeMicrophoneSession(session, {
      ...preferences(),
      inputVolume: 1.8,
      voiceGateEnabled: false,
    })
    await vi.advanceTimersByTimeAsync(39)

    expect(configureMicrophoneRuntime).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(configureMicrophoneRuntime).toHaveBeenCalledTimes(1)
    expect(configureMicrophoneRuntime).toHaveBeenCalledWith(
      'native-mic-1',
      expect.objectContaining({
        inputVolume: 1.8,
        voiceGateEnabled: false,
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

    const nativeBranchIndex = source.indexOf('if (shouldUseNativeMicrophone())')
    const liveKitCaptureIndex = source.indexOf(
      '.setMicrophoneEnabled(nextMic, undefined, voiceMicPublishOptions())',
    )

    expect(nativeBranchIndex).toBeGreaterThanOrEqual(0)
    expect(liveKitCaptureIndex).toBeGreaterThan(nativeBranchIndex)
    expect(source).toContain('await startNativeMicrophone(room)')
    expect(source).toContain('stopNativeMicrophone()')
    expect(source).toContain('!shouldUseNativeMicrophone()')
    expect(source).toContain('await applyMicProcessing(room.localParticipant)')
  })
})
