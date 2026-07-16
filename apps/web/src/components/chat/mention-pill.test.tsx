// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MentionPill } from './mention-pill'
import { MessageUserMention } from './message-user-mention'

describe('MentionPill', () => {
  afterEach(cleanup)

  it.each(['@alice', '@everyone', '@moderators', '#general'])(
    'renders the explicit inline label %s exactly once',
    (label) => {
      render(<MentionPill label={label} />)
      expect(screen.getByText(label).textContent).toBe(label)
    },
  )

  it('uses the server nickname in the non-interactive composer atom', () => {
    render(
      <MessageUserMention
        userId="user-id"
        user={{ _id: 'user-id', username: 'global-name' } as never}
        member={{ nickname: 'server-name' } as never}
        interactive={false}
      />,
    )

    expect(screen.getByText('@server-name')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
