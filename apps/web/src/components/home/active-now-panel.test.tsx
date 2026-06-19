// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it } from 'vitest'

import { ActiveNowPanel } from '#/components/home/active-now-panel'

const onlineFriend = {
  _id: 'user-online',
  username: 'test_isa',
  display_name: 'Test Isa',
  relationship: 'Friend',
  online: true,
  status: {
    presence: 'Idle',
    text: 'Собирает сервер',
  },
} as User

const offlineFriend = {
  _id: 'user-offline',
  username: 'sleepy',
  relationship: 'Friend',
  online: false,
} as User

const ActiveNowPanelWithUsers = ActiveNowPanel as ComponentType<{
  users: User[]
}>

describe('ActiveNowPanel', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows online friends instead of a soon placeholder', () => {
    render(<ActiveNowPanelWithUsers users={[onlineFriend, offlineFriend]} />)

    expect(screen.getByText('Test Isa')).toBeTruthy()
    expect(screen.getByText('Не активен')).toBeTruthy()
    expect(screen.getByText('Собирает сервер')).toBeTruthy()
    expect(screen.queryByText('sleepy')).toBeNull()
    expect(screen.queryByText('Скоро')).toBeNull()
  })

  it('shows a quiet empty state when no friends are active', () => {
    render(<ActiveNowPanelWithUsers users={[offlineFriend]} />)

    expect(screen.getByText('Тут пока тихо')).toBeTruthy()
    expect(screen.queryByText('Скоро')).toBeNull()
  })
})
