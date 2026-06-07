import { describe, expectTypeOf, it } from 'vitest'

import type {
  NativeMediaEngineSessionSummary,
  NativeMediaSession,
  NativeMediaSessionStartOptions,
} from './media'

describe('native media session contract', () => {
  it('models screen audio as part of the session request and response', () => {
    expectTypeOf<NativeMediaSessionStartOptions>().toMatchTypeOf<{
      kind: 'screen'
      sourceId: string
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

  it('models microphone capture as a native media session with DeepFilterNet3', () => {
    expectTypeOf<NativeMediaSessionStartOptions>().toMatchTypeOf<
      | {
          kind: 'screen'
        }
      | {
          kind: 'microphone'
          deviceId?: string
          sampleRate: 48000
          channels: 1
          echoCancellation: boolean
          noiseSuppression: 'disabled' | 'deep_filter_net3'
          inputVolume: number
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
            port: number
            sampleRate: 48000
            channels: 1
            noiseSuppression: 'disabled' | 'deep_filter_net3'
          }
        }
    >()
  })
})
