// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Channel, Webhook } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSettingsWebhooksPanel } from '#/components/channels/channel-settings-webhooks-panel'

const mocks = vi.hoisted(() => ({
  createChannelWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  fetchChannelWebhooks: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  writeClipboardText: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: (...args: Parameters<typeof mocks.toastError>) =>
      mocks.toastError(...args),
    success: (...args: Parameters<typeof mocks.toastSuccess>) =>
      mocks.toastSuccess(...args),
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/api/channels-api', () => ({
  createChannelWebhook: (...args: Parameters<typeof mocks.createChannelWebhook>) =>
    mocks.createChannelWebhook(...args),
  deleteWebhook: (...args: Parameters<typeof mocks.deleteWebhook>) =>
    mocks.deleteWebhook(...args),
  fetchChannelWebhooks: (...args: Parameters<typeof mocks.fetchChannelWebhooks>) =>
    mocks.fetchChannelWebhooks(...args),
}))

vi.mock('#/lib/clipboard', () => ({
  writeClipboardText: (...args: Parameters<typeof mocks.writeClipboardText>) =>
    mocks.writeClipboardText(...args),
}))

function textChannel(
  id: string,
  name: string,
  overrides: Partial<Extract<Channel, { channel_type: 'TextChannel' }>> = {},
) {
  return {
    _id: id,
    channel_type: 'TextChannel',
    server: 'server-1',
    name,
    description: null,
    nsfw: false,
    slowmode: 0,
    default_permissions: null,
    ...overrides,
  } satisfies Extract<Channel, { channel_type: 'TextChannel' }>
}

function webhook(overrides: Partial<Webhook> = {}) {
  return {
    id: 'webhook-1',
    name: 'Deploy bot',
    avatar: null,
    creator_id: 'user-1',
    channel_id: 'channel-1',
    permissions: 0,
    token: 'private-token',
    ...overrides,
  } satisfies Webhook
}

describe('ChannelSettingsWebhooksPanel', () => {
  beforeEach(() => {
    mocks.fetchChannelWebhooks.mockResolvedValue([webhook()])
    mocks.createChannelWebhook.mockResolvedValue(
      webhook({ id: 'webhook-2', name: 'Build bot' }),
    )
    mocks.deleteWebhook.mockResolvedValue(undefined)
    mocks.writeClipboardText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('loads existing webhooks for the channel', async () => {
    render(
      <ChannelSettingsWebhooksPanel
        channel={textChannel('channel-1', 'general')}
      />,
    )

    expect(await screen.findByText('Deploy bot')).not.toBeNull()
    expect(mocks.fetchChannelWebhooks).toHaveBeenCalledWith(
      'session-token',
      'channel-1',
    )
  })

  it('creates a webhook with the entered name', async () => {
    render(
      <ChannelSettingsWebhooksPanel
        channel={textChannel('channel-1', 'general')}
      />,
    )

    fireEvent.change(screen.getByLabelText('Название вебхука'), {
      target: { value: 'Build bot' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Создать вебхук' }))

    await waitFor(() => {
      expect(mocks.createChannelWebhook).toHaveBeenCalledWith(
        'session-token',
        'channel-1',
        { name: 'Build bot' },
      )
    })
    expect(await screen.findByText('Build bot')).not.toBeNull()
  })

  it('deletes a webhook after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <ChannelSettingsWebhooksPanel
        channel={textChannel('channel-1', 'general')}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Удалить Deploy bot' }),
    )

    await waitFor(() => {
      expect(mocks.deleteWebhook).toHaveBeenCalledWith(
        'session-token',
        'webhook-1',
      )
    })
    await waitFor(() => {
      expect(screen.queryByText('Deploy bot')).toBeNull()
    })
  })

  it('copies webhook url when token is available', async () => {
    render(
      <ChannelSettingsWebhooksPanel
        channel={textChannel('channel-1', 'general')}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Копировать URL Deploy bot',
      }),
    )

    await waitFor(() => {
      expect(mocks.writeClipboardText).toHaveBeenCalledWith(
        'https://syrnike13.ru/api/webhooks/webhook-1/private-token',
      )
    })
  })
})
