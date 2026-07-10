import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  LocalMediaIntent,
  LocalMediaIntentAcceptanceResult,
  LocalMediaObservedStateEvent,
  NativeMediaEngineSessionSummary,
  NativeMediaEchoCancellationMode,
  NativeMediaMicrophoneSession,
  NativeMediaNoiseSuppressionMode,
  NativeMediaStatsEvent,
  NativeMicrophonePipelineConfig,
  NativeMediaSession,
  NativeMediaMicrophoneSessionStartOptions,
  NativeMediaScreenSession,
  NativeMediaScreenSessionStartOptions,
  NativeMediaSessionStartOptions,
} from './media'
import type { SyrnikeDesktopApi } from './api'
import {
  parseLocalMediaIntent,
  parseLocalMediaIntentAcceptanceResult,
  parseLocalMediaObservedStateEvent,
} from './media'

describe('native media session contract', () => {
  it('models screen audio as part of the session request and response', () => {
    type ScreenStartOptions = Extract<
      NativeMediaSessionStartOptions,
      { kind: 'screen' }
    >
    type ScreenSession = Extract<NativeMediaSession, { kind: 'screen' }>

    expectTypeOf<ScreenStartOptions>().toEqualTypeOf<
      NativeMediaScreenSessionStartOptions
    >()
    expectTypeOf<ScreenStartOptions>().toMatchTypeOf<{
      kind: 'screen'
      requestId: string
      sourceId: string
      audioBitrate?: number
      audio?: {
        requested: boolean
      }
    }>()

    expectTypeOf<ScreenSession>().toEqualTypeOf<NativeMediaScreenSession>()
    expectTypeOf<ScreenSession>().toMatchTypeOf<{
      kind: 'screen'
      audio?: {
        mode: 'process' | 'system_exclude' | 'none'
      }
    }>()

    expectTypeOf<NativeMediaSessionStartOptions>().not.toHaveProperty('withAudio')
    expectTypeOf<NativeMediaSession>().not.toHaveProperty('audioPort')
    expectTypeOf<NativeMediaSession>().not.toHaveProperty('audioMode')
    expectTypeOf<ScreenSession>().not.toHaveProperty('port')
    expectTypeOf<NonNullable<ScreenSession['audio']>>().not.toHaveProperty('port')
  })

  it('models active session audio in the engine snapshot contract', () => {
    type ScreenSummary = Extract<
      NativeMediaEngineSessionSummary,
      { kind: 'screen' }
    >

    expectTypeOf<ScreenSummary>().toMatchTypeOf<{
      kind: 'screen'
      sessionId: string
      audio?: {
        mode: 'process' | 'system_exclude' | 'none'
      }
    }>()
  })

  it('models native screen capture bottleneck stats', () => {
    const event = {
      sessionId: 'screen-session-1',
      methods: {
        wgc: 120,
        dxgi: 0,
        gdi_blt: 0,
      },
      activeMethod: 'wgc',
      videoFrames: 120,
      videoIntervalFrames: 60,
      videoLateFrames: 1,
      videoNoFrameCount: 2,
      videoRepeatedFrameCount: 3,
      videoRecoverableLostCount: 1,
      videoAvgCaptureUs: 3200,
      videoAvgReadbackUs: 1100,
      videoAvgScaleUs: 900,
      videoAvgPublishUs: 700,
      videoSourceWidth: 2560,
      videoSourceHeight: 1440,
      videoContentWidth: 1920,
      videoContentHeight: 1080,
      captureThreadMmcss: true,
    } satisfies NativeMediaStatsEvent

    expectTypeOf<
      NativeMediaStatsEvent['videoNoFrameCount']
    >().toEqualTypeOf<number | undefined>()
    expectTypeOf<
      NativeMediaStatsEvent['videoAvgReadbackUs']
    >().toEqualTypeOf<number | undefined>()
    expectTypeOf<
      NativeMediaStatsEvent['videoAvgScaleUs']
    >().toEqualTypeOf<number | undefined>()
    expectTypeOf<
      NativeMediaStatsEvent['videoAvgPublishUs']
    >().toEqualTypeOf<number | undefined>()
    expectTypeOf<
      NativeMediaStatsEvent['captureThreadMmcss']
    >().toEqualTypeOf<boolean | undefined>()
  })

  it('models microphone capture as a native media session', () => {
    type MicrophoneStartOptions = Extract<
      NativeMediaSessionStartOptions,
      { kind: 'microphone' }
    >
    type MicrophoneSession = Extract<
      NativeMediaSession,
      { kind: 'microphone' }
    >

    expectTypeOf<MicrophoneStartOptions>().toEqualTypeOf<
      NativeMediaMicrophoneSessionStartOptions
    >()
    expectTypeOf<MicrophoneStartOptions>().toMatchTypeOf<{
      kind: 'microphone'
      requestId: string
      audioBitrate?: number
      muted?: boolean
      livekit: {
        url: string
        token: string
        participantIdentity: string
      }
    }>()

    expectTypeOf<MicrophoneSession>().toEqualTypeOf<NativeMediaMicrophoneSession>()
    expectTypeOf<MicrophoneSession>().toMatchTypeOf<{
      kind: 'microphone'
      sessionId: string
      audio: {
        mode: 'microphone'
        sampleRate: 48000
        channels: 1
        noiseSuppression: 'disabled' | 'software' | 'unavailable'
        echoCancellation: 'disabled' | 'software' | 'unavailable'
      }
      nativeParticipantIdentity: string
    }>()

    expectTypeOf<NativeMediaSessionStartOptions>().toMatchTypeOf<
      | {
          kind: 'screen'
        }
      | {
          kind: 'microphone'
        }
    >()
  })

  it('models separate microphone processing toggles and statuses', () => {
    const microphoneStart = {
      kind: 'microphone',
      requestId: 'mic-request-1',
      livekit: {
        url: 'wss://example.test',
        token: 'token',
        participantIdentity: 'native-user',
      },
    } satisfies NativeMediaMicrophoneSessionStartOptions

    const pipelineConfig = {
      deviceId: 'microphone-1',
      noiseSuppression: false,
      echoCancellation: true,
      inputVolume: 0.75,
      voiceGateEnabled: true,
      voiceGateThresholdDb: -24,
      voiceGateAutoThreshold: false,
    } satisfies NativeMicrophonePipelineConfig

    const noiseStatus: NativeMediaNoiseSuppressionMode = 'software'
    const echoStatus: NativeMediaEchoCancellationMode = 'unavailable'

    expectTypeOf<
      NativeMediaMicrophoneSessionStartOptions['audioBitrate']
    >().toEqualTypeOf<number | undefined>()
    expectTypeOf<
      NativeMicrophonePipelineConfig['echoCancellation']
    >().toEqualTypeOf<boolean>()
    expectTypeOf<
      NativeMicrophonePipelineConfig['deviceId']
    >().toEqualTypeOf<string | null>()
    expectTypeOf<
      NativeMicrophonePipelineConfig['voiceGateAutoThreshold']
    >().toEqualTypeOf<boolean>()
    expectTypeOf(pipelineConfig.inputVolume).toEqualTypeOf<number>()
    expectTypeOf<NativeMediaNoiseSuppressionMode>().toEqualTypeOf<
      'disabled' | 'software' | 'unavailable'
    >()
    expectTypeOf<NativeMediaEchoCancellationMode>().toEqualTypeOf<
      'disabled' | 'software' | 'unavailable'
    >()
    expectTypeOf(noiseStatus).toMatchTypeOf<NativeMediaNoiseSuppressionMode>()
    expectTypeOf(echoStatus).toMatchTypeOf<NativeMediaEchoCancellationMode>()
  })

  it('models immutable local media intent, acceptance, and observed state', () => {
    expectTypeOf<LocalMediaIntent>().toMatchTypeOf<{
      operationId: string | null
      envelopeRevision: number
      microphone:
        | { revision: number; state: 'off' }
        | { revision: number; state: 'retain'; muted: boolean }
        | {
            revision: number
            state: 'publish'
            muted: boolean
            audioBitrateKbps: number
            credentials: {
              url: string
              token: string
              participantIdentity: string
            }
          }
      screen:
        | { revision: number; state: 'off' }
        | {
            revision: number
            state: 'prepare' | 'publish'
            credentials: {
              url: string
              token: string
              participantIdentity: string
            }
            source: {
              sourceId: string
              width: number
              height: number
              fps: number
              bitrate: number
              audioBitrate: number
              audioRequested: boolean
            }
          }
    }>()

    expectTypeOf<LocalMediaIntentAcceptanceResult>().toMatchTypeOf<{
      operationId: string | null
      acceptedEnvelopeRevision: number
      disposition: 'accepted' | 'duplicate'
    }>()

    expectTypeOf<LocalMediaObservedStateEvent>().toMatchTypeOf<
      | {
          kind: 'microphone'
          operationId: string | null
          revision: number
          reconcileAttempt: number
        }
      | {
          kind: 'screen'
          operationId: string | null
          revision: number
          reconcileAttempt: number
        }
    >()
  })

  it('validates local media intent payloads at runtime', () => {
    const parsed = parseLocalMediaIntent({
      operationId: 'voice-op-1',
      envelopeRevision: 4,
      microphone: {
        revision: 8,
        state: 'publish',
        muted: false,
        audioBitrateKbps: 96,
        credentials: {
          url: 'wss://example.test',
          token: 'token',
          participantIdentity: 'user:desktop-native:voice-op-1:microphone',
        },
      },
      screen: {
        revision: 3,
        state: 'prepare',
        credentials: {
          url: 'wss://example.test',
          token: 'token',
          participantIdentity: 'user:desktop-native:voice-op-1:screen',
        },
        source: {
          sourceId: 'window:42',
          width: 1_920,
          height: 1_080,
          fps: 60,
          bitrate: 8_000_000,
          audioBitrate: 128_000,
          audioRequested: true,
        },
      },
    })

    expect(parsed.envelopeRevision).toBe(4)
    expect(() =>
      parseLocalMediaIntent({
        operationId: 'voice-op-1',
        envelopeRevision: -1,
        microphone: {
          revision: 1,
          state: 'retain',
          muted: true,
        },
        screen: {
          revision: 0,
          state: 'off',
        },
      }),
    ).toThrow(/envelopeRevision/)
  })

  it('validates local media acceptance payloads at runtime', () => {
    const parsed = parseLocalMediaIntentAcceptanceResult({
      operationId: null,
      acceptedEnvelopeRevision: 7,
      disposition: 'duplicate',
    })

    expect(parsed.disposition).toBe('duplicate')
    expect(() =>
      parseLocalMediaIntentAcceptanceResult({
        operationId: '',
        acceptedEnvelopeRevision: 7,
        disposition: 'accepted',
      }),
    ).toThrow(/operationId/)
  })

  it('validates local media observed state payloads at runtime', () => {
    const parsed = parseLocalMediaObservedStateEvent({
      kind: 'screen',
      operationId: 'voice-op-2',
      revision: 11,
      reconcileAttempt: 5,
      sequence: 12,
      state: 'published',
      source: {
        sourceId: 'screen:main',
        width: 1_920,
        height: 1_080,
        fps: 60,
        bitrate: 8_000_000,
        audioBitrate: 128_000,
        audioRequested: true,
      },
      participantIdentity: 'user:desktop-native:screen-2',
    })

    expect(parsed.kind).toBe('screen')
    expect(() =>
      parseLocalMediaObservedStateEvent({
        kind: 'microphone',
        operationId: 'voice-op-2',
        revision: 11,
        reconcileAttempt: 5,
        sequence: 13,
        state: 'error',
        muted: false,
        audioBitrateKbps: 96,
        participantIdentity: 'user:desktop-native:microphone-2',
        errorCode: '',
        errorMessage: 'publish failed',
        errorStage: 'publish',
        retryable: true,
      }),
    ).toThrow(/errorCode/)
  })

  it('replaces imperative publication methods on the desktop media api', () => {
    type DesktopMediaApi = SyrnikeDesktopApi['media']

    expectTypeOf<DesktopMediaApi>().toHaveProperty('applyLocalMediaIntent')
    expectTypeOf<DesktopMediaApi>().toHaveProperty('onLocalMediaState')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('prepareScreenSession')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('disconnectPreparedScreenSession')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('startSession')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('cancelPendingStarts')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('setMicrophoneMuted')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('reconnectMicrophoneSession')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('stopSession')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('onStateChange')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('onStreamEnded')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('onStreamError')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('onRuntimeLost')
  })
})
