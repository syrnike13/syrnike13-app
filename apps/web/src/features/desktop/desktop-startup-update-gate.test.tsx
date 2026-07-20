// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopUpdateState } from '@syrnike13/platform'

const desktopUpdates = vi.hoisted(() => {
  let state: DesktopUpdateState = { status: 'checking' }
  const listeners = new Set<(state: DesktopUpdateState) => void>()

  return {
    getState: vi.fn(() => Promise.resolve(state)),
    onStateChange: vi.fn((listener: (state: DesktopUpdateState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    setState(nextState: DesktopUpdateState) {
      state = nextState
      for (const listener of listeners) listener(nextState)
    },
    reset() {
      state = { status: 'checking' }
      listeners.clear()
      this.getState.mockClear()
      this.onStateChange.mockClear()
    },
  }
})

vi.mock('#/platform/use-platform', () => {
  const platform = { desktop: { updates: desktopUpdates } }
  return { usePlatform: () => platform }
})

vi.mock('#/components/layout/gateway-loading-screen', () => ({
  GatewayLoadingScreen: ({ statusText }: { statusText: string }) => (
    <div>{statusText}</div>
  ),
}))

import { DesktopStartupUpdateGate } from './desktop-startup-update-gate'

describe('DesktopStartupUpdateGate', () => {
  beforeEach(() => {
    desktopUpdates.reset()
  })

  it('blocks startup through download and never blocks again after it settles', async () => {
    render(
      <DesktopStartupUpdateGate>
        <div>Приложение</div>
      </DesktopStartupUpdateGate>,
    )

    expect(screen.getByText('Проверка обновлений…')).toBeTruthy()
    await act(async () => {})

    await act(async () => {
      desktopUpdates.setState({ status: 'downloading', percent: 37 })
    })
    expect(screen.getByText('Загрузка обновления… 37%')).toBeTruthy()
    expect(screen.queryByText('Приложение')).toBeNull()

    await act(async () => {
      desktopUpdates.setState({ status: 'idle' })
    })
    expect(screen.getByText('Приложение')).toBeTruthy()

    await act(async () => {
      desktopUpdates.setState({ status: 'checking' })
    })
    expect(screen.getByText('Приложение')).toBeTruthy()
  })
})
