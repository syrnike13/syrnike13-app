import { describe, expectTypeOf, it } from 'vitest'

import type {
  NativeMediaEngineSessionSummary,
  NativeMediaEchoCancellationMode,
  NativeMediaNoiseSuppressionMode,
  NativeMicrophoneRuntimeConfig,
  NativeMediaSession,
  NativeMediaMicrophoneSessionStartOptions,
  NativeMediaSessionStartOptions,
} from './media'

describe('native media session contract', () => {
  it('models screen audio as part of the session request and response', () => {
    expectTypeOf<NativeMediaSessionStartOptions>().toMatchTypeOf<{
      kind: 'screen'
      sourceId: string
      audioBitrate?: number
      audio?: {
        requested: boolean
      }
    }>()

    expectTypeOf<NativeMediaSession>().toMatchTypeOf<{
      kind: 'screen'
      audio?: {
        mode: 'process' | 'system_exclude' | 'none'
        port?: number
      }
    }>()

    expectTypeOf<NativeMediaSessionStartOptions>().not.toHaveProperty('withAudio')
    expectTypeOf<NativeMediaSession>().not.toHaveProperty('audioPort')
    expectTypeOf<NativeMediaSession>().not.toHaveProperty('audioMode')
  })

  it('models active session audio in the engine snapshot contract', () => {
    expectTypeOf<NativeMediaEngineSessionSummary>().toMatchTypeOf<{
      kind: 'screen'
      sessionId: string
      audio?: {
        mode: 'process' | 'system_exclude' | 'none'
        port?: number
      }
    }>()
  })

  it('models microphone capture as a native media session', () => {
    expectTypeOf<NativeMediaSessionStartOptions>().toMatchTypeOf<
      | {
          kind: 'screen'
        }
      | {
          kind: 'microphone'
          deviceId?: string
          sampleRate: 48000
          channels: 1
          noiseSuppression: boolean
          echoCancellation: boolean
          inputVolume: number
          audioBitrate?: number
          muted?: boolean
          livekit: {
            url: string
            token: string
            participantIdentity: string
          }
        }
    >()

    expectTypeOf<NativeMediaSession>().toMatchTypeOf<
      | {
          kind: 'screen'
        }
      | {
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
        }
    >()
  })

  it('models separate microphone processing toggles and statuses', () => {
    const microphoneStart = {
      kind: 'microphone',
      sampleRate: 48_000,
      channels: 1,
      noiseSuppression: true,
      echoCancellation: false,
      inputVolume: 1,
      livekit: {
        url: 'wss://example.test',
        token: 'token',
        participantIdentity: 'native-user',
      },
    } satisfies NativeMediaMicrophoneSessionStartOptions

    const runtimeConfig = {
      noiseSuppression: false,
      echoCancellation: true,
    } satisfies NativeMicrophoneRuntimeConfig

    const noiseStatus: NativeMediaNoiseSuppressionMode = 'software'
    const echoStatus: NativeMediaEchoCancellationMode = 'unavailable'

    expectTypeOf(microphoneStart.noiseSuppression).toEqualTypeOf<boolean>()
    expectTypeOf(runtimeConfig.echoCancellation).toEqualTypeOf<boolean | undefined>()
    expectTypeOf(noiseStatus).toEqualTypeOf<NativeMediaNoiseSuppressionMode>()
    expectTypeOf(echoStatus).toEqualTypeOf<NativeMediaEchoCancellationMode>()
  })
})
