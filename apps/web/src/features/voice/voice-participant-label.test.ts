import type { User } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'

const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const REMOTE_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6ZZ'

function testUser(fields: Pick<User, '_id'> & Partial<User>): User {
  return fields as User
}

describe('voiceParticipantDisplayName', () => {
  it('uses the signed-in profile for the local user', () => {
    expect(
      voiceParticipantDisplayName(
        USER_ID,
        {},
        testUser({
          _id: USER_ID,
          username: 'tiredisa',
          display_name: 'Isa',
        }),
      ),
    ).toBe('Isa')
  })

  it('falls back to Участник for unknown remote users', () => {
    expect(voiceParticipantDisplayName(REMOTE_USER_ID, {})).toBe(
      'Участник',
    )
  })

  it('uses display_name for known remote users', () => {
    expect(
      voiceParticipantDisplayName(REMOTE_USER_ID, {
        [REMOTE_USER_ID]: testUser({
          _id: REMOTE_USER_ID,
          username: 'remote_user',
          display_name: 'Remote User',
        }),
      }),
    ).toBe('Remote User')
  })

  it('falls back to username for known remote users without display_name', () => {
    expect(
      voiceParticipantDisplayName(REMOTE_USER_ID, {
        [REMOTE_USER_ID]: testUser({
          _id: REMOTE_USER_ID,
          username: 'remote_user',
        }),
      }),
    ).toBe('remote_user')
  })
})
