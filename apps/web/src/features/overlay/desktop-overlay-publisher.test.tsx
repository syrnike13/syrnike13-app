// @vitest-environment jsdom

import { StrictMode } from 'react'
import type { DesktopOverlaySnapshot } from '@syrnike13/platform'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const componentMocks = vi.hoisted(() => {
  const setSnapshot = vi.fn(
    async (_snapshot: DesktopOverlaySnapshot) => undefined,
  )
  return {
    setSnapshot,
    desktopAvailable: true,
    desktopBridge: { overlay: { setSnapshot } },
    voice: {
      channelId: 'voice-1',
      speakingUserIds: new Set<string>(),
    },
    sync: {
      channels: { 'voice-1': { _id: 'voice-1' } },
      voiceParticipants: {
        'voice-1': {
          'user-1': {
            id: 'user-1',
            joined_at: 1,
            self_mute: false,
            self_deaf: false,
            server_muted: false,
            server_deafened: false,
            screensharing: false,
            camera: false,
            version: 1,
          },
        },
      },
      users: {
        'user-1': {
          _id: 'user-1',
          username: 'mira',
          display_name: 'Mira',
          avatar: null,
        },
      },
    },
  }
})

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({ user: { _id: 'user-1' } }),
}))
vi.mock('#/features/sync/channel-label', () => ({
  getChannelLabel: () => 'General voice',
}))
vi.mock('#/features/sync/sync-store', () => ({
  useSyncStore: (selector: (state: unknown) => unknown) =>
    selector(componentMocks.sync),
}))
vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => componentMocks.voice,
}))
vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({
    desktop: componentMocks.desktopAvailable
      ? componentMocks.desktopBridge
      : null,
    os: 'win32',
  }),
}))

import {
  createDesktopOverlaySnapshotPublisher,
  DesktopOverlayPublisher,
  selectDesktopOverlayChannel,
  selectDesktopOverlayParticipants,
} from './desktop-overlay-publisher'

function activeSnapshot(speaking = false) {
  return {
    active: true as const,
    channelId: 'voice-1',
    channelLabel: 'General voice',
    participants: [
      {
        userId: 'user-1',
        displayName: 'Mira',
        avatarUrl: null,
        speaking,
        muted: false,
        deafened: false,
        screensharing: false,
      },
    ],
  }
}

describe('desktop overlay snapshot publisher', () => {
  beforeEach(() => {
    componentMocks.setSnapshot.mockClear()
    componentMocks.desktopAvailable = true
  })

  it('publishes the active snapshot after a StrictMode cleanup and remount', async () => {
    render(
      <StrictMode>
        <DesktopOverlayPublisher />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(componentMocks.setSnapshot).toHaveBeenCalled()
      expect(componentMocks.setSnapshot.mock.lastCall?.[0]).toMatchObject({
        active: true,
        channelId: 'voice-1',
      })
    })
  })

  it('publishes the current snapshot when the desktop bridge appears late', async () => {
    componentMocks.desktopAvailable = false
    const view = render(<DesktopOverlayPublisher />)
    expect(componentMocks.setSnapshot).not.toHaveBeenCalled()

    componentMocks.desktopAvailable = true
    view.rerender(<DesktopOverlayPublisher />)

    await waitFor(() => {
      expect(componentMocks.setSnapshot.mock.lastCall?.[0]).toMatchObject({
        active: true,
        channelId: 'voice-1',
      })
    })
  })

  it('selects stable channel and participant-map references across unrelated sync updates', () => {
    const channel = { _id: 'voice-1' }
    const participants = { 'user-1': { id: 'user-1' } }
    const first = {
      channels: { 'voice-1': channel },
      voiceParticipants: { 'voice-1': participants },
      messages: {},
    }
    const unrelatedUpdate = { ...first, messages: { message: {} } }

    expect(selectDesktopOverlayChannel(first as never, 'voice-1')).toBe(
      selectDesktopOverlayChannel(unrelatedUpdate as never, 'voice-1'),
    )
    expect(selectDesktopOverlayParticipants(first as never, 'voice-1')).toBe(
      selectDesktopOverlayParticipants(unrelatedUpdate as never, 'voice-1'),
    )
  })

  it('deduplicates equal payloads and coalesces updates in one microtask', async () => {
    const send = vi.fn(async () => undefined)
    const publisher = createDesktopOverlaySnapshotPublisher(send, vi.fn())

    publisher.publish(activeSnapshot())
    publisher.publish(structuredClone(activeSnapshot()))
    publisher.publish(activeSnapshot(true))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

    expect(send).toHaveBeenCalledWith(activeSnapshot(true))
    publisher.publish(structuredClone(activeSnapshot(true)))
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('serializes an in-flight update and sends an inactive final snapshot', async () => {
    let finishFirst: (() => void) | undefined
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve
          }),
      )
      .mockResolvedValue(undefined)
    const publisher = createDesktopOverlaySnapshotPublisher(send, vi.fn())

    publisher.publish(activeSnapshot())
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    publisher.close()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    finishFirst?.()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1]?.[0]).toMatchObject({ active: false })
  })
})
