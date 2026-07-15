// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSidebar } from '#/components/layout/channel-sidebar'
import { syncStore } from '#/features/sync/sync-store'
import { serverBannerUrl } from '#/lib/media'

const mocks = vi.hoisted(() => ({
  prefersReducedMotion: false,
}))

vi.mock('#/components/channels/channel-sidebar-item', () => ({
  ChannelSidebarItem: () => null,
}))

vi.mock('#/components/channels/server-channel-list', () => ({
  ServerChannelList: () => null,
}))

vi.mock('#/components/servers/server-header-menu', () => ({
  ServerHeaderMenu: ({ serverName }: { serverName: string }) => (
    <button type="button">{serverName}</button>
  ),
}))

vi.mock('#/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'current-user', username: 'me' },
  }),
}))

vi.mock('#/features/sync/server-members-sync', () => ({
  useServerMembersSync: () => undefined,
}))

vi.mock('#/hooks/use-media-query', () => ({
  useMediaQuery: () => mocks.prefersReducedMotion,
}))

const banner = {
  _id: 'server-banner-gif',
  tag: 'banners',
  filename: 'server.gif',
  content_type: 'image/gif',
  metadata: {
    type: 'Image',
    width: 960,
    height: 540,
    animated: true,
  },
} as const

function selectServerWithBanner() {
  syncStore.applyReady({
    users: [],
    servers: [
      {
        _id: 'server-1',
        name: 'Demo',
        owner: 'current-user',
        channels: [],
        default_permissions: 0,
        banner,
      },
    ],
    channels: [],
    members: [],
    emojis: [],
    channel_unreads: [],
    voice_states: [],
  } as never)
  syncStore.setSelectedServerId('server-1')
}

describe('ChannelSidebar', () => {
  beforeEach(() => {
    syncStore.reset()
    mocks.prefersReducedMotion = false
    selectServerWithBanner()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('keeps an animated banner URL stable across pointer and focus interactions', () => {
    const { container } = render(<ChannelSidebar />)
    const header = container.querySelector('header')
    const image = header?.querySelector('img')
    const animatedUrl = serverBannerUrl(banner as never, { animated: true })

    expect(image?.getAttribute('src')).toBe(animatedUrl)

    fireEvent.pointerEnter(header!)
    fireEvent.focus(image!)
    fireEvent.pointerLeave(header!)
    fireEvent.blur(image!)

    expect(image?.getAttribute('src')).toBe(animatedUrl)
  })

  it('uses the static banner preview when reduced motion is enabled', () => {
    mocks.prefersReducedMotion = true

    const { container } = render(<ChannelSidebar />)
    const image = container.querySelector('header img')

    expect(image?.getAttribute('src')).toBe(serverBannerUrl(banner as never))
  })
})
