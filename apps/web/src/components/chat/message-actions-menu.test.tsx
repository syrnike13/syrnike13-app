// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Message } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageActionsMenu } from '#/components/chat/message-actions-menu'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/lib/clipboard', () => ({
  writeClipboardText: vi.fn(),
}))

function message(overrides: Partial<Message> = {}) {
  return {
    _id: 'message-1',
    channel: 'channel-1',
    author: 'user-1',
    content: 'hello',
    ...overrides,
  } satisfies Message
}

function renderMenu(
  props: Partial<Parameters<typeof MessageActionsMenu>[0]> = {},
) {
  return render(
    <MessageActionsMenu
      message={message({ reactions: { '😀': ['user-1'] } })}
      channelId="channel-1"
      own={false}
      onReply={vi.fn()}
      {...props}
    />,
  )
}

describe('MessageActionsMenu', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('clears reactions when the action is available', () => {
    const onClearReactions = vi.fn()

    renderMenu({ onClearReactions })

    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(screen.getByRole('button', { name: 'Очистить реакции' }))

    expect(onClearReactions).toHaveBeenCalledOnce()
  })

  it('requests closing the menu after choosing an action', () => {
    const onOpenChange = vi.fn()
    const onReply = vi.fn()

    renderMenu({ open: true, onOpenChange, onReply })

    fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))

    expect(onReply).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not show clear reactions for messages without reactions', () => {
    renderMenu({
      message: message({ reactions: {} }),
      onClearReactions: vi.fn(),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))

    expect(
      screen.queryByRole('button', { name: 'Очистить реакции' }),
    ).toBeNull()
  })
})
