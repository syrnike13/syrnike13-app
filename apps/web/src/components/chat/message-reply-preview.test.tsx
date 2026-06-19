// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { Message, User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it } from 'vitest'

import { InlineReplyQuote } from '#/components/chat/message-reply-preview'
import { syncStore } from '#/features/sync/sync-store'

describe('InlineReplyQuote', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('renders readable mention labels in the reply snippet', () => {
    const author = {
      _id: 'author-user',
      username: 'author',
      online: true,
    } as User
    const mentioned = {
      _id: 'mentioned-user',
      username: 'maria',
      display_name: 'Maria',
      online: true,
    } as User
    const original = {
      _id: 'message-1',
      channel: 'channel-1',
      author: author._id,
      content: 'hello <@mentioned-user> <%role-1> <#channel-2>',
    } as Message

    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-user',
      channels: ['channel-1', 'channel-2'],
      default_permissions: 0,
      roles: {
        'role-1': {
          _id: 'role-1',
          name: 'Moderators',
          permissions: { a: 0, d: 0 },
          rank: 1,
        },
      },
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-2',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'general',
    } as never)

    render(
      <InlineReplyQuote
        replyId={original._id}
        messagesById={{ [original._id]: original }}
        users={{ [author._id]: author, [mentioned._id]: mentioned }}
        serverId="server-1"
      />,
    )

    const snippet = screen.getByText(/hello/)

    expect(snippet.textContent).toContain('@Maria')
    expect(snippet.textContent).toContain('@Moderators')
    expect(snippet.textContent).toContain('#general')
    expect(snippet.textContent).not.toContain('<@mentioned-user>')
    expect(snippet.textContent).not.toContain('<%role-1>')
    expect(snippet.textContent).not.toContain('<#channel-2>')
  })
})
