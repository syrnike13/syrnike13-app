// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChannelActivityViewState } from '#/features/activities/channel-activity-types'
import {
  VoiceStageActivityTile,
  type VoiceStageActivityItem,
} from './voice-stage-activity-tile'

const client = vi.hoisted(() => ({
  join: vi.fn(),
  leave: vi.fn(),
  command: vi.fn(),
}))

vi.mock('#/features/activities/channel-activity-client', () => ({
  channelActivityClient: client,
}))

vi.mock('#/features/activities/channel-activity-panel', () => ({
  EmbeddedActivityFrame: ({ instance }: { instance: { id: string } }) => (
    <div data-testid="embedded-activity">{instance.id}</div>
  ),
}))

const instance = {
  id: 'activity-1',
  application_id: 'syrnike13.syrnik-race',
  channel_id: 'voice-a',
  owner_id: 'owner',
  participant_ids: ['owner'],
  revision: 1,
  state: {},
  created_at: '2026-07-20T00:00:00Z',
}

const item: VoiceStageActivityItem = {
  id: 'channel-activity:activity-1',
  kind: 'activity',
  instance,
}

function activity(
  participantIds = instance.participant_ids,
): ChannelActivityViewState {
  return {
    instance: { ...instance, participant_ids: participantIds },
    error: null,
    transport: 'connected',
  }
}

describe('VoiceStageActivityTile', () => {
  beforeEach(() => {
    client.join.mockReset()
    client.leave.mockReset()
    client.command.mockReset()
  })

  afterEach(cleanup)

  it('shows a join tile to a voice participant who has not joined the Activity', () => {
    const onFocus = vi.fn()
    render(
      <VoiceStageActivityTile
        item={item}
        activity={activity()}
        currentUserId="guest"
        variant="grid"
        onFocus={onFocus}
      />,
    )

    expect(
      screen.getByRole('heading', { name: 'Сырниковая гонка' }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Присоединиться' }))
    expect(client.join).toHaveBeenCalledWith('voice-a', 'activity-1')

    fireEvent.click(screen.getByRole('button', { name: 'Сфокусировать' }))
    expect(onFocus).toHaveBeenCalledWith('channel-activity:activity-1')
  })

  it('renders the embedded Activity after joining', async () => {
    render(
      <VoiceStageActivityTile
        item={{
          ...item,
          instance: { ...instance, participant_ids: ['owner', 'guest'] },
        }}
        activity={activity(['owner', 'guest'])}
        currentUserId="guest"
        variant="focus"
        onFocus={() => undefined}
      />,
    )

    expect(await screen.findByTestId('embedded-activity')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Присоединиться' })).toBeNull()
  })
})
