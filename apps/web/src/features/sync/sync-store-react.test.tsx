// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncStore, useSyncStore } from '#/features/sync/sync-store'

const SERVER_ID = '01KT7DEM3B0T4B0BXGBXWDJ700'
const FIRST_CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ701'
const SECOND_CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ702'

function ChannelName({ channelId }: { channelId: string }) {
  const name = useSyncStore((state) => {
    const channel = state.channels[channelId]
    return channel?.channel_type === 'TextChannel' ? channel.name : 'missing'
  })

  return <p>{name}</p>
}

function ChannelIds({ label }: { label: string }) {
  const ids = useSyncStore((state) => Object.keys(state.channels))

  return <p>{`${label}:${ids.join(',')}`}</p>
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
    vi.restoreAllMocks()
  })

  it('recomputes selected data when selector inputs change without a store update', () => {
    const { rerender } = render(<ChannelName channelId={FIRST_CHANNEL_ID} />)
    expect(screen.getByText('general')).toBeTruthy()

    rerender(<ChannelName channelId={SECOND_CHANNEL_ID} />)

    expect(screen.getByText('updates')).toBeTruthy()
  })

  it('keeps getSnapshot stable when an inline selector returns a new reference', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { rerender } = render(<ChannelIds label="first" />)
    expect(screen.getByText(`${FIRST_CHANNEL_ID},${SECOND_CHANNEL_ID}`, {
      exact: false,
    })).toBeTruthy()

    rerender(<ChannelIds label="second" />)

    expect(screen.getByText(`second:${FIRST_CHANNEL_ID},${SECOND_CHANNEL_ID}`)).toBeTruthy()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
