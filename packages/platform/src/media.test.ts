import { describe, expectTypeOf, it } from 'vitest'

import type { NativeMediaSession, NativeMediaSessionStartOptions } from './media'

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
})
