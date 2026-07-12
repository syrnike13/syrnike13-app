// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsAuditPanel } from '#/components/servers/server-settings-audit-panel'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  fetchServerAuditLog: vi.fn(),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'actor-1', username: 'alice' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  fetchServerAuditLog: (...args: Parameters<typeof mocks.fetchServerAuditLog>) =>
    mocks.fetchServerAuditLog(...args),
}))

function renderWithQuery(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  )
}

function seedServer() {
  syncStore.reset()
  syncStore.upsertServer({
    _id: 'server-1',
    name: 'High School',
    owner: 'actor-1',
    channels: ['channel-1'],
    default_permissions: 0,
    roles: {
      'role-1': {
        _id: 'role-1',
        name: 'Прицел',
        permissions: { a: 0, d: 0 },
        rank: 1,
      },
      'role-2': {
        _id: 'role-2',
        name: 'Холостяк',
        permissions: { a: 0, d: 0 },
        rank: 5,
      },
      'role-3': {
        _id: 'role-3',
        name: 'Студ. Совет',
        permissions: { a: 0, d: 0 },
        rank: 6,
      },
      'role-4': {
        _id: 'role-4',
        name: 'AR 60 Арарфофла',
        permissions: { a: 0, d: 0 },
        rank: 7,
      },
      'role-5': {
        _id: 'role-5',
        name: 'AR 59 1000ms',
        permissions: { a: 0, d: 0 },
        rank: 8,
      },
      'role-6': {
        _id: 'role-6',
        name: 'AR 58 Speedrunner',
        permissions: { a: 0, d: 0 },
        rank: 9,
      },
      'role-7': {
        _id: 'role-7',
        name: 'AR 57 рыбак',
        permissions: { a: 0, d: 0 },
        rank: 10,
      },
      'role-8': {
        _id: 'role-8',
        name: '高校生',
        permissions: { a: 0, d: 0 },
        rank: 11,
      },
    },
  } as never)
  syncStore.upsertChannel({
    _id: 'channel-1',
    channel_type: 'TextChannel',
    server: 'server-1',
    name: 'цитаты',
    description: null,
    icon: null,
    default_permissions: null,
    role_permissions: {},
    user_permissions: {},
    nsfw: false,
    slowmode: 0,
    last_message_id: null,
  } as never)
  syncStore.upsertUsers([
    {
      _id: 'actor-1',
      username: 'nioh13',
      display_name: 'nioh13',
      avatar: null,
    } as never,
    {
      _id: 'user-2',
      username: 'waflya',
      display_name: 'waflya',
      avatar: null,
    } as never,
    {
      _id: 'user-3',
      username: 'tiredisa',
      display_name: 'tiredisa',
      avatar: null,
    } as never,
  ])
}

