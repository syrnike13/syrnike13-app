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

import { ChannelSearchDialog } from '#/components/chat/channel-search-dialog'
import { syncStore } from '#/features/sync/sync-store'

const navigateMock = vi.hoisted(() => vi.fn())
const searchChannelMessagesMock = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '/app',
}))

vi.mock('#/features/api/messages-api', () => ({
  searchChannelMessages: searchChannelMessagesMock,
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

describe('ChannelSearchDialog', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('shows attachment-only channel search results instead of a no-text placeholder', async () => {
    searchChannelMessagesMock.mockResolvedValue({
      messages: [message()],
      users: [],
    })

    render(
      <ChannelSearchDialog
        channelId="channel-1"
        token="token"
        users={users}
        variant="strip"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    fireEvent.change(
      screen.getByPlaceholderText('Поиск по сообщениям…'),
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
