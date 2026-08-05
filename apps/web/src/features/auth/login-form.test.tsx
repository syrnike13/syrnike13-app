// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => mocks.navigate,
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
  },
}))

vi.mock('./auth-context', () => ({
  useAuth: () => ({
    cancelMfa: vi.fn(),
    login: mocks.login,
    mfaChallenge: null,
    session: null,
    submitMfaPassword: vi.fn(),
  }),
}))

vi.mock('./use-syrnike-config', () => ({
  isEmailVerificationEnabled: () => false,
  useSyrnikeConfig: () => ({ data: undefined }),
}))

import { LoginForm } from './login-form'

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it('moves from email to password instead of submitting on Enter', () => {
    render(<LoginForm />)

    const email = screen.getByLabelText('Email')
    const password = screen.getByLabelText('Пароль')

    email.focus()
    fireEvent.change(email, { target: { value: 'test@example.com' } })
    fireEvent.keyDown(email, { key: 'Enter', code: 'Enter' })

    expect(document.activeElement).toBe(password)
    expect(mocks.login).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