describe('ServerSettingsAuditPanel', () => {
  beforeEach(() => {
    seedServer()
    mocks.fetchServerAuditLog.mockResolvedValue({
      entries: [
        {
          _id: 'audit-1',
          server_id: 'server-1',
          actor_id: 'actor-1',
          action: { type: 'RoleCreate' },
          target: { type: 'Role', id: 'role-1' },
          reason: 'setup',
          changes: {},
          status: 'Succeeded',
          created_at: 0,
          completed_at: 1,
        },
      ],
      next_before: null,
    })
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('renders human audit entries without object type and id filters', async () => {
    const { container } = renderWithQuery(
      <ServerSettingsAuditPanel serverId="server-1" />,
    )

    const row = await screen.findByRole('button', {
      name: /nioh13 создал роль «Прицел»/,
    })
    fireEvent.click(row)

    expect(screen.getAllByText('Создание роли').length).toBeGreaterThan(0)
    expect(screen.getByText('setup')).toBeTruthy()
    expect(screen.queryByText('Тип объекта')).toBeNull()
    expect(screen.queryByText('ID объекта')).toBeNull()
    expect(container.textContent).not.toMatch(/Р[ЎЏќЈёµ°]|С[ЃЂ‚Њ‹]/)

    await waitFor(() => {
      expect(mocks.fetchServerAuditLog).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        { limit: 50 },
      )
    })
  })

  it('filters audit entries from the styled action dropdown', async () => {
    renderWithQuery(<ServerSettingsAuditPanel serverId="server-1" />)

    await screen.findByRole('button', {
      name: /nioh13 создал роль «Прицел»/,
    })
    fireEvent.click(screen.getByRole('button', { name: /Все действия/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Бан участника' }))

    await waitFor(() => {
      expect(mocks.fetchServerAuditLog).toHaveBeenLastCalledWith(
        'session-token',
        'server-1',
        { limit: 50, action: 'MemberBan' },
      )
    })
  })

  it('filters audit entries by searchable user dropdown', async () => {
    renderWithQuery(<ServerSettingsAuditPanel serverId="server-1" />)

    await screen.findByRole('button', {
      name: /nioh13 создал роль «Прицел»/,
    })
    fireEvent.click(screen.getByRole('button', { name: /Все пользователи/ }))
    fireEvent.change(screen.getByPlaceholderText('Найти пользователя'), {
      target: { value: 'waf' },
    })
    fireEvent.click(screen.getByRole('button', { name: /waflya/ }))

    await waitFor(() => {
      expect(mocks.fetchServerAuditLog).toHaveBeenLastCalledWith(
        'session-token',
        'server-1',
        { limit: 50, actor: 'user-2' },
      )
    })
  })

  it('shows readable audit change before and after values', async () => {
    mocks.fetchServerAuditLog.mockResolvedValue({
      entries: [
        {
          _id: 'audit-1',
          server_id: 'server-1',
          actor_id: 'actor-1',
          action: { type: 'RoleUpdate' },
          target: { type: 'Role', id: 'role-1' },
          reason: null,
          changes: {
            name: { before: 'old-name', after: 'new-name' },
            colour: { before: null, after: '#ff00aa' },
            roles: { before: ['role-1'], after: ['role-1', 'role-2'] },
          },
          status: 'Succeeded',
          created_at: 0,
          completed_at: 1,
        },
      ],
      next_before: null,
    })

    renderWithQuery(<ServerSettingsAuditPanel serverId="server-1" />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: /nioh13 обновляет роль «Прицел»/,
      }),
    )

    expect(screen.getByText(/Название: old-name → new-name/)).toBeTruthy()
    expect(screen.getByText('Цвет: — → #ff00aa')).toBeTruthy()
    expect(
      screen.getByText('Роли: «Прицел» → «Прицел», «Холостяк»'),
    ).toBeTruthy()
  })

  it('uses the removed role snapshot instead of the role id', async () => {
    mocks.fetchServerAuditLog.mockResolvedValue({
      entries: [
        {
          _id: 'audit-1',
          server_id: 'server-1',
          actor_id: 'actor-1',
          action: { type: 'RoleDelete' },
          target: { type: 'Role', id: 'deleted-role-id' },
          reason: null,
          changes: {
            role: {
              before: {
                _id: 'deleted-role-id',
                name: 'Новая роль',
                permissions: { a: 0, d: 0 },
                rank: 9,
              },
              after: null,
            },
          },
          status: 'Succeeded',
          created_at: 0,
          completed_at: 1,
        },
      ],
      next_before: null,
    })

    renderWithQuery(<ServerSettingsAuditPanel serverId="server-1" />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: /nioh13 удалил роль «Новая роль»/,
      }),
    )

    expect(screen.queryByText(/deleted-role-id/)).toBeNull()
    expect(screen.getByText('Роль: Новая роль → —')).toBeTruthy()
  })

  it('does not truncate long role reorder change details', async () => {
    mocks.fetchServerAuditLog.mockResolvedValue({
      entries: [
        {
          _id: 'audit-1',
          server_id: 'server-1',
          actor_id: 'actor-1',
          action: { type: 'RoleReorder' },
          target: { type: 'Server', id: 'server-1' },
          reason: null,
          changes: {
            ranks: {
              before: [
                ['role-1', 0],
                ['role-2', 1],
                ['role-3', 2],
                ['role-4', 3],
                ['role-5', 4],
                ['role-6', 5],
                ['role-7', 6],
                ['role-8', 7],
              ],
              after: [
                ['role-8', 0],
                ['role-1', 1],
                ['role-2', 2],
                ['role-3', 3],
                ['role-4', 4],
                ['role-5', 5],
                ['role-6', 6],
                ['role-7', 7],
              ],
            },
          },
          status: 'Succeeded',
          created_at: 0,
          completed_at: 1,
        },
      ],
      next_before: null,
    })

    renderWithQuery(<ServerSettingsAuditPanel serverId="server-1" />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: /nioh13 изменил порядок ролей/,
      }),
    )

    const changeLine = screen.getByText((content) =>
      content.includes('Порядок ролей:') &&
      content.includes('«Прицел»: позиция 1') &&
      content.includes('«高校生»: позиция 1') &&
      content.includes('«AR 57 рыбак»: позиция 8'),
    )

    expect(changeLine.className).not.toContain('truncate')
    expect(changeLine.className).toContain('break-words')
  })

  it('loads the next audit page with selected filters', async () => {
    mocks.fetchServerAuditLog.mockImplementation(
      async (_token: string, _serverId: string, params: { before?: string }) => {
        if (params.before) {
          return {
            entries: [
              {
                _id: 'audit-2',
                server_id: 'server-1',
                actor_id: 'user-2',
                action: { type: 'MemberBan' },
                target: { type: 'Member', user_id: 'user-3' },
                reason: 'spam',
                changes: {},
                status: 'Succeeded',
                created_at: 0,
                completed_at: 1,
              },
            ],
            next_before: null,
          }
        }

        return {
          entries: [
            {
              _id: 'audit-1',
              server_id: 'server-1',
              actor_id: 'actor-1',
              action: { type: 'RoleCreate' },
              target: { type: 'Role', id: 'role-1' },
              reason: null,
              changes: {},
              status: 'Succeeded',
              created_at: 0,
              completed_at: 1,
            },
          ],
          next_before: 'audit-1',
        }
      },
    )
    /*
      Keep the filtered first page cursor-bearing. React Query refetches after
      each filter changes, so a fixed mockResolvedValueOnce chain is brittle.
    */
    mocks.fetchServerAuditLog.mockResolvedValueOnce({
        entries: [
          {
            _id: 'audit-1',
            server_id: 'server-1',
            actor_id: 'actor-1',
            action: { type: 'RoleCreate' },
            target: { type: 'Role', id: 'role-1' },
            reason: null,
            changes: {},
            status: 'Succeeded',
            created_at: 0,
            completed_at: 1,
          },
        ],
        next_before: 'audit-1',
      })

    renderWithQuery(<ServerSettingsAuditPanel serverId="server-1" />)

    await screen.findByRole('button', {
      name: /nioh13 создал роль «Прицел»/,
    })
    fireEvent.click(screen.getByRole('button', { name: /Все пользователи/ }))
    fireEvent.click(screen.getByRole('button', { name: /waflya/ }))
    fireEvent.click(screen.getByRole('button', { name: /Все действия/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Бан участника' }))

    await waitFor(() => {
      expect(mocks.fetchServerAuditLog).toHaveBeenLastCalledWith(
        'session-token',
        'server-1',
        { limit: 50, actor: 'user-2', action: 'MemberBan' },
      )
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Загрузить ещё' }))

    await waitFor(() => {
      expect(mocks.fetchServerAuditLog).toHaveBeenLastCalledWith(
        'session-token',
        'server-1',
        {
          limit: 50,
          actor: 'user-2',
          action: 'MemberBan',
          before: 'audit-1',
        },
      )
    })
  })
})
