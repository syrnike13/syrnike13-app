// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  releaseChannel: 'stable' as 'stable' | 'nightly',
}))

vi.mock('#/features/navigation/use-shell-history-nav', () => ({
  useShellHistoryNav: () => ({
    canGoBack: false,
    canGoForward: false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  }),
}))

vi.mock('#/lib/config', () => ({
  config: {
    get releaseChannel() {
      return mocks.releaseChannel
    },
  },
}))

import { ShellHistoryNavButtons } from './shell-title-bar-controls'

describe('ShellHistoryNavButtons', () => {
  afterEach(() => {
    cleanup()
    mocks.releaseChannel = 'stable'
  })

  it('hides the nightly badge for stable builds', () => {
    render(<ShellHistoryNavButtons />)

    expect(screen.queryByText('nightly')).toBeNull()
  })

  it('shows the nightly badge for nightly builds', () => {
    mocks.releaseChannel = 'nightly'

    render(<ShellHistoryNavButtons />)

    expect(screen.getByText('nightly')).not.toBeNull()
  })
})
