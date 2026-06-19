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
const editMemberRolesDialogPropsMock = vi.hoisted(() => vi.fn())
const serverApiMocks = vi.hoisted(() => ({
  banServerMember: vi.fn(),
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

vi.mock('#/features/voice/voice-context', () => ({
  useVoice: () => ({
    join: voiceJoinMock,
  }),
}))

vi.mock('#/features/dm/dm-actions', () => ({
  openDirectMessageChannel: openDirectMessageChannelMock,
}))

vi.mock('#/features/api/servers-api', () => ({
  banServerMember: (...args: Parameters<typeof serverApiMocks.banServerMember>) =>
    serverApiMocks.banServerMember(...args),
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

vi.mock('#/components/servers/edit-member-roles-dialog', () => ({
  EditMemberRolesDialog: (props: { open: boolean }) => {
    editMemberRolesDialogPropsMock(props)
    return props.open ? <div data-testid="member-roles-dialog" /> : null
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
    onSelect,
  }: {
    children: ReactNode
    onSelect?: (event: { preventDefault: () => void }) => void
  }) => (
    <button
      type="button"
      onClick={() => onSelect?.({ preventDefault: vi.fn() })}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
}))

const targetUser = {
  _id: '01JVOICETARGET0000001',
  username: 'bob',
  discriminator: '0002',
  relationship: 'Friend',
  online: true,
} as User

describe('UserContextMenuContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    voiceJoinMock.mockResolvedValue(true)
    serverApiMocks.banServerMember.mockResolvedValue(undefined)
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

  it('opens member role editing from a server user context menu', () => {
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

    render(<UserContextMenuContent user={targetUser} serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Роли' }))

    expect(screen.getByTestId('member-roles-dialog')).toBeTruthy()
    expect(editMemberRolesDialogPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        server: expect.objectContaining({ _id: 'server-1' }),
        targetMember: expect.objectContaining({
          _id: { server: 'server-1', user: '01JVOICETARGET0000001' },
        }),
        targetUser,
        open: true,
      }),
    )
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
