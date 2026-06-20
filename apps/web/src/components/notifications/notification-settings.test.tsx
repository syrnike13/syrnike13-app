// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationSettings } from './notification-settings'

const mocks = vi.hoisted(() => ({
  fetchSyrnikeConfig: vi.fn(),
  useAuth: vi.fn(),
}))

vi.mock('#/features/api/config-api', () => ({
  fetchSyrnikeConfig: mocks.fetchSyrnikeConfig,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: mocks.useAuth,
}))

describe('NotificationSettings', () => {
  beforeEach(() => {
    mocks.fetchSyrnikeConfig.mockResolvedValue({ vapid: null })
    mocks.useAuth.mockReturnValue({ session: { token: 'session-token' } })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders readable Russian notification copy', () => {
    const { container } = render(<NotificationSettings />)

    expect(screen.getByText('Уведомления')).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'Разрешить уведомления в браузере',
      }),
    ).toBeTruthy()
    expect(container.textContent).not.toContain('РЈРІ')
    expect(container.textContent).not.toContain('Р‘СЂ')
  })
})
