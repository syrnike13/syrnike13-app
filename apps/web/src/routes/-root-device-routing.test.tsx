// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

type GuardContext = {
  location: { pathname: string; search: Record<string, unknown> }
}

const mocks = vi.hoisted(() => {
  const route: { beforeLoad?: (context: GuardContext) => unknown } = {}
  return {
    route,
    isDesktopRuntime: vi.fn(() => false),
    shouldUseMobileLayout: vi.fn(() => true),
  }
})

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  createRootRouteWithContext: () => (options: typeof mocks.route) => {
    mocks.route.beforeLoad = options.beforeLoad
    return { options }
  },
}))

vi.mock('#/platform/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('#/platform/runtime')>(),
  isDesktopRuntime: mocks.isDesktopRuntime,
}))

vi.mock('#/lib/device-routing', async (importOriginal) => ({
  ...await importOriginal<typeof import('#/lib/device-routing')>(),
  shouldUseMobileLayout: mocks.shouldUseMobileLayout,
}))

import './__root'

function runGuard(pathname: string, search: Record<string, unknown> = {}) {
  expect(mocks.route.beforeLoad).toBeTypeOf('function')
  return mocks.route.beforeLoad?.({ location: { pathname, search } })
}

describe('root device routing', () => {
  beforeEach(() => {
    mocks.isDesktopRuntime.mockReturnValue(false)
    mocks.shouldUseMobileLayout.mockReturnValue(true)
  })

  it.each(['/login', '/login/reset/token', '/invite/code', '/verify/token'])(
    'keeps the public entry %s accessible on mobile',
    (pathname) => {
      expect(() => runGuard(pathname)).not.toThrow()
    },
  )

  it('maps the app home to mobile while keeping the selected tab', () => {
    expect(() => runGuard('/', { tab: 'all' })).toThrow(
      expect.objectContaining({
        options: expect.objectContaining({
          to: '/m', search: { tab: 'all' }, replace: true,
        }),
      }),
    )
  })

  it('keeps the message target when mapping a channel to mobile', () => {
    expect(() => runGuard('/c/channel', { m: 'message' })).toThrow(
      expect.objectContaining({
        options: expect.objectContaining({
          to: '/m/c/channel', search: { m: 'message' }, replace: true,
        }),
      }),
    )
  })

  it('does not redirect mobile routes again', () => {
    expect(() => runGuard('/m/c/channel')).not.toThrow()
  })

  it('does not switch the desktop runtime to mobile', () => {
    mocks.isDesktopRuntime.mockReturnValue(true)
    expect(() => runGuard('/c/channel')).not.toThrow()
  })
})
