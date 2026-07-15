// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { UserProfileStatusBubble } from '#/components/user/user-profile-status-bubble'

describe('UserProfileStatusBubble', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the trimmed status text', () => {
    const { container } = render(
      <UserProfileStatusBubble status="  тест статус  " />,
    )

    expect(screen.getByText('тест статус')).toBeTruthy()
    expect(container.querySelectorAll('.gradient-surface-solid')).toHaveLength(3)
    expect(container.querySelector('.gradient-surface-floating')).toBeNull()
  })

  it('renders nothing for empty or missing status', () => {
    const { container } = render(<UserProfileStatusBubble status="   " />)
    expect(container.firstChild).toBeNull()

    const { container: empty } = render(<UserProfileStatusBubble />)
    expect(empty.firstChild).toBeNull()
  })
})
