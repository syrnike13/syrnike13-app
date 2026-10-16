// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AchievementToastHost } from '#/components/achievements/achievement-toast-host'
import { achievementQueue } from '#/features/achievements/achievement-queue'

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn(),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ session: { token: 'token' } }),
}))

vi.mock('#/features/achievements/use-achievement-unlocks', () => ({
  useAchievementUnlocks: () => {},
  acknowledgeAchievement: mocks.acknowledge,
}))

function unlock(id: string, badgeId: string | null = id) {
  return { id, badgeId, name: `Badge ${id}`, description: null, iconUrl: null }
}

describe('AchievementToastHost', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    achievementQueue.clear()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    mocks.acknowledge.mockReset()
  })

  it('hides each notification on its own and shows the next one', () => {
    render(<AchievementToastHost />)
    act(() => achievementQueue.enqueue([unlock('a'), unlock('b')]))

    expect(screen.getByText('Badge a')).toBeTruthy()
    expect(mocks.acknowledge).toHaveBeenCalledWith('token', 'a')

    act(() => vi.advanceTimersByTime(6000))
    expect(screen.getByRole('status').dataset.phase).toBe('exiting')

    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByText('Badge b')).toBeTruthy()

    act(() => vi.advanceTimersByTime(6000))
    act(() => vi.advanceTimersByTime(400))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('closes on click and skips acknowledging debug notifications', () => {
    render(<AchievementToastHost />)
    act(() => achievementQueue.enqueue([unlock('debug', null)]))

    act(() => screen.getByRole('status').click())
    act(() => vi.advanceTimersByTime(400))

    expect(screen.queryByRole('status')).toBeNull()
    expect(mocks.acknowledge).not.toHaveBeenCalled()
  })
})
