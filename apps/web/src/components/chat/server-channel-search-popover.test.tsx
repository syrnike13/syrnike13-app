// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { File, Message, User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ServerChannelSearchPopover } from '#/components/chat/server-channel-search-popover'
import { syncStore } from '#/features/sync/sync-store'

const navigateMock = vi.hoisted(() => vi.fn())
const searchServerMessagesMock = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ user: { _id: 'current-user' } }),
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '/app',
}))

vi.mock('#/features/search/server-message-search', () => ({
  searchServerMessages: searchServerMessagesMock,
}))

function fileAttachment(overrides: Partial<File> = {}) {
  return {
    _id: 'file-1',
    tag: 'attachments',
    filename: 'brief.pdf',
    content_type: 'application/pdf',
    size: 2048,
    metadata: {
      type: 'File',
    },
    ...overrides,
  } satisfies File
}

function message(overrides: Partial<Message> = {}) {
  return {
    _id: 'message-1',
    channel: 'channel-1',
    author: 'author-user',
    content: null,
    attachments: [fileAttachment()],
    ...overrides,
  } as Message
}

const users = {
  'author-user': {
    _id: 'author-user',
    username: 'author',
    online: true,
  } as User,
}

describe('ServerChannelSearchPopover', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('shows attachment-only server search results instead of a no-text placeholder', async () => {
    searchServerMessagesMock.mockResolvedValue({
      hits: [
        {
          channelId: 'channel-1',
          channelLabel: '#general',
          message: message(),
        },
      ],
      users: [],
    })

    render(
      <ServerChannelSearchPopover
        serverId="server-1"
        token="token"
        users={users}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    fireEvent.change(
      screen.getByPlaceholderText('Поиск по серверу…'),
      {
        target: { value: 'brief' },
      },
    )

    await waitFor(() => {
      expect(screen.getByText('brief.pdf')).toBeTruthy()
    })
    expect(screen.queryByText('[без текста]')).toBeNull()
  })
})
