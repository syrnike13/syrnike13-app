import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createNativeAudioTrack } from '#/features/voice/native-screen-share-audio-bridge'
import { readVoicePreferences } from '#/features/voice/voice-preference-store'
import { getSyrnikeDesktop } from '#/platform/runtime'

import {
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

vi.mock('#/features/voice/native-screen-share-audio-bridge', () => ({
  createNativeAudioTrack: vi.fn(),
}))

vi.mock('#/features/voice/voice-preference-store', () => ({
  readVoicePreferences: vi.fn(),
}))

vi.mock('#/features/voice/voice-mic-processor', () => ({
  createMicProcessorConfigFromPrefs: vi.fn((prefs) => ({
    gateEnabled: true,
    gateThresholdDb: prefs.voiceGateThresholdDb,
    gateAutoThreshold: prefs.voiceGateAutoThreshold,
    gateStageOptions: prefs.voiceGateAutoThreshold
      ? { autoDynamic: true }
      : { manualThresholdDb: prefs.voiceGateThresholdDb },
    inputVolume: prefs.inputVolume,
  })),
  SyrnikeMicProcessor: vi.fn(function SyrnikeMicProcessor() {
    return {
      processedTrack: undefined,
      init: vi.fn(async function init(
        this: { processedTrack?: MediaStreamTrack },
        options: { track: MediaStreamTrack },
      ) {
        this.processedTrack = options.track
      }),
      destroy: vi.fn(async () => {}),
    }
  }),
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

function mediaTrack() {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack
}

describe('native microphone publish', () => {
  beforeEach(() => {
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
    vi.mocked(createNativeAudioTrack).mockReset()
  })

  it('builds native microphone session options from voice preferences', () => {
    expect(nativeMicrophoneSessionOptions(preferences())).toEqual({
      kind: 'microphone',
      deviceId: 'mic-1',
      sampleRate: 48_000,
      channels: 1,
      echoCancellation: true,
      inputVolume: 0.75,
    })
  })

  it('detects Windows desktop as native microphone runtime', () => {
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
    } as ReturnType<typeof getSyrnikeDesktop>)

    expect(shouldUseNativeMicrophone()).toBe(true)
  })

  it('cleans up native session when LiveKit publish fails', async () => {
    const stopSession = vi.fn(async () => {})
    const track = mediaTrack()
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession: vi.fn(async () => ({
          kind: 'microphone',
          sessionId: 'native-mic-1',
          audio: {
            mode: 'microphone',
            port: 49152,
            sampleRate: 48_000,
            channels: 1,
          },
        })),
        stopSession,
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)
    vi.mocked(createNativeAudioTrack).mockResolvedValue({
      track,
      stop: vi.fn(),
    })

    const participant = {
      publishTrack: vi.fn(async () => {
        throw new Error('publish failed')
      }),
      unpublishTrack: vi.fn(),
    }

    await expect(
      publishNativeMicrophone(participant as never),
    ).rejects.toThrow('publish failed')

    expect(track.stop).toHaveBeenCalledOnce()
    expect(stopSession).toHaveBeenCalledWith('native-mic-1')
    expect(participant.unpublishTrack).toHaveBeenCalledOnce()
  })

  it('publishes the native audio track as the LiveKit microphone source', async () => {
    const track = mediaTrack()
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession: vi.fn(async () => ({
          kind: 'microphone',
          sessionId: 'native-mic-1',
          audio: {
            mode: 'microphone',
            port: 49152,
            sampleRate: 48_000,
            channels: 1,
          },
        })),
        stopSession: vi.fn(async () => {}),
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)
    vi.mocked(createNativeAudioTrack).mockResolvedValue({
      track,
      stop: vi.fn(),
    })

    const participant = {
      publishTrack: vi.fn(async () => ({ trackSid: 'TR_native_mic' })),
      unpublishTrack: vi.fn(),
    }

    const session = await publishNativeMicrophone(participant as never)

    expect(session.publicationId).toBe('TR_native_mic')
    expect(participant.publishTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaStreamTrack: track,
      }),
      expect.objectContaining({
        source: 'microphone',
        dtx: true,
      }),
    )
  })

  it('notifies when the native microphone session stops after publishing', async () => {
    const stopSession = vi.fn(async () => {})
    const bridgeStop = vi.fn()
    const track = mediaTrack()
    vi.mocked(getSyrnikeDesktop).mockReturnValue({
      platform: { os: 'win32' },
      media: {
        startSession: vi.fn(async () => ({
          kind: 'microphone',
          sessionId: 'native-mic-1',
          audio: {
            mode: 'microphone',
            port: 49152,
            sampleRate: 48_000,
            channels: 1,
          },
        })),
        stopSession,
      },
    } as unknown as ReturnType<typeof getSyrnikeDesktop>)
    vi.mocked(createNativeAudioTrack).mockResolvedValue({
      track,
      stop: bridgeStop,
    })

    const participant = {
      publishTrack: vi.fn(async () => ({ trackSid: 'TR_native_mic' })),
      unpublishTrack: vi.fn(),
    }
    const onStopped = vi.fn()

    const session = await publishNativeMicrophone(
      participant as never,
      onStopped,
    )
    session.stop()

    expect(bridgeStop).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(stopSession).toHaveBeenCalledWith('native-mic-1')
    expect(onStopped).toHaveBeenCalledWith('native-mic-1')
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
