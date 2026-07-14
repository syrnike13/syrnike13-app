// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Channel, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserContextMenuContent } from './user-context-menu-content'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'

const navigateMock = vi.hoisted(() => vi.fn())
const voiceJoinMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const voiceControlsPropsMock = vi.hoisted(() => vi.fn())
const contextMenuPreventDefaultMock = vi.hoisted(() => vi.fn())
const serverApiMocks = vi.hoisted(() => ({
  banServerMember: vi.fn(),
  editServerMember: vi.fn(),
  kickServerMember: vi.fn(),
}))
const openDirectMessageChannelMock = vi.hoisted(() =>
  vi.fn(
    async (
      _token: string,
      _userId: string,
      navigateToChannel: (channelId: string) => Promise<void> | void,
    ) => {
      await navigateToChannel('dm-1')
      return {
        _id: 'dm-1',
        channel_type: 'DirectMessage',
        active: true,
        recipients: ['current-user', '01JVOICETARGET0000001'],
      } as Channel
    },
  ),
)

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/app/' } }),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'current-user', username: 'me' },
  }),
}))

vi.mock('#/features/voice/voice-session-context', () => ({
  useVoiceSession: () => ({
    join: voiceJoinMock,
  }),
}))

vi.mock('#/features/dm/dm-actions', () => ({
  openDirectMessageChannel: openDirectMessageChannelMock,
}))

vi.mock('#/features/api/servers-api', () => ({
  banServerMember: (...args: Parameters<typeof serverApiMocks.banServerMember>) =>
    serverApiMocks.banServerMember(...args),
  editServerMember: (...args: Parameters<typeof serverApiMocks.editServerMember>) =>
    serverApiMocks.editServerMember(...args),
  kickServerMember: (...args: Parameters<typeof serverApiMocks.kickServerMember>) =>
    serverApiMocks.kickServerMember(...args),
}))

vi.mock('#/features/settings/settings-modal-context', () => ({
  useSettingsModal: () => ({ openSettings: vi.fn() }),
}))

vi.mock('#/components/friends/friendship-action', () => ({
  FriendshipContextMenuItems: () => null,
}))

