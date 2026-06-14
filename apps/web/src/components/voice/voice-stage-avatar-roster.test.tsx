// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it } from 'vitest'

import { VoiceStageAvatarRoster } from '#/components/voice/voice-stage-avatar-roster'
import type { UserVoiceState } from '#/features/sync/voice-types'

const user = {
  _id: 'user-1',
  username: 'isa',
  display_name: 'исочка',
} as User

const participant: UserVoiceState = {
  id: 'user-1',
  joined_at: 1,
  self_mute: false,
  self_deaf: false,
  server_muted: false,
  server_deafened: false,
  camera: false,
  screensharing: false,
  version: 0,
}

describe('VoiceStageAvatarRoster', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders participant avatars without names or tile chrome', () => {
    render(
      <VoiceStageAvatarRoster
        participants={[participant]}
        users={{ 'user-1': user }}
        speakingUserIds={new Set(['user-1'])}
        displayName={() => 'исочка'}
        speakingEnabled
      />,
    )

    expect(screen.queryByText('исочка')).toBeNull()
    expect(document.querySelector('.aspect-video')).toBeNull()
  })

  it('shows mute status as an avatar badge', () => {
    render(
      <VoiceStageAvatarRoster
        participants={[{ ...participant, self_mute: true }]}
        users={{ 'user-1': user }}
        speakingUserIds={new Set()}
        displayName={() => 'исочка'}
        speakingEnabled
      />,
    )

    expect(screen.getByLabelText('Микрофон выключен')).toBeTruthy()
  })
})
