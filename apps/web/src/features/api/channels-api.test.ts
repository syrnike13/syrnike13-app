import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  createChannelWebhook,
  deleteChannel,
  deleteWebhook,
  editWebhook,
  fetchChannelWebhooks,
} from '#/features/api/channels-api'

const mocks = vi.hoisted(() => ({
  apiRequestEffect: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  apiRequestEffect: (...args: Parameters<typeof mocks.apiRequestEffect>) =>
    mocks.apiRequestEffect(...args),
}))

describe('channels api', () => {
  it('deletes channels with leave_silently encoded as a query option', async () => {
    mocks.apiRequestEffect.mockReturnValue(Effect.void)

    await deleteChannel('session-token', 'channel-1', true)

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/channels/channel-1?leave_silently=true',
      Schema.Void,
      {
        method: 'DELETE',
        token: 'session-token',
      },
    )
  })

  it('fetches channel webhooks', async () => {
    mocks.apiRequestEffect.mockReturnValue(Effect.succeed([]))

    await fetchChannelWebhooks('session-token', 'channel-1')

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/channels/channel-1/webhooks',
      ApiSchema.WebhookFetchAllFetchWebhooks200,
      { token: 'session-token' },
    )
  })

  it('creates a channel webhook', async () => {
    mocks.apiRequestEffect.mockReturnValue(
      Effect.succeed({ id: 'webhook-1' }),
    )

    await createChannelWebhook('session-token', 'channel-1', {
      name: 'Deploy bot',
    })

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/channels/channel-1/webhooks',
      ApiSchema.WebhookCreateCreateWebhook200,
      {
        method: 'POST',
        token: 'session-token',
        body: { name: 'Deploy bot' },
      },
    )
  })

  it('deletes a webhook', async () => {
    mocks.apiRequestEffect.mockReturnValue(Effect.void)

    await deleteWebhook('session-token', 'webhook-1')

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/webhooks/webhook-1',
      Schema.Void,
      {
        method: 'DELETE',
        token: 'session-token',
      },
    )
  })

  it('edits a webhook', async () => {
    mocks.apiRequestEffect.mockReturnValue(
      Effect.succeed({ id: 'webhook-1', name: 'Deploy bot' }),
    )

    await editWebhook('session-token', 'webhook-1', {
      name: 'Deploy alerts',
    })

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/webhooks/webhook-1',
      ApiSchema.WebhookEditWebhookEdit200,
      {
        method: 'PATCH',
        token: 'session-token',
        body: { name: 'Deploy alerts' },
      },
    )
  })
})
