// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerRail } from '#/components/layout/server-rail'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('@tanstack/react-router', () => ({
  Link: forwardRef<
    HTMLAnchorElement,
    AnchorHTMLAttributes<HTMLAnchorElement> & {
      children: ReactNode
      to: string
    }
  >(({ children, to, ...props }, ref) => (
    <a ref={ref} href={to} {...props}>
      {children}
    </a>
  )),
  useMatch: ({ from }: { from: string }) =>
    from === '/app/' || from === '/m/'
      ? { routeId: from, params: {}, search: {} }
      : false,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'current-user', username: 'me' },
  }),
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({
    capabilities: { customWindowChrome: false },
  }),
}))

vi.mock('#/components/servers/create-server-dialog', () => ({
  CreateServerDialog: () => null,
}))

describe('ServerRail', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.applyReady({
      users: [
        {
          _id: 'current-user',
          username: 'me',
          discriminator: '0001',
          relationship: 'User',
          online: true,
        },
        {
          _id: 'request-1',
          username: 'bob',
          discriminator: '0002',
          relationship: 'Incoming',
          online: true,
        },
      ],
      servers: [],
      channels: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('shows home notifications on the home rail button', () => {
    render(<ServerRail variant="desktop" />)

    expect(screen.getByTitle('Главная')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })
})
