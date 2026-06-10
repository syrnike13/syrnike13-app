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

  it('loads original GIF after hover in hover mode', () => {
    const { container } = render(<UserAvatar user={user()} />)

    fireEvent.pointerEnter(container.firstElementChild!)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1/original',
    )
  })

  it('uses original GIF immediately in always mode', () => {
    render(<UserAvatar user={user()} animated="always" />)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1/original',
    )
  })

  it('uses original GIF only while speaking in speaking mode', () => {
    const { rerender } = render(
      <UserAvatar user={user()} animated="speaking" speaking={false} />,
    )

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1',
    )

    rerender(<UserAvatar user={user()} animated="speaking" speaking />)

    expect(avatarImage().src).toBe(
      'https://syrnike13.ru/autumn/avatars/avatar-1/original',
    )
  })
})
