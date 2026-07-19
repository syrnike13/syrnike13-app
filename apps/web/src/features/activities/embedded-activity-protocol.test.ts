import { describe, expect, it } from 'vitest'

import { isEmbeddedActivityClientMessage } from './embedded-activity-protocol'

describe('embedded Activity protocol', () => {
  it('accepts only the bounded host-facing command surface', () => {
    expect(
      isEmbeddedActivityClientMessage({
        type: 'syrnike.activity.command',
        command: { type: 'increment' },
      }),
    ).toBe(true)
    expect(
      isEmbeddedActivityClientMessage({ type: 'syrnike.activity.close' }),
    ).toBe(true)
    expect(
      isEmbeddedActivityClientMessage({
        type: 'syrnike.activity.token',
        token: 'session-token',
      }),
    ).toBe(false)
  })
})
