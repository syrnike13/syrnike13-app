// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import type { Channel, User } from '@syrnike13/api-types'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceChannelShell } from './voice-channel-shell'
import { syncStore } from '#/features/sync/sync-store'
import { requestVoiceChannelChatOpen } from '#/features/voice/voice-channel-chat-intent'

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
  VoiceStageView: ({
    title,
    headerTrailing,
    chatOpen,
    onToggleChat,
    showChatToggle = true,
  }: {
    title: string
    headerTrailing?: ReactNode
    chatOpen: boolean
    onToggleChat: () => void
    showChatToggle?: boolean
  }) => (
    <div
      data-testid="voice-stage-view"
      data-chat-toggle={showChatToggle ? 'visible' : 'hidden'}
    >
      <span data-testid="voice-stage-title">{title}</span>
      {showChatToggle ? (
        <button type="button" onClick={onToggleChat}>
          {chatOpen ? 'Скрыть чат' : 'Открыть чат'}
        </button>
      ) : null}
      {headerTrailing}
    </div>
  ),
}))

vi.mock('#/components/channels/channel-settings-dialog', () => ({
  ChannelSettingsDialog: ({ channel }: { channel: { _id: string } }) => (
    <button type="button" data-testid="channel-settings-dialog">
      {channel._id}
    </button>
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

function legacyVoiceChannel(): Channel {
  return {
    _id: 'voice-1',
    channel_type: 'VoiceChannel',
    server: 'server-1',
    name: 'Voice',
    default_permissions: null,
    role_permissions: {},
    voice: { max_users: null },
  } as unknown as Channel
}

function renderShell(channel: Channel) {
  syncStore.applyReady({
    users: [currentUser, targetUser],
    servers: [
      {
        _id: 'server-1',
        name: 'Server',
        owner: CURRENT_USER_ID,
        channels: [channel._id],
        default_permissions: 0,
      } as never,
    ],
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

    expect(screen.getByTestId('voice-stage-view').textContent).toContain(
      'test_isa',
    )
  })

  it('renders group calls as a voice stage', () => {
    renderShell(groupChannel())

    expect(screen.getByTestId('voice-stage-view').textContent).toContain(
      'Команда',
    )
  })

  it('opens the side chat panel when a chat open request arrives', () => {
    renderShell(groupChannel())

    expect(screen.queryByTestId('channel-chat-panel')).toBeNull()

    act(() => {
      requestVoiceChannelChatOpen('group-1')
    })

    expect(screen.getByTestId('channel-chat-panel')).toBeTruthy()
  })

  it('opens the side chat panel from a pending request on mount', () => {
    requestVoiceChannelChatOpen('group-1')
    renderShell(groupChannel())

    expect(screen.getByTestId('channel-chat-panel')).toBeTruthy()
  })
  it('passes channel settings into server voice stage actions', () => {
    renderShell(legacyVoiceChannel())

    expect(screen.getByTestId('voice-stage-title').textContent).toBe('Voice')
    expect(
      screen.getByTestId('voice-stage-view').getAttribute('data-chat-toggle'),
    ).toBe('hidden')
    expect(screen.getByTestId('channel-settings-dialog').textContent).toBe(
      'voice-1',
    )
  })
})