vi.mock('#/components/user/user-context-menu-voice-controls', () => ({
  UserContextMenuVoiceControls: (props: unknown) => {
    voiceControlsPropsMock(props)
    return <div data-testid="voice-controls" />
  },
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

vi.mock('#/components/ui/context-menu', () => ({
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuItem: ({
    children,
    className,
    disabled,
    onSelect,
    ...props
  }: {
    children: ReactNode
    className?: string
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
  }) => (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() =>
        onSelect?.({ preventDefault: contextMenuPreventDefaultMock })
      }
      {...props}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSubContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSubTrigger: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => (
    <button type="button" className={className}>
      {children}
    </button>
  ),
}))

const targetUser = {
  _id: '01JVOICETARGET0000001',
  username: 'bob',
  discriminator: '0002',
  relationship: 'Friend',
  online: true,
} as User

function seedRoleToggleServer() {
  syncStore.upsertServer({
    _id: 'server-1',
    name: 'Server',
    owner: 'owner-user',
    channels: [],
    default_permissions: 0,
    roles: {
      manager: {
        _id: 'manager',
        name: 'Manager',
        permissions: { a: ChannelPermission.AssignRoles, d: 0 },
        rank: 1,
      },
      member: {
        _id: 'member',
        name: 'Member',
        permissions: { a: 0, d: 0 },
        rank: 5,
      },
      assignable: {
        _id: 'assignable',
        name: 'Assignable',
        permissions: { a: 0, d: 0 },
        rank: 6,
      },
    },
  } as never)
  syncStore.upsertMembers([
    {
      _id: { server: 'server-1', user: 'current-user' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: ['manager'],
    } as never,
    {
      _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: ['member'],
    } as never,
  ])
}

describe('UserContextMenuContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    contextMenuPreventDefaultMock.mockClear()
    voiceJoinMock.mockResolvedValue(true)
    serverApiMocks.banServerMember.mockResolvedValue(undefined)
    serverApiMocks.editServerMember.mockResolvedValue({
      _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: [],
    })
    serverApiMocks.kickServerMember.mockResolvedValue(undefined)
    syncStore.reset()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('starts a direct message call from the user context menu', async () => {
    render(<UserContextMenuContent user={targetUser} />)

    fireEvent.click(screen.getByRole('button', { name: 'Позвонить' }))

    await waitFor(() => {
      expect(openDirectMessageChannelMock).toHaveBeenCalledWith(
        'session-token',
        '01JVOICETARGET0000001',
        expect.any(Function),
      )
    })
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'dm-1' },
      search: { m: undefined },
    })
    expect(voiceJoinMock).toHaveBeenCalledWith('dm-1')
  })

  it('passes server voice moderation context to voice controls', () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'current-user',
      channels: ['voice-1'],
      default_permissions: 0,
      roles: {},
    } as never)
    syncStore.upsertChannel({
      _id: 'voice-1',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'Voice',
      default_permissions: null,
      voice: { max_users: null },
    } as never)
    syncStore.upsertChannel({
      _id: 'voice-2',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'Raid Room',
      default_permissions: null,
      voice: { max_users: null },
    } as never)
    syncStore.upsertChannel({
      _id: 'text-1',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'general',
      default_permissions: null,
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'current-user' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
      {
        _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
    ])
    syncStore.patchVoiceParticipant('voice-1', '01JVOICETARGET0000001', {
      joined_at: 1,
      self_mute: false,
      self_deaf: false,
      server_muted: false,
      server_deafened: false,
      screensharing: false,
      camera: false,
      version: 1,
    })

    render(
      <UserContextMenuContent
        user={targetUser}
        serverId="server-1"
        inVoice
      />,
    )

    expect(screen.getByTestId('voice-controls')).toBeTruthy()
    expect(voiceControlsPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '01JVOICETARGET0000001',
        token: 'session-token',
        actorUserId: 'current-user',
        server: expect.objectContaining({ _id: 'server-1' }),
        actorMember: expect.objectContaining({
          _id: { server: 'server-1', user: 'current-user' },
        }),
        targetMember: expect.objectContaining({
          _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
        }),
        voiceChannelId: 'voice-1',
        moveVoiceChannels: [
          expect.objectContaining({ _id: 'voice-1' }),
          expect.objectContaining({ _id: 'voice-2' }),
        ],
      }),
    )
  })

  it('keeps ordinary voice controls but passes no server voice channel when the target is not in server voice', () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'current-user',
      channels: ['voice-1'],
      default_permissions: 0,
      roles: {},
    } as never)
    syncStore.upsertChannel({
      _id: 'voice-1',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'Voice',
      default_permissions: null,
      voice: { max_users: null },
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'current-user' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
      {
        _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
    ])

    render(
      <UserContextMenuContent
        user={targetUser}
        serverId="server-1"
        inVoice
      />,
    )

    expect(screen.getByTestId('voice-controls')).toBeTruthy()
    expect(voiceControlsPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceChannelId: undefined,
      }),
    )
  })

  it('toggles a member role from the server user context menu', async () => {
    seedRoleToggleServer()

    render(<UserContextMenuContent user={targetUser} serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /Member/ }))
    expect(contextMenuPreventDefaultMock).toHaveBeenCalled()

    await waitFor(() => {
      expect(serverApiMocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        '01JVOICETARGET0000001',
        { roles: [] },
      )
    })
  })

  it('deduplicates a pending role edit after the context menu is reopened', () => {
    let resolveEdit: ((member: unknown) => void) | undefined
    serverApiMocks.editServerMember.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEdit = resolve
        }),
    )
    seedRoleToggleServer()

    const firstRender = render(
      <UserContextMenuContent user={targetUser} serverId="server-1" />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Member/ }))
    firstRender.unmount()

    render(<UserContextMenuContent user={targetUser} serverId="server-1" />)
    fireEvent.click(screen.getByRole('button', { name: /Member/ }))

    expect(serverApiMocks.editServerMember).toHaveBeenCalledTimes(1)
    resolveEdit?.({
      _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: [],
    })
  })

  it('disables every role while a member role edit is pending', async () => {
    let resolveEdit: ((member: unknown) => void) | undefined
    serverApiMocks.editServerMember.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEdit = resolve
        }),
    )
    seedRoleToggleServer()

    render(<UserContextMenuContent user={targetUser} serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: /Member/ }))

    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Member/ }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Assignable/ }).disabled).toBe(true)
    expect(
      screen.getByRole('button', { name: /Assignable/ }).className,
    ).not.toContain('data-[disabled]:bg-accent/45')

    resolveEdit?.({
      _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
      joined_at: '2024-01-01T00:00:00Z',
      roles: [],
    })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /Assignable/ }).disabled).toBe(
        false,
      )
    })
  })

  it('shows only assignable roles and disabled assigned roles in the server user context menu', () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-user',
      channels: [],
      default_permissions: 0,
      roles: {
        manager: {
          _id: 'manager',
          name: 'Manager',
          permissions: { a: ChannelPermission.AssignRoles, d: 0 },
          rank: 10,
        },
        assignedLocked: {
          _id: 'assignedLocked',
          name: 'Assigned Locked',
          permissions: { a: 0, d: 0 },
          rank: 1,
        },
        assignable: {
          _id: 'assignable',
          name: 'Assignable',
          permissions: { a: 0, d: 0 },
          rank: 20,
        },
        assignedRemovable: {
          _id: 'assignedRemovable',
          name: 'Assigned Removable',
          permissions: { a: 0, d: 0 },
          rank: 25,
        },
        hidden: {
          _id: 'hidden',
          name: 'Hidden',
          permissions: { a: 0, d: 0 },
          rank: 5,
        },
      },
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'current-user' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['manager'],
      } as never,
      {
        _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['assignedLocked', 'assignedRemovable'],
      } as never,
    ])

    render(<UserContextMenuContent user={targetUser} serverId="server-1" />)

    const rolesTrigger = screen.getByRole('button', { name: /Роли/ })
    expect(rolesTrigger.className).toContain('svg:last-child')
    expect(rolesTrigger.className).toContain('gap-2')

    const assignable = screen.getByRole<HTMLButtonElement>('button', { name: /Assignable/ })
    expect(assignable.disabled).toBe(false)
    expect(assignable.className).toContain('grid-cols-[1rem_minmax(0,1fr)_1rem]')

    const assignedRemovable = screen.getByRole<HTMLButtonElement>('button', {
      name: /Assigned Removable/,
    })
    expect(assignedRemovable.disabled).toBe(false)
    expect(assignedRemovable.className).not.toContain('bg-accent/60')
    expect(
      assignedRemovable.querySelector('[data-role-indicator="assigned"]'),
    ).toBeTruthy()

    const assignedLocked = screen.getByRole('button', {
      name: /Assigned Locked/,
    })
    expect(assignedLocked).toHaveProperty('disabled', true)
    expect(
      assignedLocked.querySelector('[data-role-indicator="locked"]'),
    ).toBeTruthy()
    expect(assignedLocked.className).toContain(
      'data-[disabled]:bg-accent/45',
    )
    expect(screen.queryByRole('button', { name: /Hidden/ })).toBeNull()
    expect(
      screen.queryByRole('button', { pressed: true }),
    ).toBeNull()
  })

  it('confirms a server ban with reason and message deletion window', async () => {
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
          permissions: { a: ChannelPermission.BanMembers, d: 0 },
          rank: 1,
        },
        member: {
          _id: 'member',
          name: 'Member',
          permissions: { a: 0, d: 0 },
          rank: 5,
        },
      },
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'current-user' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['mod'],
      } as never,
      {
        _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['member'],
      } as never,
    ])

    render(<UserContextMenuContent user={targetUser} serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Забанить на сервере' }))
    fireEvent.change(screen.getByLabelText('Причина'), {
      target: { value: 'spam wave' },
    })
    fireEvent.change(screen.getByLabelText('Удалить историю сообщений'), {
      target: { value: '86400' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Забанить' }))

    await waitFor(() => {
      expect(serverApiMocks.banServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        '01JVOICETARGET0000001',
        { reason: 'spam wave', delete_message_seconds: 86400 },
      )
    })
    expect(
      syncStore.getState().members['server-1:01JVOICETARGET0000001'],
    ).toBeUndefined()
  })

  it('confirms a server kick with an audit reason', async () => {
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
          permissions: { a: ChannelPermission.KickMembers, d: 0 },
          rank: 1,
        },
        member: {
          _id: 'member',
          name: 'Member',
          permissions: { a: 0, d: 0 },
          rank: 5,
        },
      },
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'current-user' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['mod'],
      } as never,
      {
        _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: ['member'],
      } as never,
    ])

    render(<UserContextMenuContent user={targetUser} serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Исключить с сервера' }))
    fireEvent.change(screen.getByLabelText('Причина исключения'), {
      target: { value: 'raid cleanup' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Исключить' }))

    await waitFor(() => {
      expect(serverApiMocks.kickServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        '01JVOICETARGET0000001',
        { reason: 'raid cleanup' },
      )
    })
    expect(
      syncStore.getState().members['server-1:01JVOICETARGET0000001'],
    ).toBeUndefined()
  })
})
