import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  context: { queryClient: {} },
  createRouter: vi.fn((options) => ({ options })),
  routeTree: {},
}))

vi.mock('@tanstack/react-router', () => ({
  createRouter: mocks.createRouter,
}))

vi.mock('./routeTree.gen', () => ({
  routeTree: mocks.routeTree,
}))

vi.mock('./integrations/tanstack-query/root-provider', () => ({
  getContext: () => mocks.context,
}))

vi.mock('#/components/layout/gateway-loading-screen', () => ({
  GatewayLoadingScreen: () => null,
}))

import { getRouter } from './router'

describe('getRouter', () => {
  it('configures a default not found component', () => {
    getRouter()

    expect(mocks.createRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultNotFoundComponent: expect.any(Function),
      }),
    )
  })
})
