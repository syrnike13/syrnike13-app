// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsRolesPanel } from '#/components/servers/server-settings-roles-panel'
import { DraftProvider } from '#/components/settings/draft-controller-context'
import { UnsavedChangesBar } from '#/components/settings/unsaved-changes-bar'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'

const mocks = vi.hoisted(() => ({
  createServerRole: vi.fn(),
  deleteServerRole: vi.fn(),
  editServerRole: vi.fn(),
  editServerRoleRanks: vi.fn(),
  setDefaultServerPermissions: vi.fn(),
  setServerRolePermissions: vi.fn(),
  uploadAttachment: vi.fn(),
  dnd: {
    onDragEnd: undefined as
      | ((event: { active: { id: string }; over: { id: string } | null }) => void)
      | undefined,
  },
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: ReactNode
    onDragEnd?: (typeof mocks.dnd)['onDragEnd']
  }) => {
    mocks.dnd.onDragEnd = onDragEnd
    return <div>{children}</div>
  },
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn((...sensors: unknown[]) => sensors),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  arrayMove: <T,>(items: T[], oldIndex: number, newIndex: number) => {
    const next = [...items]
    const [item] = next.splice(oldIndex, 1)
    next.splice(newIndex, 0, item)
    return next
  },
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
  verticalListSortingStrategy: {},
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
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
    user: { _id: 'current-user', username: 'owner' },
  }),
}))

vi.mock('#/features/api/media-api', () => ({
  uploadAttachment: (...args: Parameters<typeof mocks.uploadAttachment>) =>
    mocks.uploadAttachment(...args),
}))

vi.mock('#/features/api/servers-api', () => ({
  createServerRole: (...args: Parameters<typeof mocks.createServerRole>) =>
    mocks.createServerRole(...args),
  deleteServerRole: (...args: Parameters<typeof mocks.deleteServerRole>) =>
    mocks.deleteServerRole(...args),
  editServerRole: (...args: Parameters<typeof mocks.editServerRole>) =>
    mocks.editServerRole(...args),
  editServerRoleRanks: (...args: Parameters<typeof mocks.editServerRoleRanks>) =>
    mocks.editServerRoleRanks(...args),
  setDefaultServerPermissions: (
    ...args: Parameters<typeof mocks.setDefaultServerPermissions>
  ) => mocks.setDefaultServerPermissions(...args),
  setServerRolePermissions: (
    ...args: Parameters<typeof mocks.setServerRolePermissions>
  ) => mocks.setServerRolePermissions(...args),
}))

vi.mock('#/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('#/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
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

vi.mock('#/components/servers/role-colour-preview', () => ({
  RoleColourPreview: () => <div data-testid="role-colour-preview" />,
}))

function setupServer() {
  syncStore.reset()
  syncStore.upsertServer({
    _id: 'server-1',
    name: 'Server',
    owner: 'current-user',
    channels: [],
    default_permissions: 0,
    roles: {
      admin: {
        _id: 'admin',
        name: 'Admin',
        permissions: { a: 0, d: 0 },
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
      roles: ['admin'],
    } as never,
  ])
}

function renderWithDraft() {
  return render(
    <DraftProvider>
      <ServerSettingsRolesPanel serverId="server-1" />
      <UnsavedChangesBar saveLabel="Сохранить" />
    </DraftProvider>,
  )
}

describe('ServerSettingsRolesPanel', () => {
  beforeEach(() => {
    setupServer()
    mocks.deleteServerRole.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('confirms role deletion in a dialog instead of browser confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ServerSettingsRolesPanel serverId="server-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Member' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить роль' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toContain(
      'Удалить роль «Member»?',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))

    await waitFor(() => {
      expect(mocks.deleteServerRole).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'member',
      )
    })
    expect(syncStore.getState().servers['server-1']?.roles?.member).toBeUndefined()
  })

  it('removes a role colour without sending a null colour value', async () => {
    syncStore.upsertServer({
      ...syncStore.getState().servers['server-1']!,
      roles: {
        ...syncStore.getState().servers['server-1']!.roles,
        member: {
          ...syncStore.getState().servers['server-1']!.roles.member,
          colour: '#ff00aa',
        },
      },
    } as never)
    mocks.editServerRole.mockResolvedValue({
      _id: 'member',
      name: 'Member',
      permissions: { a: 0, d: 0 },
      rank: 5,
      colour: null,
    })

    renderWithDraft()

    fireEvent.click(screen.getByRole('button', { name: 'Member' }))
    fireEvent.click(screen.getByTitle('Без цвета'))
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editServerRole).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        'member',
        { remove: ['Colour'] },
      )
    })
  })

  it('does not persist role reorders that start from an unmanageable role', () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-user',
      channels: [],
      default_permissions: 0,
      roles: {
        admin: {
          _id: 'admin',
          name: 'Admin',
          permissions: { a: 0, d: 0 },
          rank: 1,
        },
        moderator: {
          _id: 'moderator',
          name: 'Moderator',
          permissions: { a: ChannelPermission.ManageRole, d: 0 },
          rank: 3,
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
        roles: ['moderator'],
      } as never,
    ])

    render(<ServerSettingsRolesPanel serverId="server-1" />)

    mocks.dnd.onDragEnd?.({
      active: { id: 'admin' },
      over: { id: 'member' },
    })

    expect(mocks.editServerRoleRanks).not.toHaveBeenCalled()
  })
})
