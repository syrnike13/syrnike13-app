import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sendChannelMessage } from '#/features/api/messages-api'

const mocks = vi.hoisted(() => ({
  apiRequestEffect: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  apiRequestEffect: (...args: Parameters<typeof mocks.apiRequestEffect>) =>
    mocks.apiRequestEffect(...args),
}))

describe('messages api', () => {
  beforeEach(() => {
    mocks.apiRequestEffect.mockReset()
    mocks.apiRequestEffect.mockReturnValue(
      Effect.succeed({ _id: 'message-1' }),
    )
  })

  it('passes the composer nonce in the message body', async () => {
    await sendChannelMessage('session-token', 'channel-1', {
      nonce: 'composer-nonce',
      content: ' Message ',
    })

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/channels/channel-1/messages',
      ApiSchema.MessageSendMessageSend200,
      {
        method: 'POST',
        token: 'session-token',
        body: { nonce: 'composer-nonce', content: 'Message' },
      },
    )
  })
})
