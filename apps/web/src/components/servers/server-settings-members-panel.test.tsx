// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsMembersPanel } from '#/components/servers/server-settings-members-panel'
import { syncStore } from '#/features/sync/sync-store'

const interactiveShellMock = vi.hoisted(() => vi.fn())

vi.mock('#/components/user/user-interactive-shell', () => ({
  UserInteractiveShell: (props: {
    user: { _id: string }
    serverId?: string
    children: ReactElement
  }) => {
    interactiveShellMock(props)
    return props.children
  },
}))

function setupMembers() {
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
      display_name: 'Target',
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
        permissions: { a: 0, d: 0 },
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
      joined_at: '2024-02-03T00:00:00Z',
      nickname: 'Server Nick',
      roles: ['member'],
    } as never,
  ])
}

describe('ServerSettingsMembersPanel', () => {
  beforeEach(() => {
    setupMembers()
    interactiveShellMock.mockClear()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('renders members as a compact table with roles and joined date', () => {
    render(<ServerSettingsMembersPanel serverId="server-1" />)

    expect(screen.getByText('Имя')).toBeTruthy()
    expect(screen.getByText('Роли')).toBeTruthy()
    expect(screen.getByText('Дата вступления')).toBeTruthy()
    expect(screen.getByText('Server Nick')).toBeTruthy()
    expect(screen.getByText('Member')).toBeTruthy()
    expect(screen.getByText('03.02.2024')).toBeTruthy()
  })

  it('filters members by server nickname and role name', () => {
    render(<ServerSettingsMembersPanel serverId="server-1" />)

    fireEvent.change(screen.getByPlaceholderText('Поиск участников…'), {
      target: { value: 'server nick' },
    })

    expect(screen.getByText('Server Nick')).toBeTruthy()
    expect(screen.queryByText('@mod')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Поиск участников…'), {
      target: { value: 'mod' },
    })

    expect(screen.getByText('@mod')).toBeTruthy()
    expect(screen.queryByText('Server Nick')).toBeNull()
  })

  it('wraps each row in the shared user interactive shell', () => {
    render(<ServerSettingsMembersPanel serverId="server-1" />)

    expect(interactiveShellMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'server-1',
        user: expect.objectContaining({ _id: 'target-user' }),
      }),
    )
  })
})
