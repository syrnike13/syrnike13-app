import { describe, expect, it } from 'vitest'

import { mergeSpeakingUserIds } from '#/features/voice/voice-speaking-users'

describe('mergeSpeakingUserIds', () => {
  it('keeps self speaking when remote speaking ids change', () => {
    const merged = mergeSpeakingUserIds({
      remoteUserIds: new Set(['remote-user']),
      selfUserId: 'self-user',
      selfSpeaking: true,
    })

    expect(Array.from(merged).sort()).toEqual(['remote-user', 'self-user'])
  })

  it('removes only self when self stops speaking', () => {
    const merged = mergeSpeakingUserIds({
      remoteUserIds: new Set(['self-user', 'remote-user']),
      selfUserId: 'self-user',
      selfSpeaking: false,
    })

    expect(Array.from(merged)).toEqual(['remote-user'])
  })
})
