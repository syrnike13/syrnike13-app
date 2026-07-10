import { describe, expectTypeOf, it } from 'vitest'

import type {
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
})
