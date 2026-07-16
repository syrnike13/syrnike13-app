import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sendChannelMessage } from '#/features/api/messages-api'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  apiRequest: (...args: Parameters<typeof mocks.apiRequest>) =>
    mocks.apiRequest(...args),
}))

describe('messages api', () => {
  beforeEach(() => {
    mocks.apiRequest.mockReset()
    mocks.apiRequest.mockResolvedValue({ _id: 'message-1' })
  })

  it('passes the composer nonce in the message body', async () => {
    await sendChannelMessage('session-token', 'channel-1', {
      nonce: 'composer-nonce',
      content: ' Message ',
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/channels/channel-1/messages',
      {
        method: 'POST',
        token: 'session-token',
        body: { nonce: 'composer-nonce', content: 'Message' },
      },
    )
  })
})
