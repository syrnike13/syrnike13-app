// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { syncStore, useSyncStore } from '#/features/sync/sync-store'

const SERVER_ID = '01KT7DEM3B0T4B0BXGBXWDJ700'
const FIRST_CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ701'
const SECOND_CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ702'

function ChannelName({ channelId }: { channelId: string }) {
  const name = useSyncStore(
    (state) => state.channels[channelId]?.name ?? 'missing',
  )

  return <p>{name}</p>
}

describe('useSyncStore', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.handleGatewayEvent({
      type: 'ChannelCreate',
      _id: FIRST_CHANNEL_ID,
      name: 'general',
      channel_type: 'TextChannel',
      server: SERVER_ID,
    })
    syncStore.handleGatewayEvent({
      type: 'ChannelCreate',
      _id: SECOND_CHANNEL_ID,
      name: 'updates',
      channel_type: 'TextChannel',
      server: SERVER_ID,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('recomputes selected data when selector inputs change without a store update', () => {
    const { rerender } = render(<ChannelName channelId={FIRST_CHANNEL_ID} />)
    expect(screen.getByText('general')).toBeTruthy()

    rerender(<ChannelName channelId={SECOND_CHANNEL_ID} />)

    expect(screen.getByText('updates')).toBeTruthy()
  })
})
