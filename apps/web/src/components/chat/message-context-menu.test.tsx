// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Message } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
}))

vi.mock('#/components/chat/message-action-copy', () => ({
  copyMessageActionValue: (...args: [string, string]) => mocks.copy(...args),
}))

vi.mock('#/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

const { MessageContextMenu } = await import(
  '#/components/chat/message-context-menu'
)

describe('MessageContextMenu', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('provides Discord-style actions for own text messages', () => {
    const onReply = vi.fn()
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const onPin = vi.fn()
    const message = {
      _id: 'message-1',
      channel: 'channel-1',
      author: 'user-1',
      content: 'context me',
    } as Message

    render(
      <MessageContextMenu
        message={message}
        channelId="channel-1"
        own
        canDelete
        onReply={onReply}
        onEdit={onEdit}
        onDelete={onDelete}
        onPin={onPin}
      >
        <article>context me</article>
      </MessageContextMenu>,
    )

    expect(screen.getByText('Ответить')).toBeTruthy()
    expect(screen.getByText('Копировать текст')).toBeTruthy()
    expect(screen.getByText('Копировать ID')).toBeTruthy()
    expect(screen.getByText('Копировать ссылку')).toBeTruthy()
    expect(screen.getByText('Закрепить')).toBeTruthy()
    expect(screen.getByText('Изменить')).toBeTruthy()
    expect(screen.getByText('Удалить')).toBeTruthy()

    fireEvent.click(screen.getByText('Ответить'))
    fireEvent.click(screen.getByText('Изменить'))
    fireEvent.click(screen.getByText('Закрепить'))
    fireEvent.click(screen.getByText('Удалить'))
    fireEvent.click(screen.getByText('Копировать текст'))

    expect(onReply).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onPin).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(mocks.copy).toHaveBeenCalledWith('Текст скопирован', 'context me')
  })
})
