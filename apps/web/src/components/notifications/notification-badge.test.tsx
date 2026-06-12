// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { NotificationBadge } from './notification-badge'

describe('NotificationBadge', () => {
  afterEach(() => {
    cleanup()
  })

  it('does not render an empty badge', () => {
    const { container } = render(
      <NotificationBadge badge={{ count: 0, hasUnread: false, urgent: false }} />,
    )

    expect(container.firstChild).toBeNull()
  })

  it('renders the notification count', () => {
    render(
      <NotificationBadge badge={{ count: 3, hasUnread: true, urgent: false }} />,
    )

    expect(screen.getByText('3')).toBeTruthy()
  })

  it('caps large notification counts', () => {
    render(
      <NotificationBadge
        badge={{ count: 120, hasUnread: true, urgent: false }}
      />,
    )

    expect(screen.getByText('99+')).toBeTruthy()
  })
})
