// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { Channel, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceChannelShell } from './voice-channel-shell'
import { syncStore } from '#/features/sync/sync-store'

const CURRENT_USER_ID = 'current-user'
const TARGET_USER_ID = 'target-user'

const currentUser = {
  _id: CURRENT_USER_ID,
  username: 'me',
  discriminator: '0001',
  relationship: 'User',
  online: true,
} as User

const targetUser = {
  _id: TARGET_USER_ID,
  username: 'test_isa',
  discriminator: '0002',
  relationship: 'Friend',
  online: true,
} as User

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    user: currentUser,
    session: { token: 'session-token' },
  }),
}))

vi.mock('#/components/voice/voice-stage-view', () => ({
  VoiceStageView: ({ title }: { title: string }) => (
    <div data-testid="voice-stage-view">{title}</div>
  ),
}))

vi.mock('#/components/chat/channel-chat-panel', () => ({
  ChannelChatPanel: () => <div data-testid="channel-chat-panel" />,
}))

function directMessageChannel(): Channel {
  return {
    _id: 'dm-1',
    channel_type: 'DirectMessage',
    active: true,
    recipients: [CURRENT_USER_ID, TARGET_USER_ID],
  } as Channel
}

function groupChannel(): Channel {
  return {
    _id: 'group-1',
    channel_type: 'Group',
    active: true,
    name: 'Команда',
    owner: CURRENT_USER_ID,
    description: null,
    recipients: [CURRENT_USER_ID, TARGET_USER_ID],
    icon: null,
    last_message_id: null,
    permissions: null,
    nsfw: false,
  } as Channel
}

function renderShell(channel: Channel) {
  syncStore.applyReady({
    users: [currentUser, targetUser],
    servers: [],
    channels: [channel],
    members: [],
    emojis: [],
    channel_unreads: [],
    voice_states: [],
  })

  render(<VoiceChannelShell channelId={channel._id} />)
}

describe('VoiceChannelShell', () => {
  beforeEach(() => {
    syncStore.reset()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('renders direct message calls as a voice stage', () => {
    renderShell(directMessageChannel())

    expect(screen.getByTestId('voice-stage-view').textContent).toBe('test_isa')
  })

  it('renders group calls as a voice stage', () => {
    renderShell(groupChannel())

    expect(screen.getByTestId('voice-stage-view').textContent).toBe('Команда')
  })
})
