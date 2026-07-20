// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ServerAvatar } from '#/components/servers/server-avatar'

const server = {
  _id: 'server-1',
  name: 'Demo',
  owner: 'user-1',
  channels: [],
  default_permissions: 0,
} as never

describe('ServerAvatar', () => {
  afterEach(cleanup)

  it('keeps the activity badge inside the avatar and uses a neutral background', () => {
    const { container } = render(
      <ServerAvatar
        server={server}
        animated={false}
        activity="voice"
        connected={false}
      />,
    )

    const badge = container.querySelector<HTMLElement>(
      '[data-slot="server-activity-badge"]',
    )
    expect(badge?.className).toContain('top-0.5')
    expect(badge?.className).toContain('right-0.5')
    expect(badge?.className).toContain('bg-muted-foreground')
    expect(badge?.hasAttribute('data-connected')).toBe(false)
  })

  it('uses the voice color while the current user is connected', () => {
    const { container } = render(
      <ServerAvatar
        server={server}
        animated={false}
        activity="screen-share"
        connected
      />,
    )

    const badge = container.querySelector<HTMLElement>(
      '[data-slot="server-activity-badge"]',
    )
    expect(badge?.className).toContain('bg-chart-3')
    expect(badge?.hasAttribute('data-connected')).toBe(true)
  })
})
