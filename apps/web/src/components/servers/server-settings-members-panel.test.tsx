// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsMembersPanel } from '#/components/servers/server-settings-members-panel'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'

const mocks = vi.hoisted(() => ({
  kickServerMember: vi.fn(),
  banServerMember: vi.fn(),
  editServerMember: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'mod-user', username: 'mod' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  kickServerMember: (...args: Parameters<typeof mocks.kickServerMember>) =>
    mocks.kickServerMember(...args),
  banServerMember: (...args: Parameters<typeof mocks.banServerMember>) =>
    mocks.banServerMember(...args),
  editServerMember: (...args: Parameters<typeof mocks.editServerMember>) =>
    mocks.editServerMember(...args),
}))

function setupMembers(
  actorPermissions =
    ChannelPermission.KickMembers |
    ChannelPermission.BanMembers |
    ChannelPermission.TimeoutMembers,
) {
  syncStore.reset()
  syncStore.upsertUsers([
    {
      _id: 'mod-user',
      username: 'mod',
      discriminator: '0001',
    } as never,
    {
      _id: 'target-user',
      username: 'target',
      discriminator: '0002',
    } as never,
  ])
  syncStore.upsertServer({
    _id: 'server-1',
    name: 'Server',
    owner: 'owner-user',
    channels: [],
    default_permissions: 0,
    roles: {
      mod: {
        _id: 'mod',
        name: 'Mod',
        permissions: {
          a: actorPermissions,
          d: 0,
        },
        rank: 1,
        mentionable: false,
      },
      member: {
        _id: 'member',
        name: 'Member',
        permissions: { a: 0, d: 0 },
        rank: 5,
        mentionable: false,
      },
    },
  } as never)
  syncStore.upsertMembers([
    {
      _id: { server: 'server-1', user: 'mod-user' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: ['mod'],
    } as never,
    {
      _id: { server: 'server-1', user: 'target-user' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: ['member'],
    } as never,
  ])
}

describe('ServerSettingsMembersPanel moderation controls', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-06-19T10:00:00.000Z').getTime(),
    )
    setupMembers()
    mocks.kickServerMember.mockResolvedValue(undefined)
    mocks.banServerMember.mockResolvedValue(undefined)
    mocks.editServerMember.mockResolvedValue({
      _id: { server: 'server-1', user: 'target-user' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: ['member'],
      timeout: '2026-06-19T11:00:00.000Z',
    })
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('lets a moderation-only manager kick a member with an audit reason', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.change(screen.getByLabelText('Причина модерации'), {
      target: { value: 'raid cleanup' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Исключить' }))

    await waitFor(() => {
      expect(mocks.kickServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'target-user',
        { reason: 'raid cleanup' },
      )
    })
    expect(syncStore.getState().members['server-1:target-user']).toBeUndefined()
  })

  it('lets a moderation-only manager ban a member with an audit reason', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.change(screen.getByLabelText('Причина модерации'), {
      target: { value: 'spam' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Забанить' }))

    await waitFor(() => {
      expect(mocks.banServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'target-user',
        { reason: 'spam' },
      )
    })
  })

  it('applies a one hour member timeout', async () => {
    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Тайм-аут на 1 час' }))

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'target-user',
        { timeout: '2026-06-19T11:00:00.000Z' },
      )
    })
  })

  it('lets a nickname manager rename a lower-ranked member', async () => {
    setupMembers(ChannelPermission.ManageNicknames)
    mocks.editServerMember.mockResolvedValue({
      _id: { server: 'server-1', user: 'target-user' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: ['member'],
      nickname: 'Renamed',
    })

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.change(screen.getByLabelText('Никнейм на сервере'), {
      target: { value: 'Renamed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ник' }))

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'target-user',
        { nickname: 'Renamed' },
      )
    })
  })
})
