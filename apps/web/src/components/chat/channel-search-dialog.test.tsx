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
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SEARCH_AT = Date.UTC(2026, 5, 19, 12, 30)

function ulidAt(timeMs: number, tail: string) {
  let value = timeMs
  let timestamp = ''

  for (let index = 0; index < 10; index += 1) {
    timestamp = ULID_ENCODING[value % 32]! + timestamp
    value = Math.floor(value / 32)
  }

  return `${timestamp}${tail.padEnd(16, '0')}`.slice(0, 26)
}

const SEARCH_MESSAGE_ID = ulidAt(SEARCH_AT, 'SEARCHMSG1234567')
const SEARCH_TIMESTAMP = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}).format(new Date(SEARCH_AT))

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
    _id: SEARCH_MESSAGE_ID,
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
    expect(screen.getByText(SEARCH_TIMESTAMP)).toBeTruthy()
    expect(screen.queryByText('[без текста]')).toBeNull()
  })

  it('shows a BOT badge next to bot channel search result authors', async () => {
    searchChannelMessagesMock.mockResolvedValue({
      messages: [
        message({
          author: 'bot-user',
          content: 'deploy complete',
          attachments: [],
        }),
      ],
      users: [],
    })

    render(
      <ChannelSearchDialog
        channelId="channel-1"
        token="token"
        users={{
          'bot-user': {
            _id: 'bot-user',
            username: 'deploybot',
            online: true,
            bot: { owner: 'owner-user' },
          } as User,
        }}
        variant="strip"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    fireEvent.change(
      screen.getByPlaceholderText('Поиск по сообщениям…'),
      {
        target: { value: 'deploy' },
      },
    )

    await waitFor(() => {
      expect(screen.getByText('deploy complete')).toBeTruthy()
    })
    expect(screen.getByText('BOT')).toBeTruthy()
  })
})
