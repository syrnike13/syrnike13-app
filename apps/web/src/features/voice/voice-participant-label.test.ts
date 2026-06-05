import { describe, expect, it } from 'vitest'

import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'

const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'

describe('voiceParticipantDisplayName', () => {
  it('uses the signed-in profile for the local user', () => {
    expect(
      voiceParticipantDisplayName(
        USER_ID,
        {},
        {
          _id: USER_ID,
          username: 'tiredisa',
          display_name: 'Isa',
        } as never,
      ),
    ).toBe('Isa')
  })

  it('falls back to Участник for unknown remote users', () => {
    expect(voiceParticipantDisplayName('01KT7DEM3B0T4B0BXGBXWDJ6ZZ', {})).toBe(
      'Участник',
    )
  })
})
