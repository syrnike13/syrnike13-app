// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Channel } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSettingsOverviewPanel } from '#/components/channels/channel-settings-overview-panel'
import { DraftProvider } from '#/components/settings/draft-controller-context'
import { UnsavedChangesBar } from '#/components/settings/unsaved-changes-bar'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  deleteChannel: vi.fn(),
  editChannel: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
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
  deleteChannel: (...args: Parameters<typeof mocks.deleteChannel>) =>
    mocks.deleteChannel(...args),
  editChannel: (...args: Parameters<typeof mocks.editChannel>) =>
    mocks.editChannel(...args),
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '/app',
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

function renderWithDraft(
  channel: Extract<Channel, { channel_type: 'TextChannel' }>,
) {
  return render(
    <DraftProvider>
      <ChannelSettingsOverviewPanel channel={channel} />
      <UnsavedChangesBar saveLabel="Сохранить" />
    </DraftProvider>,
  )
}

describe('ChannelSettingsOverviewPanel', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'user-1',
      channels: ['channel-1', 'channel-2'],
      default_permissions: 0,
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'user-1' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
    ])
    syncStore.upsertChannel(textChannel('channel-1', 'general'))
    syncStore.upsertChannel(textChannel('channel-2', 'next'))
    mocks.deleteChannel.mockResolvedValue(undefined)
    mocks.editChannel.mockResolvedValue(textChannel('channel-1', 'general'))
    mocks.navigate.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('deletes the current channel from the overview danger zone', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <ChannelSettingsOverviewPanel
        channel={textChannel('channel-1', 'general')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Удалить канал' }))

    await waitFor(() => {
      expect(mocks.deleteChannel).toHaveBeenCalledWith(
        'session-token',
        'channel-1',
      )
    })
    expect(syncStore.getState().channels['channel-1']).toBeUndefined()
    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/app/c/$channelId',
        params: { channelId: 'channel-2' },
        search: { m: undefined },
      })
    })
  })

  it('saves the text channel topic from overview settings', async () => {
    const channel = textChannel('channel-1', 'general')
    mocks.editChannel.mockResolvedValue({
      ...channel,
      description: 'Читайте закреп перед вопросами',
    })

    renderWithDraft(channel)

    fireEvent.change(screen.getByLabelText('Тема канала'), {
      target: { value: 'Читайте закреп перед вопросами' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editChannel).toHaveBeenCalledWith(
        'session-token',
        'channel-1',
        { description: 'Читайте закреп перед вопросами' },
      )
    })
  })

  it('removes the text channel topic when the field is cleared', async () => {
    const channel = textChannel('channel-1', 'general', {
      description: 'Старый топик',
    })
    mocks.editChannel.mockResolvedValue({ ...channel, description: null })

    renderWithDraft(channel)

    fireEvent.change(screen.getByLabelText('Тема канала'), {
      target: { value: '' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editChannel).toHaveBeenCalledWith(
        'session-token',
        'channel-1',
        { remove: ['Description'] },
      )
    })
  })
})
