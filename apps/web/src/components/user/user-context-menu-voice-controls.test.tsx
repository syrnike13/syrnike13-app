// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Channel, Member, Server } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserContextMenuVoiceControls } from '#/components/user/user-context-menu-voice-controls'
import { syncStore } from '#/features/sync/sync-store'
import { permissionOr } from '#/lib/permission-bits'
import { ChannelPermission } from '#/lib/permissions'

const mocks = vi.hoisted(() => ({
  editServerMember: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: (...args: Parameters<typeof mocks.toastError>) =>
      mocks.toastError(...args),
    success: (...args: Parameters<typeof mocks.toastSuccess>) =>
      mocks.toastSuccess(...args),
  },
}))

vi.mock('#/components/icons', () => ({
  HeadphonesIcon: () => <span />,
  HeadphoneOffIcon: () => <span />,
  MicOffIcon: () => <span />,
  PhoneOffIcon: () => <span />,
}))

vi.mock('#/features/api/servers-api', () => ({
  editServerMember: (...args: Parameters<typeof mocks.editServerMember>) =>
    mocks.editServerMember(...args),
}))

vi.mock('#/components/ui/context-menu', () => ({
  ContextMenuCheckboxItem: ({
    children,
    checked,
    disabled,
    onCheckedChange,
    onSelect,
  }: {
    children: ReactNode
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
    onSelect?: (event: { preventDefault: () => void }) => void
  }) => (
    <button
      type="button"
      aria-pressed={checked === true}
      disabled={disabled}
      onClick={() => {
        onSelect?.({ preventDefault: vi.fn() })
        onCheckedChange?.(!(checked === true))
      }}
    >
      {children}
    </button>
  ),
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  ContextMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuSub: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSubContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSubTrigger: ({
    children,
    disabled,
  }: {
    children: ReactNode
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
}))

vi.mock('#/components/ui/slider', () => ({
  Slider: () => <input aria-label="voice volume" readOnly />,
}))

function makeServer(): Server {
  return {
    _id: 'server-1',
    owner: 'owner-user',
    name: 'Server',
    channels: [],
    default_permissions: 0,
    roles: {
      mod: {
        _id: 'mod',
        name: 'Mod',
        permissions: {
          a: permissionOr(
            permissionOr(
              ChannelPermission.MuteMembers,
              ChannelPermission.DeafenMembers,
            ),
            ChannelPermission.MoveMembers,
          ),
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
  } as Server
}

function makeMember(userId: string, roles: string[]): Member {
  return {
    _id: { server: 'server-1', user: userId },
    joined_at: '2024-01-01T00:00:00Z',
    roles,
  } as Member
}

function makeVoiceChannel(
  id: string,
  name: string,
  defaultPermissions = {
    a: permissionOr(ChannelPermission.ViewChannel, ChannelPermission.Connect),
    d: 0,
  },
): Channel {
  return {
    _id: id,
    channel_type: 'TextChannel',
    server: 'server-1',
    name,
    default_permissions: defaultPermissions,
    voice: { max_users: null },
  } as Channel
}

function makeLegacyVoiceChannel(id: string, name: string): Channel {
  return {
    _id: id,
    channel_type: 'VoiceChannel',
    server: 'server-1',
    name,
    default_permissions: {
      a: ChannelPermission.ViewChannel,
      d: ChannelPermission.Connect,
    },
    role_permissions: {},
  } as unknown as Channel
}

const ACTOR_USER_ID = '01JVOICEACTOR00000001'
const TARGET_USER_ID = '01JVOICETARGET0000001'
const server = makeServer()
const actorMember = makeMember(ACTOR_USER_ID, ['mod'])

function renderControls(
  targetMember: Member = makeMember(TARGET_USER_ID, ['member']),
  moveVoiceChannels: Channel[] = [
    makeVoiceChannel('voice-1', 'Lobby'),
    makeVoiceChannel('voice-2', 'Raid Room'),
  ],
) {
  render(
    <UserContextMenuVoiceControls
      userId={TARGET_USER_ID}
      token="session-token"
      server={server}
      actorMember={actorMember}
      actorUserId={ACTOR_USER_ID}
      targetMember={targetMember}
      voiceChannelId="voice-1"
      moveVoiceChannels={moveVoiceChannels}
    />,
  )
}

describe('UserContextMenuVoiceControls server moderation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncStore.reset()
    syncStore.patchVoiceParticipant('voice-1', TARGET_USER_ID, {
      joined_at: 1,
      self_mute: false,
      self_deaf: false,
      server_muted: false,
      server_deafened: false,
      screensharing: false,
      camera: false,
      version: 1,
    })
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('server-mutes a voice participant through member edit', async () => {
    mocks.editServerMember.mockResolvedValue({
      ...makeMember(TARGET_USER_ID, ['member']),
      can_publish: false,
    })

    renderControls()

    fireEvent.click(screen.getByRole('button', { name: 'Отключить микрофон' }))

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        TARGET_USER_ID,
        { can_publish: false },
      )
    })
    expect(syncStore.getState().members[`server-1:${TARGET_USER_ID}`]?.can_publish).toBe(
      false,
    )
  })

  it('server-deafens a voice participant through member edit', async () => {
    mocks.editServerMember.mockResolvedValue({
      ...makeMember(TARGET_USER_ID, ['member']),
      can_receive: false,
    })

    renderControls()

    fireEvent.click(screen.getByRole('button', { name: 'Отключить звук' }))

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        TARGET_USER_ID,
        { can_receive: false },
      )
    })
    expect(syncStore.getState().members[`server-1:${TARGET_USER_ID}`]?.can_receive).toBe(
      false,
    )
  })

  it('hides server moderation actions without a current voice channel', () => {
    render(
      <UserContextMenuVoiceControls
        userId={TARGET_USER_ID}
        token="session-token"
        server={server}
        actorMember={actorMember}
        actorUserId={ACTOR_USER_ID}
        targetMember={makeMember(TARGET_USER_ID, ['member'])}
        moveVoiceChannels={[makeVoiceChannel('voice-2', 'Raid Room')]}
      />,
    )

    expect(screen.getByRole('button', { name: 'Заглушить голос' })).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Отключить микрофон' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Отключить звук' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Отключить от голосового канала' }),
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Raid Room' })).toBeNull()
  })

  it('disconnects a voice participant from the current voice channel', async () => {
    mocks.editServerMember.mockResolvedValue(makeMember(TARGET_USER_ID, ['member']))

    renderControls()

    fireEvent.click(
      screen.getByRole('button', { name: 'Отключить от голосового канала' }),
    )

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        TARGET_USER_ID,
        { remove: ['VoiceChannel'] },
      )
    })
    expect(
      syncStore.getState().voiceParticipants['voice-1']?.[TARGET_USER_ID],
    ).toBeUndefined()
  })

  it('does not restore a temporary member removed before disconnect responds', async () => {
    const temporaryMember = {
      ...makeMember(TARGET_USER_ID, []),
      temporary: true,
    }
    syncStore.upsertMembers([temporaryMember])
    mocks.editServerMember.mockImplementation(async () => {
      syncStore.removeServerMember('server-1', TARGET_USER_ID)
      return temporaryMember
    })

    renderControls(temporaryMember)

    fireEvent.click(
      screen.getByRole('button', { name: 'Отключить от голосового канала' }),
    )

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        TARGET_USER_ID,
        { remove: ['VoiceChannel'] },
      )
    })
    expect(
      syncStore.getState().members[`server-1:${TARGET_USER_ID}`],
    ).toBeUndefined()
  })

  it('does not restore a temporary member removed before moderation responds', async () => {
    const temporaryMember = {
      ...makeMember(TARGET_USER_ID, []),
      temporary: true,
    }
    const updatedMember = { ...temporaryMember, can_publish: false }
    syncStore.upsertMembers([temporaryMember])
    mocks.editServerMember.mockImplementation(async () => {
      syncStore.removeServerMember('server-1', TARGET_USER_ID)
      return updatedMember
    })

    renderControls(temporaryMember)

    fireEvent.click(screen.getByRole('button', { name: 'Отключить микрофон' }))

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        TARGET_USER_ID,
        { can_publish: false },
      )
    })
    expect(
      syncStore.getState().members[`server-1:${TARGET_USER_ID}`],
    ).toBeUndefined()
  })

  it('updates a temporary member that still exists when moderation responds', async () => {
    const temporaryMember = {
      ...makeMember(TARGET_USER_ID, []),
      temporary: true,
    }
    const updatedMember = { ...temporaryMember, can_publish: false }
    syncStore.upsertMembers([temporaryMember])
    mocks.editServerMember.mockResolvedValue(updatedMember)

    renderControls(temporaryMember)

    fireEvent.click(screen.getByRole('button', { name: 'Отключить микрофон' }))

    await waitFor(() => {
      expect(
        syncStore.getState().members[`server-1:${TARGET_USER_ID}`]?.can_publish,
      ).toBe(false)
    })
  })

  it('moves a voice participant to another voice channel', async () => {
    mocks.editServerMember.mockResolvedValue(
      makeMember(TARGET_USER_ID, ['member']),
    )

    renderControls()

    fireEvent.click(screen.getByRole('button', { name: 'Raid Room' }))

    await waitFor(() => {
      expect(mocks.editServerMember).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        TARGET_USER_ID,
        { voice_channel: 'voice-2' },
      )
    })
    expect(
      syncStore.getState().voiceParticipants['voice-1']?.[TARGET_USER_ID],
    ).toBeUndefined()
    expect(
      syncStore.getState().voiceParticipants['voice-2']?.[TARGET_USER_ID],
    ).toEqual(
      expect.objectContaining({
        id: TARGET_USER_ID,
      }),
    )
  })

  it('hides move targets the actor cannot connect to', () => {
    renderControls(makeMember(TARGET_USER_ID, ['member']), [
      makeVoiceChannel('voice-1', 'Lobby'),
      makeVoiceChannel('voice-2', 'Raid Room'),
      makeVoiceChannel('voice-locked', 'Locked Room', {
        a: ChannelPermission.ViewChannel,
        d: ChannelPermission.Connect,
      }),
    ])

    expect(screen.getByRole('button', { name: 'Raid Room' })).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Locked Room' }),
    ).toBeNull()
  })

  it('hides legacy voice move targets the actor cannot connect to', () => {
    renderControls(makeMember(TARGET_USER_ID, ['member']), [
      makeVoiceChannel('voice-1', 'Lobby'),
      makeLegacyVoiceChannel('voice-legacy-locked', 'Legacy Locked Room'),
    ])

    expect(
      screen.queryByRole('button', { name: 'Legacy Locked Room' }),
    ).toBeNull()
  })
})
