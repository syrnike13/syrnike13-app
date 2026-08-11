// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({ isDesktop: true }),
}))

vi.mock('#/components/layout/shell-title-bar', () => ({
  ShellTitleBar: () => <div data-testid="desktop-title-bar" />,
}))

vi.mock('#/lib/config', () => ({
  config: { releaseChannel: 'stable' },
}))

import { AuthLayout } from './auth-layout'

describe('AuthLayout', () => {
  afterEach(cleanup)

  it('keeps desktop window controls available on auth routes', () => {
    render(<AuthLayout>Вход</AuthLayout>)

    expect(screen.getByTestId('desktop-title-bar')).not.toBeNull()
    expect(screen.getByText('Вход')).not.toBeNull()
  })
})
