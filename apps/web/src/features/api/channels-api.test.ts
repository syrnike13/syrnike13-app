import { describe, expect, it, vi } from 'vitest'

import {
  createChannelWebhook,
  deleteWebhook,
  deleteChannel,
  editWebhook,
  fetchChannelWebhooks,
} from '#/features/api/channels-api'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  apiRequest: (...args: Parameters<typeof mocks.apiRequest>) =>
    mocks.apiRequest(...args),
}))

describe('channels api', () => {
  it('deletes channels with leave_silently encoded as a query option', async () => {
    mocks.apiRequest.mockResolvedValue(undefined)

    await deleteChannel('session-token', 'channel-1', true)

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/channels/channel-1?leave_silently=true',
      {
        method: 'DELETE',
        token: 'session-token',
      },
    )
  })

  it('fetches channel webhooks', async () => {
    mocks.apiRequest.mockResolvedValue([])

    await fetchChannelWebhooks('session-token', 'channel-1')

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/channels/channel-1/webhooks',
      { token: 'session-token' },
    )
  })

  it('creates a channel webhook', async () => {
    mocks.apiRequest.mockResolvedValue({ id: 'webhook-1' })

    await createChannelWebhook('session-token', 'channel-1', {
      name: 'Deploy bot',
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/channels/channel-1/webhooks',
      {
        method: 'POST',
        token: 'session-token',
        body: { name: 'Deploy bot' },
      },
    )
  })

  it('deletes a webhook', async () => {
    mocks.apiRequest.mockResolvedValue(undefined)

    await deleteWebhook('session-token', 'webhook-1')

    expect(mocks.apiRequest).toHaveBeenCalledWith('/webhooks/webhook-1', {
      method: 'DELETE',
      token: 'session-token',
    })
  })

  it('edits a webhook', async () => {
    mocks.apiRequest.mockResolvedValue({ id: 'webhook-1', name: 'Deploy bot' })

    await editWebhook('session-token', 'webhook-1', {
      name: 'Deploy alerts',
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith('/webhooks/webhook-1', {
      method: 'PATCH',
      token: 'session-token',
      body: { name: 'Deploy alerts' },
    })
  })
})
