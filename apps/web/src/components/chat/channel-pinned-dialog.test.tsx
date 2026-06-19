// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChannelPinnedDialog } from '#/components/chat/channel-pinned-dialog'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: [
      {
        _id: 'message-1',
        author: 'author-user',
        channel: 'channel-1',
        content: 'pinned text',
      },
    ],
    error: null,
    isError: false,
    isFetching: false,
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '/app',
}))

vi.mock('#/lib/clipboard', () => ({
  writeClipboardText: (value: string) => mocks.writeClipboardText(value),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

describe('ChannelPinnedDialog', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows a BOT badge only next to bot pinned message authors', () => {
    const { rerender } = render(
      <ChannelPinnedDialog
        channelId="channel-1"
        token="token"
        users={{
          'author-user': {
            _id: 'author-user',
            online: true,
            username: 'deploybot',
            display_name: 'Deploy Bot',
            bot: { owner: 'owner-user' },
          } as never,
        }}
      />,
    )

    expect(screen.getByText('BOT')).toBeTruthy()

    rerender(
      <ChannelPinnedDialog
        channelId="channel-1"
        token="token"
        users={{
          'author-user': {
            _id: 'author-user',
            online: true,
            username: 'alice',
            display_name: 'Alice',
            bot: null,
          } as never,
        }}
      />,
    )

    expect(screen.queryByText('BOT')).toBeNull()
  })

  it('copies a message id without jumping to the pinned message', async () => {
    render(
      <ChannelPinnedDialog
        channelId="channel-1"
        token="token"
        users={{
          'author-user': {
            _id: 'author-user',
            online: true,
            username: 'author',
          } as never,
        }}
      />,
    )

    const copyButton = screen
      .getAllByRole('button')
      .find(
        (button) =>
          button.tagName === 'BUTTON' && button.textContent?.includes('ID'),
      )
    expect(copyButton).toBeDefined()

    fireEvent.click(copyButton!)

    await waitFor(() =>
      expect(mocks.writeClipboardText).toHaveBeenCalledWith('message-1'),
    )
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
