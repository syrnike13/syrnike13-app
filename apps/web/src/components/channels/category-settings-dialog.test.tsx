// @vitest-environment jsdom

import type { Category } from '@syrnike13/api-types'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CategorySettingsDialog } from '#/components/channels/category-settings-dialog'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  editServer: vi.fn(),
  onOpenChange: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: ReactNode
    open?: boolean
  }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  editServer: (...args: [string, string, unknown]) => mocks.editServer(...args),
}))

const category = {
  id: 'cat-1',
  title: 'General',
  channels: ['channel-1'],
} satisfies Category

const remainingCategory = {
  id: 'cat-2',
  title: 'Archive',
  channels: [],
} satisfies Category

function upsertServer() {
  syncStore.upsertServer({
    _id: 'server-1',
    name: 'Server',
    owner: 'user-1',
    channels: ['channel-1'],
    categories: [category, remainingCategory],
    default_permissions: 0,
  } as never)
}

describe('CategorySettingsDialog', () => {
  beforeEach(() => {
    syncStore.reset()
    upsertServer()
    mocks.editServer.mockImplementation(async (_token, serverId, patch) => ({
      ...syncStore.getState().servers[serverId],
      ...(patch as object),
    }))
    mocks.onOpenChange.mockClear()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('asks for explicit dialog confirmation before deleting a category', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(
      <CategorySettingsDialog
        serverId="server-1"
        category={category}
        open
        onOpenChange={mocks.onOpenChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Удалить категорию' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mocks.editServer).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('General')

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Удалить категорию' }),
    )

    await waitFor(() => {
      expect(mocks.editServer).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        { categories: [remainingCategory] },
      )
    })
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses the shared unsaved changes bar for category renaming', async () => {
    render(
      <CategorySettingsDialog
        serverId="server-1"
        category={category}
        open
        onOpenChange={mocks.onOpenChange}
      />,
    )

    expect(
      screen.queryByText('Есть несохранённые изменения'),
    ).toBeNull()

    fireEvent.change(screen.getByLabelText('Название'), {
      target: { value: 'Renamed' },
    })

    expect(
      await screen.findByText('Есть несохранённые изменения'),
    ).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Сбросить' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editServer).toHaveBeenCalledWith(
        'session-token',
        'server-1',
        {
          categories: [
            { ...category, title: 'Renamed' },
            remainingCategory,
          ],
        },
      )
    })
    expect(await screen.findByText('Изменения сохранены')).not.toBeNull()
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
