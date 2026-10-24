// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ActivityInstance } from '@syrnike13/api-types/gateway-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivityApplication } from '#/features/activities/activity-api'
import {
  VoiceStageActivityTile,
  activityFrameLayout,
} from './voice-stage-activity-tile'

const testState = vi.hoisted(() => ({
  join: vi.fn(),
  leave: vi.fn(),
  end: vi.fn(),
  connection: 'connected' as 'connected' | 'reconnecting',
}))

vi.mock('#/components/icons', () => ({
  ActivityIcon: () => null,
  EyeIcon: () => null,
  LogOutIcon: () => null,
  Maximize2Icon: () => null,
  PowerIcon: () => null,
}))

vi.mock('#/features/activities/activity-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('#/features/activities/activity-store')>()
  return {
    ...actual,
    activityStore: {
      join: testState.join,
      leave: testState.leave,
      end: testState.end,
    },
  }
})

vi.mock('#/features/activities/use-activities', () => ({
  useActivityConnectionStatus: () => testState.connection,
  activityApplicationIconUrl: () => null,
}))

vi.mock('#/features/activities/activity-frame', () => ({
  ActivityFrame: ({ layout }: { layout: string }) => (
    <div data-testid="activity-frame" data-layout={layout} />
  ),
}))

const application: ActivityApplication = {
  _id: 'chess',
  name: 'Chess',
  description: 'Play chess',
  activity_url: 'https://chess.activities.syrnike13.ru',
  max_participants: 2,
}

function instance(participantIds: string[]): ActivityInstance {
  return {
    id: 'instance-1',
    application_id: 'chess',
    channel_id: 'voice-a',
    server_id: 'server-1',
    revision: 1,
    host_id: participantIds[0] ?? 'alice',
    participants: participantIds.map((userId) => ({
      user_id: userId,
      joined_at: '2026-10-24T10:00:00Z',
    })),
    started_by: 'alice',
    started_at: '2026-10-24T10:00:00Z',
  }
}

function renderTile(
  participantIds: string[],
  options: { canEnd?: boolean; variant?: 'grid' | 'focus' | 'strip' } = {},
) {
  return render(
    <VoiceStageActivityTile
      item={{
        id: 'activity:instance-1',
        kind: 'activity',
        instance: instance(participantIds),
      }}
      application={application}
      currentUserId="local"
      participants={participantIds.map((id) => ({ id, displayName: id }))}
      canEnd={options.canEnd ?? false}
      variant={options.variant ?? 'grid'}
      onFocus={vi.fn()}
    />,
  )
}

describe('VoiceStageActivityTile', () => {
  beforeEach(() => {
    testState.join.mockReset()
    testState.leave.mockReset()
    testState.end.mockReset()
    testState.connection = 'connected'
  })

  afterEach(cleanup)

  it('shows app info and joins instead of the frame for non-participants', async () => {
    testState.join.mockResolvedValue(null)
    renderTile(['alice'])

    expect(screen.queryByTestId('activity-frame')).toBeNull()
    expect(screen.getByText('Chess')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Присоединиться' }))

    await waitFor(() =>
      expect(testState.join).toHaveBeenCalledWith('voice-a', 'instance-1'),
    )
  })

  it('shows a localized error when joining fails', async () => {
    const { ActivityRequestError } = await import(
      '#/features/activities/activity-store'
    )
    testState.join.mockRejectedValue(new ActivityRequestError('full'))
    renderTile(['alice'])

    fireEvent.click(screen.getByRole('button', { name: 'Присоединиться' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'В этой Активности нет мест.',
    )
  })

  it('disables joining a full instance or while the gateway reconnects', () => {
    renderTile(['alice', 'bob'])
    expect(
      (screen.getByRole('button', { name: 'Мест нет' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    cleanup()

    testState.connection = 'reconnecting'
    renderTile(['alice'])
    expect(
      (
        screen.getByRole('button', { name: 'Присоединиться' }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })

  it('renders the frame for participants with the stage layout', () => {
    renderTile(['alice', 'local'], { variant: 'focus' })

    expect(screen.getByTestId('activity-frame').dataset.layout).toBe('focus')
    expect(screen.queryByRole('button', { name: 'Присоединиться' })).toBeNull()
  })

  it('offers leave to participants and end to hosts and channel managers', async () => {
    testState.leave.mockResolvedValue(undefined)
    testState.end.mockResolvedValue(undefined)
    renderTile(['local'], { canEnd: true })

    fireEvent.contextMenu(screen.getByTestId('voice-stage-activity-tile'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Покинуть Активность' }))
    expect(testState.leave).toHaveBeenCalledWith('voice-a', 'instance-1')

    fireEvent.contextMenu(screen.getByTestId('voice-stage-activity-tile'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Завершить для всех' }))
    expect(testState.end).toHaveBeenCalledWith('voice-a', 'instance-1')
  })

  it('maps stage presentation to SDK layouts', () => {
    expect(activityFrameLayout('grid', false)).toBe('grid')
    expect(activityFrameLayout('focus', false)).toBe('focus')
    expect(activityFrameLayout('fullscreen', false)).toBe('focus')
    expect(activityFrameLayout('focus', true)).toBe('popout')
  })
})
