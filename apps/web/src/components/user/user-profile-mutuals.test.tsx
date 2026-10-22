// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it } from 'vitest'

import { UserProfileMutuals } from './user-profile-mutuals'

describe('UserProfileMutuals', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders mutual friend and server counts', () => {
    render(
      <UserProfileMutuals
        mutualFriends={[{ _id: 'friend-1', username: 'alice' } as User]}
        mutualFriendsCount={2}
        mutualServersCount={1}
      />,
    )

    expect(screen.getByText('Общих друзей — 2')).toBeTruthy()
    expect(screen.getByText('Общие серверы — 1')).toBeTruthy()
  })

  it('renders nothing when there are no mutuals', () => {
    const { container } = render(
      <UserProfileMutuals
        mutualFriends={[]}
        mutualFriendsCount={0}
        mutualServersCount={0}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
