// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Channel, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IncomingVoiceCallOverlay } from './incoming-voice-call-overlay'
import { syncStore } from '#/features/sync/sync-store'

const CURRENT_USER_ID = 'current-user'
const CALLER_ID = 'caller-user'
const SECOND_CALLER_ID = 'second-caller-user'
const CHANNEL_ID = 'dm-1'
const GROUP_CHANNEL_ID = 'group-1'
const voiceJoinMock = vi.hoisted(() => vi.fn())
const navigateMock = vi.hoisted(() => vi.fn())
const cancelDirectMessageCallMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)

const currentUser = {
  _id: CURRENT_USER_ID,
  username: 'me',
  discriminator: '0001',
  relationship: 'User',
  online: true,
} as User

const caller = {
  _id: CALLER_ID,
  username: 'test_isa',
  discriminator: '0002',
  relationship: 'Friend',
  online: true,
} as User

const secondCaller = {
  _id: SECOND_CALLER_ID,
  username: 'another_isa',
  discriminator: '0003',
  relationship: 'Friend',
  online: true,
} as User

const dmChannel = {
  _id: CHANNEL_ID,
  channel_type: 'DirectMessage',
  active: true,
  recipients: [CURRENT_USER_ID, CALLER_ID],
} as Channel

const groupChannel = {
  _id: GROUP_CHANNEL_ID,
  channel_type: 'Group',
  active: true,
  recipients: [CURRENT_USER_ID, CALLER_ID, 'third-user'],
  name: 'Команда',
  owner: CALLER_ID,
  description: null,
  icon: null,
  last_message_id: null,
  permissions: null,
  nsfw: false,
} as Channel

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    user: currentUser,
    session: { token: 'session-token' },
  }),
}))

vi.mock('#/features/voice/voice-context', () => ({
  useVoice: () => ({
    channelId: null,
    status: 'idle',
    join: voiceJoinMock,
  }),
}))

vi.mock('#/features/api/channels-api', () => ({
  cancelDirectMessageCall: cancelDirectMessageCallMock,
}))

describe('IncomingVoiceCallOverlay', () => {
  beforeEach(() => {
    syncStore.reset()
    voiceJoinMock.mockReset()
    voiceJoinMock.mockResolvedValue(true)
    navigateMock.mockClear()
    cancelDirectMessageCallMock.mockClear()
    syncStore.applyReady({
      users: [currentUser, caller],
      servers: [],
      channels: [dmChannel],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
      voice_calls: [
        {
          channel_id: CHANNEL_ID,
          initiator_id: CALLER_ID,
          phase: 'Ringing',
          started_at: '2026-06-12T10:00:00.000Z',
          recipients: [CURRENT_USER_ID],
        },
      ],
    } as never)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('shows an incoming direct call globally and lets the user answer or cancel it', async () => {
    render(<IncomingVoiceCallOverlay />)

    expect(screen.getByText('Личный звонок')).toBeTruthy()
    expect(screen.getByText('test_isa звонит')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))

    expect(voiceJoinMock).toHaveBeenCalledWith(CHANNEL_ID)
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/app/c/$channelId',
        params: { channelId: CHANNEL_ID },
        search: { m: undefined },
      })
    })
  })

  it('does not navigate when answering fails to join the call', async () => {
    voiceJoinMock.mockResolvedValueOnce(false)

    render(<IncomingVoiceCallOverlay />)

    fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))

    await waitFor(() => {
      expect(voiceJoinMock).toHaveBeenCalledWith(CHANNEL_ID)
    })
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('cancels one-to-one calls when the user declines', () => {
    render(<IncomingVoiceCallOverlay />)

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))

    expect(cancelDirectMessageCallMock).toHaveBeenCalledWith(
      'session-token',
      CHANNEL_ID,
    )
  })

  it('removes one-to-one calls after a successful cancel', async () => {
    const view = render(<IncomingVoiceCallOverlay />)

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(() => {
      expect(screen.queryByText('test_isa звонит')).toBeNull()
    })

    view.unmount()
    render(<IncomingVoiceCallOverlay />)

    expect(screen.queryByText('test_isa звонит')).toBeNull()
  })

  it('keeps one-to-one calls visible when cancel fails', async () => {
    cancelDirectMessageCallMock.mockRejectedValueOnce(new Error('boom'))

    render(<IncomingVoiceCallOverlay />)

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))

    await waitFor(() => {
      expect(cancelDirectMessageCallMock).toHaveBeenCalledWith(
        'session-token',
        CHANNEL_ID,
      )
    })
    expect(screen.getByText('test_isa звонит')).toBeTruthy()
  })

  it('only hides group calls when the user declines', () => {
    syncStore.applyReady({
      users: [currentUser, caller],
      servers: [],
      channels: [groupChannel],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
      voice_calls: [
        {
          channel_id: GROUP_CHANNEL_ID,
          initiator_id: CALLER_ID,
          phase: 'Ringing',
          started_at: '2026-06-12T10:00:00.000Z',
          recipients: [CURRENT_USER_ID],
        },
      ],
    } as never)

    render(<IncomingVoiceCallOverlay />)

    expect(screen.getByText('Групповой звонок')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Скрыть' }))

    expect(cancelDirectMessageCallMock).not.toHaveBeenCalled()
    expect(screen.queryByText('test_isa звонит')).toBeNull()
  })

  it('skips the active channel call and shows another incoming call', () => {
    syncStore.applyReady({
      users: [currentUser, caller, secondCaller],
      servers: [],
      channels: [
        dmChannel,
        {
          ...groupChannel,
          recipients: [CURRENT_USER_ID, SECOND_CALLER_ID, 'third-user'],
        },
      ],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
      voice_calls: [
        {
          channel_id: CHANNEL_ID,
          initiator_id: CALLER_ID,
          phase: 'Ringing',
          started_at: '2026-06-12T10:00:00.000Z',
          recipients: [CURRENT_USER_ID],
        },
        {
          channel_id: GROUP_CHANNEL_ID,
          initiator_id: SECOND_CALLER_ID,
          phase: 'Ringing',
          started_at: '2026-06-12T10:00:01.000Z',
          recipients: [CURRENT_USER_ID],
        },
      ],
    } as never)

    render(<IncomingVoiceCallOverlay activeChannelId={CHANNEL_ID} />)

    expect(screen.queryByText('test_isa звонит')).toBeNull()
    expect(screen.getByText('another_isa звонит')).toBeTruthy()
    expect(screen.getByText('Команда')).toBeTruthy()
  })
})
