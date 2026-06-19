// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
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

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
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
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.change(screen.getByLabelText('Причина модерации'), {
      target: { value: 'raid cleanup' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Исключить' }))
    expect(confirmSpy).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Исключить' }).at(-1)!,
    )

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
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.change(screen.getByLabelText('Причина модерации'), {
      target: { value: 'spam' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Забанить' }))
    expect(confirmSpy).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Забанить' }).at(-1)!,
    )

    await waitFor(() => {
      expect(mocks.banServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'target-user',
        { reason: 'spam' },
      )
    })
  })

  it('passes the selected message deletion window when banning a member', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.change(screen.getByLabelText('Причина модерации'), {
      target: { value: 'spam wave' },
    })
    fireEvent.change(screen.getByLabelText('Удалить историю сообщений'), {
      target: { value: '3600' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Забанить' }))
    expect(confirmSpy).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Забанить' }).at(-1)!,
    )

    await waitFor(() => {
      expect(mocks.banServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'target-user',
        { reason: 'spam wave', delete_message_seconds: 3600 },
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

  it('applies the selected member timeout preset', async () => {
    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Тайм-аут на 10 минут' }))

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'target-user',
        { timeout: '2026-06-19T10:10:00.000Z' },
      )
    })
  })

  it('removes an active member timeout', async () => {
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'target-user' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['member'],
        timeout: '2026-06-19T10:30:00.000Z',
      } as never,
    ])
    mocks.editServerMember.mockResolvedValue({
      _id: { server: 'server-1', user: 'target-user' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: ['member'],
    })

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Снять тайм-аут' }))

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'target-user',
        { remove: ['Timeout'] },
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

  it('searches members by server nickname', () => {
    setupMembers(ChannelPermission.ManageNicknames)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'target-user' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['member'],
        nickname: 'Kitchen Wizard',
      } as never,
    ])

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.change(screen.getByPlaceholderText('Поиск участников…'), {
      target: { value: 'wizard' },
    })

    expect(screen.getByRole('button', { name: /Kitchen Wizard/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /mod/i })).toBeNull()
  })

  it('uses the server nickname as the selected member display name', () => {
    setupMembers(ChannelPermission.ManageNicknames)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'target-user' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['member'],
        nickname: 'Kitchen Wizard',
      } as never,
    ])

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /Kitchen Wizard/i }))

    expect(screen.getByText('Kitchen Wizard', { selector: 'p' })).toBeTruthy()
    expect(screen.getByText('@target')).toBeTruthy()
  })

  it('filters roles for the selected member', () => {
    setupMembers(ChannelPermission.AssignRoles)
    const server = syncStore.getState().servers['server-1']
    syncStore.upsertServer({
      ...server,
      roles: {
        ...server.roles,
        muted: {
          _id: 'muted',
          name: 'Muted',
          permissions: { a: 0, d: 0 },
          rank: 4,
          mentionable: false,
        },
        builder: {
          _id: 'builder',
          name: 'Builder',
          permissions: { a: 0, d: 0 },
          rank: 6,
          mentionable: false,
        },
      },
    } as never)

    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /target/i }))

    expect(screen.getByText('Muted')).toBeTruthy()
    expect(screen.getByText('Builder')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Поиск ролей'), {
      target: { value: 'mute' },
    })

    expect(screen.getByText('Muted')).toBeTruthy()
    expect(screen.queryByText('Builder')).toBeNull()
  })
})
