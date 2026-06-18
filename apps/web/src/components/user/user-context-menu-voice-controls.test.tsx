// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Member, Server } from '@syrnike13/api-types'
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

const ACTOR_USER_ID = '01JVOICEACTOR00000001'
const TARGET_USER_ID = '01JVOICETARGET0000001'
const server = makeServer()
const actorMember = makeMember(ACTOR_USER_ID, ['mod'])

function renderControls(targetMember: Member = makeMember(TARGET_USER_ID, ['member'])) {
  render(
    <UserContextMenuVoiceControls
      userId={TARGET_USER_ID}
      token="session-token"
      server={server}
      actorMember={actorMember}
      actorUserId={ACTOR_USER_ID}
      targetMember={targetMember}
      voiceChannelId="voice-1"
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
})
