// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsDesktopPanel } from '#/components/settings/settings-desktop-panel'

const desktopMocks = vi.hoisted(() => ({
  activityClear: vi.fn().mockResolvedValue(undefined),
  activitySet: vi.fn().mockResolvedValue(undefined),
  checkUpdates: vi.fn().mockResolvedValue({ status: 'idle' }),
  getUpdateState: vi.fn().mockResolvedValue({ status: 'idle' }),
  getVersions: vi.fn().mockResolvedValue({
    app: '0.5.1',
    electron: '40.0.0',
    chrome: '140.0.0',
    node: '25.0.0',
  }),
  getWindowPreferences: vi.fn().mockResolvedValue({
    closeToTray: true,
    openAtLogin: true,
  }),
  installUpdate: vi.fn(),
  onUpdateStateChange: vi.fn(() => vi.fn()),
  setCloseToTray: vi.fn(),
  setOpenAtLogin: vi.fn(),
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({
    desktop: {
      activity: {
        clear: desktopMocks.activityClear,
        set: desktopMocks.activitySet,
      },
      getVersions: desktopMocks.getVersions,
      updates: {
        check: desktopMocks.checkUpdates,
        getState: desktopMocks.getUpdateState,
        install: desktopMocks.installUpdate,
        onStateChange: desktopMocks.onUpdateStateChange,
      },
      window: {
        getPreferences: desktopMocks.getWindowPreferences,
        setCloseToTray: desktopMocks.setCloseToTray,
        setOpenAtLogin: desktopMocks.setOpenAtLogin,
      },
    },
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

describe('SettingsDesktopPanel activity status', () => {
  beforeEach(() => {
    desktopMocks.activityClear.mockClear()
    desktopMocks.activitySet.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('sets and clears a manual desktop activity status', async () => {
    render(<SettingsDesktopPanel />)

    fireEvent.change(screen.getByLabelText('Название активности'), {
      target: { value: 'syrnike13' },
    })
    fireEvent.change(screen.getByLabelText('Детали'), {
      target: { value: 'Настраивает роли' },
    })
    fireEvent.change(screen.getByLabelText('Состояние'), {
      target: { value: 'В desktop app' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Показать активность' }))

    await waitFor(() => {
      expect(desktopMocks.activitySet).toHaveBeenCalledWith({
        type: 'playing',
        name: 'syrnike13',
        details: 'Настраивает роли',
        state: 'В desktop app',
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }))

    await waitFor(() => {
      expect(desktopMocks.activityClear).toHaveBeenCalled()
    })
    expect(screen.queryByText(/Скоро/)).toBeNull()
  })
})
