// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((options: { to: string }) => ({ options })),
  routeOptions: undefined as
    | { beforeLoad?: () => unknown }
    | undefined,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(
    () => (options: { beforeLoad?: () => unknown }) => {
      mocks.routeOptions = options
      return { options }
    },
  ),
  lazyRouteComponent: vi.fn(() => () => null),
  redirect: mocks.redirect,
  useNavigate: vi.fn(),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: vi.fn(),
}))

import './onboard'

const storedSession = {
  _id: 'session-1',
  token: 'token-1',
  user_id: 'user-1',
}

function installDesktopSession(session: typeof storedSession | null) {
  const loadSession = vi.fn(async () => session)

  Object.defineProperty(window, 'syrnikeDesktop', {
    configurable: true,
    value: {
      runtime: 'desktop',
      platform: { os: 'win32' },
      auth: {
        loadSession,
        saveSession: vi.fn(async () => undefined),
        clearSession: vi.fn(async () => undefined),
      },
    },
  })

  return loadSession
}

async function runBeforeLoad() {
  const beforeLoad = mocks.routeOptions?.beforeLoad
  expect(beforeLoad).toBeTypeOf('function')
  await beforeLoad?.()
}

describe('/login/onboard beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    Reflect.deleteProperty(window, 'syrnikeDesktop')
  })

  it('allows desktop onboarding when the session exists only in desktop persistence', async () => {
    const loadSession = installDesktopSession(storedSession)

    await expect(runBeforeLoad()).resolves.toBeUndefined()

    expect(loadSession).toHaveBeenCalled()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('redirects to login when desktop persistence has no session', async () => {
    const loadSession = installDesktopSession(null)

    await expect(runBeforeLoad()).rejects.toMatchObject({
      options: { to: '/login' },
    })

    expect(loadSession).toHaveBeenCalled()
    expect(mocks.redirect).toHaveBeenCalledWith({ to: '/login' })
  })

  it('continues to allow onboarding with a browser session', async () => {
    localStorage.setItem('syrnike13:session', JSON.stringify(storedSession))

    await expect(runBeforeLoad()).resolves.toBeUndefined()

    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
