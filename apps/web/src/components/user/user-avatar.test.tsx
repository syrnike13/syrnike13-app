// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { User } from '@syrnike13/api-types'
import type { ReactNode } from 'react'

import { UserAvatar } from '#/components/user/user-avatar'

vi.mock('#/components/ui/avatar', () => ({
  Avatar: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => <div className={className}>{children}</div>,
  AvatarImage: ({
    src,
    alt,
    className,
  }: {
    src: string
    alt: string
    className?: string
  }) => <img src={src} alt={alt} className={className} />,
  AvatarFallback: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}))

const baseUser = {
  _id: 'user-1',
  username: 'alice',
  discriminator: '0001',
  avatar: {
    _id: 'avatar-1',
    tag: 'avatars',
    filename: 'avatar.gif',
    content_type: 'image/gif',
    size: 1024,
    metadata: {
      type: 'Image',
      width: 128,
      height: 128,
      animated: true,
    },
  },
  relationship: 'None',
  online: true,
} as const satisfies User

function user(overrides: Partial<User> = {}) {
  return {
    ...baseUser,
    ...overrides,
  }
}

function avatarImage() {
  const element = screen.getByRole('img', { name: 'alice' })

  if (!(element instanceof HTMLImageElement)) {
    throw new Error('Expected avatar image to be an HTMLImageElement')
  }

  return element
}

function animatedOverlay(container: HTMLElement) {
  const element = container.querySelector('img[aria-hidden="true"]')

  if (element !== null && !(element instanceof HTMLImageElement)) {
    throw new Error('Expected animated overlay to be an HTMLImageElement')
  }

  return element
}

describe('UserAvatar animation modes', () => {
  afterEach(() => {
    cleanup()
  })

  it('keeps the default hover mode static before interaction', () => {
    render(<UserAvatar user={user()} />)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1',
    )
  })

  it('shows animated GIF overlay only while hover is active', () => {
    const { container } = render(<UserAvatar user={user()} />)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1',
    )
    expect(animatedOverlay(container)).toBeNull()

    fireEvent.pointerEnter(container.firstElementChild!)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1',
    )
    expect(animatedOverlay(container)?.src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1/avatar.gif',
    )
    expect(animatedOverlay(container)?.className).toContain('opacity-100')

    fireEvent.pointerLeave(container.firstElementChild!)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1',
    )
    expect(animatedOverlay(container)?.className).toContain('opacity-0')
  })

  it('uses original GIF immediately in always mode', () => {
    render(<UserAvatar user={user()} animated="always" />)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1/avatar.gif',
    )
  })

  it('keeps speaking GIF sources mounted without swapping the static image src', () => {
    const { container, rerender } = render(
      <UserAvatar user={user()} animated="speaking" speaking={false} />,
    )

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1',
    )
    expect(animatedOverlay(container)?.src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1/avatar.gif',
    )
    expect(animatedOverlay(container)?.className).toContain('opacity-0')

    rerender(<UserAvatar user={user()} animated="speaking" speaking />)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1',
    )
    expect(animatedOverlay(container)?.src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1/avatar.gif',
    )
    expect(animatedOverlay(container)?.className).toContain('opacity-100')
  })
})
