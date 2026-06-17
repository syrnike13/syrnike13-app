// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DESKTOP_LOCAL_SETTINGS } from '@syrnike13/platform'

import { SettingsIntegrationsPanel } from '#/components/settings/settings-integrations-panel'

const loadDesktopLocalSettingsMock = vi.hoisted(() => vi.fn())
const updateDesktopLocalSettingsMock = vi.hoisted(() => vi.fn())
const toastErrorMock = vi.hoisted(() => vi.fn())

vi.mock('#/features/settings/desktop-local-settings-client', () => ({
  loadDesktopLocalSettings: loadDesktopLocalSettingsMock,
  updateDesktopLocalSettings: updateDesktopLocalSettingsMock,
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}))

describe('SettingsIntegrationsPanel', () => {
  beforeEach(() => {
    loadDesktopLocalSettingsMock.mockResolvedValue({
      ...DEFAULT_DESKTOP_LOCAL_SETTINGS,
      music: {
        ...DEFAULT_DESKTOP_LOCAL_SETTINGS.music,
        providers: {
          ...DEFAULT_DESKTOP_LOCAL_SETTINGS.music.providers,
          spotify: {
            ...DEFAULT_DESKTOP_LOCAL_SETTINGS.music.providers.spotify,
            enabled: false,
          },
        },
      },
    })
    updateDesktopLocalSettingsMock.mockResolvedValue({
      ...DEFAULT_DESKTOP_LOCAL_SETTINGS,
      music: {
        ...DEFAULT_DESKTOP_LOCAL_SETTINGS.music,
        providers: {
          ...DEFAULT_DESKTOP_LOCAL_SETTINGS.music.providers,
          spotify: {
            ...DEFAULT_DESKTOP_LOCAL_SETTINGS.music.providers.spotify,
            enabled: true,
          },
        },
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('updates desktop music provider settings', async () => {
    render(<SettingsIntegrationsPanel />)

    const spotifySwitch = await screen.findByRole('switch', {
      name: 'Spotify',
    })
    fireEvent.click(spotifySwitch)

    await waitFor(() => {
      expect(updateDesktopLocalSettingsMock).toHaveBeenCalledWith({
        music: {
          providers: {
            spotify: {
              enabled: true,
            },
          },
        },
      })
    })
  })

  it('stops showing the loading state when desktop settings fail to load', async () => {
    loadDesktopLocalSettingsMock.mockRejectedValueOnce(
      new Error('settings exploded'),
    )

    render(<SettingsIntegrationsPanel />)

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('settings exploded')
    })

    expect(screen.getByText(/Desktop-/)).toBeTruthy()
  })
})
