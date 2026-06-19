// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageComposer } from '#/components/chat/message-composer'
import type { ComposerEditorHandle } from '#/components/chat/composer-editor'

vi.mock('#/components/chat/composer-editor', () => ({
  ComposerEditor: forwardRef<
    ComposerEditorHandle,
    {
      disabled?: boolean
      onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
      onValueChange: (value: string) => void
      placeholder?: string
      value: string
    }
  >(function MockComposerEditor(
    { disabled, onKeyDown, onValueChange, placeholder, value },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      clear: vi.fn(),
      focus: vi.fn(),
      insertCustomEmoji: vi.fn(),
      insertText: vi.fn(),
    }))

    return (
      <textarea
        aria-label="message composer"
        disabled={disabled}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        value={value}
      />
    )
  }),
}))

vi.mock('#/components/chat/composer-emoji-picker', () => ({
  ComposerEmojiPicker: () => null,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    gatewayState: 'connected',
    user: { _id: 'current-user', username: 'current' },
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

describe('MessageComposer replies', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('sends reply mentions as metadata instead of visible message text', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)

    render(
      <MessageComposer
        channel={{
          _id: 'channel-1',
          channel_type: 'TextChannel',
          name: 'general',
          server: 'server-1',
        } as never}
        token="token"
        users={{
          'author-user': {
            _id: 'author-user',
            online: true,
            username: 'author',
          } as never,
        }}
        replyTo={{
          _id: 'reply-message',
          author: 'author-user',
          channel: 'channel-1',
          content: 'original',
        } as never}
        onSend={onSend}
      />,
    )

    fireEvent.change(screen.getByLabelText('message composer'), {
      target: { value: 'hello back' },
    })
    fireEvent.keyDown(screen.getByLabelText('message composer'), {
      key: 'Enter',
    })

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect(onSend).toHaveBeenCalledWith({
      content: 'hello back',
      attachments: undefined,
      replies: [{ id: 'reply-message', mention: true }],
    })
  })

  it('does not mention the current user when replying to self', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)

    render(
      <MessageComposer
        channel={{
          _id: 'channel-1',
          channel_type: 'TextChannel',
          name: 'general',
          server: 'server-1',
        } as never}
        token="token"
        users={{
          'current-user': {
            _id: 'current-user',
            online: true,
            username: 'current',
          } as never,
        }}
        replyTo={{
          _id: 'reply-message',
          author: 'current-user',
          channel: 'channel-1',
          content: 'my own original',
        } as never}
        onSend={onSend}
      />,
    )

    fireEvent.change(screen.getByLabelText('message composer'), {
      target: { value: 'note to self' },
    })
    fireEvent.keyDown(screen.getByLabelText('message composer'), {
      key: 'Enter',
    })

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect(onSend).toHaveBeenCalledWith({
      content: 'note to self',
      attachments: undefined,
      replies: [{ id: 'reply-message', mention: false }],
    })
  })
})
