// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  platform: {
    capabilities: { customWindowChrome: false },
    desktop: null as null | { platform: { os: 'win32' } },
  },
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => mocks.platform,
}))

vi.mock('#/components/layout/shell-title-bar-controls', () => ({
  ShellHistoryNavButtons: () => <div data-testid="history-nav" />,
  ShellWindowControls: () => <div data-testid="window-controls" />,
}))

import { ShellTitleBar } from './shell-title-bar'

describe('ShellTitleBar', () => {
  afterEach(() => {
    cleanup()
    mocks.platform.capabilities.customWindowChrome = false
    mocks.platform.desktop = null
  })

  it('renders history navigation in the web runtime', () => {
    render(<ShellTitleBar />)

    expect(screen.getByRole('banner')).not.toBeNull()
    expect(screen.getByTestId('history-nav')).not.toBeNull()
  })

  it('does not render a desktop title bar without custom window chrome', () => {
    mocks.platform.desktop = { platform: { os: 'win32' } }

    render(<ShellTitleBar />)

    expect(screen.queryByRole('banner')).toBeNull()
  })
})
