import { describe, expect, it, vi } from 'vitest'

import { clearMessageReactions } from '#/features/api/messages-api'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  apiRequest: (...args: Parameters<typeof mocks.apiRequest>) =>
    mocks.apiRequest(...args),
}))

describe('message reactions api', () => {
  it('clears all reactions from a message', async () => {
    mocks.apiRequest.mockResolvedValue(undefined)

    await clearMessageReactions('session-token', 'channel-1', 'message-1')

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/channels/channel-1/messages/message-1/reactions',
      {
        method: 'DELETE',
        token: 'session-token',
      },
    )
  })
})
