// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActivityLauncher } from './activity-launcher'

const testState = vi.hoisted(() => ({
  allowed: true,
  start: vi.fn(),
  connection: 'connected' as 'connected' | 'reconnecting',
}))

vi.mock('#/components/icons', () => ({ ActivityIcon: () => null }))

vi.mock('#/features/authorization/authorization', () => ({
  canUseActivities: () => testState.allowed,
}))

vi.mock('#/features/sync/sync-store', () => ({
  useSyncStore: (selector: (state: unknown) => unknown) => selector({}),
}))

vi.mock('./activity-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./activity-store')>()),
  activityStore: { start: testState.start },
}))

vi.mock('./use-activities', () => ({
  useActivityConnectionStatus: () => testState.connection,
  activityApplicationIconUrl: () => null,
  useActivityApplications: () => ({
    isPending: false,
    isError: false,
    data: [
      {
        _id: 'chess',
        name: 'Chess',
        description: 'Play chess',
        activity_url: 'https://chess.activities.syrnike13.ru',
        max_participants: 2,
      },
    ],
  }),
}))

describe('ActivityLauncher', () => {
  beforeEach(() => {
    testState.allowed = true
    testState.connection = 'connected'
    testState.start.mockReset()
    testState.start.mockResolvedValue(null)
  })

  afterEach(cleanup)

  it('lists catalog apps and starts one in the channel', () => {
    render(<ActivityLauncher channelId="voice-a" onClose={vi.fn()} />)

    expect(screen.getByText('Chess')).toBeTruthy()
    expect(screen.getByText('Play chess')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))
    expect(testState.start).toHaveBeenCalledWith('voice-a', 'chess')
  })

  it('disables starting without the UseActivities permission', () => {
    testState.allowed = false
    render(<ActivityLauncher channelId="voice-a" onClose={vi.fn()} />)

    const start = screen.getByRole('button', { name: 'Запустить' })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(
        'Чтобы запускать Активности в этом канале, нужно право «Использовать Активности».',
      ),
    ).toBeTruthy()
    fireEvent.click(start)
    expect(testState.start).not.toHaveBeenCalled()
  })
})
