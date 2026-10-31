// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPrivacyPanel } from '#/components/settings/settings-privacy-panel'
import { syncStore } from '@syrnike13/client/sync/sync-store'

const mocks = vi.hoisted(() => ({ updatePrivacy: vi.fn() }))

vi.mock('#/features/privacy/use-privacy', async () => {
  const actual = await vi.importActual<
    typeof import('#/features/privacy/use-privacy')
  >('#/features/privacy/use-privacy')
  return {
    ...actual,
    usePrivacy: () => ({
      privacy: actual.DEFAULT_PRIVACY,
      loaded: true,
      update: mocks.updatePrivacy,
    }),
  }
})

describe('SettingsPrivacyPanel', () => {
  beforeEach(() => {
    syncStore.reset()
    for (const id of ['server-1', 'server-2']) {
      syncStore.upsertServer({
        _id: id,
        name: id,
        owner: 'owner',
        channels: [],
        default_permissions: 0,
      } as never)
    }
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('turns off server direct messages everywhere and for new servers', () => {
    render(<SettingsPrivacyPanel />)

    expect(
      screen.getByText('Разрешить личные сообщения от участников серверов'),
    ).toBeTruthy()
    // The first switch is the server direct messages row.
    fireEvent.click(screen.getAllByRole('switch')[0]!)

    expect(mocks.updatePrivacy).toHaveBeenCalledWith(
      expect.objectContaining({
        restrict_dms_in_new_servers: true,
        dm_restricted_servers: ['server-1', 'server-2'],
      }),
    )
  })
})
