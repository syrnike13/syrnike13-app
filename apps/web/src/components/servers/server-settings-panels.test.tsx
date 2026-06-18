// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { File as ApiFile } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsPanelContent } from '#/components/servers/server-settings-panels'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  editServer: vi.fn(),
  uploadMediaFile: vi.fn(),
  deleteOrLeaveServer: vi.fn(),
  createServerEmoji: vi.fn(),
  deleteServerEmoji: vi.fn(),
  fetchServerEmojis: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('sonner', () => ({
  toast: {
    error: (...args: Parameters<typeof mocks.toastError>) =>
      mocks.toastError(...args),
    success: (...args: Parameters<typeof mocks.toastSuccess>) =>
      mocks.toastSuccess(...args),
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '/app',
}))

vi.mock('#/features/api/media-api', () => ({
  uploadEmoji: vi.fn(),
  uploadMediaFile: (...args: Parameters<typeof mocks.uploadMediaFile>) =>
    mocks.uploadMediaFile(...args),
}))

vi.mock('#/features/api/servers-api', () => ({
  createServerEmoji: (...args: Parameters<typeof mocks.createServerEmoji>) =>
    mocks.createServerEmoji(...args),
  deleteOrLeaveServer: (
    ...args: Parameters<typeof mocks.deleteOrLeaveServer>
  ) => mocks.deleteOrLeaveServer(...args),
  deleteServerEmoji: (...args: Parameters<typeof mocks.deleteServerEmoji>) =>
    mocks.deleteServerEmoji(...args),
  editServer: (...args: Parameters<typeof mocks.editServer>) =>
    mocks.editServer(...args),
  fetchServerEmojis: (...args: Parameters<typeof mocks.fetchServerEmojis>) =>
    mocks.fetchServerEmojis(...args),
}))

function imageFile(overrides: Partial<ApiFile> = {}) {
  return {
    _id: 'file-1',
    tag: 'avatars',
    filename: 'server.png',
    content_type: 'image/png',
    size: 1024,
    metadata: {
      type: 'Image',
      width: 128,
      height: 128,
    },
    ...overrides,
  } satisfies ApiFile
}

function upsertServer(overrides: Record<string, unknown> = {}) {
  syncStore.upsertServer({
    _id: 'server-1',
    name: 'Server',
    owner: 'owner-1',
    channels: [],
    default_permissions: 0,
    ...overrides,
  } as never)
}

describe('ServerSettingsPanelContent overview', () => {
  beforeEach(() => {
    syncStore.reset()
    upsertServer()
    mocks.fetchServerEmojis.mockResolvedValue([])
    mocks.uploadMediaFile.mockResolvedValue('file-id')
    mocks.deleteOrLeaveServer.mockResolvedValue(undefined)
    mocks.navigate.mockResolvedValue(undefined)
    mocks.editServer.mockImplementation((_token, _serverId, patch) =>
      Promise.resolve({
        _id: 'server-1',
        name: 'Server',
        owner: 'owner-1',
        channels: [],
        default_permissions: 0,
        ...patch,
      }),
    )
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('uploads selected server icon and banner before saving overview settings', async () => {
    const icon = new File(['icon'], 'icon.png', { type: 'image/png' })
    const banner = new File(['banner'], 'banner.png', { type: 'image/png' })
    mocks.uploadMediaFile
      .mockResolvedValueOnce('icon-file')
      .mockResolvedValueOnce('banner-file')

    render(<ServerSettingsPanelContent serverId="server-1" tab="overview" />)

    fireEvent.change(screen.getByLabelText('Иконка сервера'), {
      target: { files: [icon] },
    })
    fireEvent.change(screen.getByLabelText('Баннер сервера'), {
      target: { files: [banner] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editServer).toHaveBeenCalledWith('session-token', 'server-1', {
        icon: 'icon-file',
        banner: 'banner-file',
      })
    })
    expect(mocks.uploadMediaFile).toHaveBeenNthCalledWith(
      1,
      'session-token',
      'avatars',
      icon,
    )
    expect(mocks.uploadMediaFile).toHaveBeenNthCalledWith(
      2,
      'session-token',
      'backgrounds',
      banner,
    )
  })

  it('saves explicit removal fields for existing server icon and banner', async () => {
    upsertServer({
      icon: imageFile(),
      banner: imageFile({ _id: 'banner-1', tag: 'backgrounds' }),
    })

    render(<ServerSettingsPanelContent serverId="server-1" tab="overview" />)

    fireEvent.click(screen.getByRole('button', { name: 'Удалить иконку' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить баннер' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editServer).toHaveBeenCalledWith('session-token', 'server-1', {
        remove: ['Icon', 'Banner'],
      })
    })
    expect(mocks.uploadMediaFile).not.toHaveBeenCalled()
  })

  it('deletes an owned server from the overview danger zone', async () => {
    upsertServer({ owner: 'user-1' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<ServerSettingsPanelContent serverId="server-1" tab="overview" />)

    fireEvent.click(screen.getByRole('button', { name: 'Удалить сервер' }))

    await waitFor(() => {
      expect(mocks.deleteOrLeaveServer).toHaveBeenCalledWith(
        'session-token',
        'server-1',
      )
    })
    expect(syncStore.getState().servers['server-1']).toBeUndefined()
    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/app',
        search: { tab: 'online' },
      })
    })
  })

  it('does not expose server deletion to non-owners in overview settings', () => {
    upsertServer({ owner: 'owner-2' })

    render(<ServerSettingsPanelContent serverId="server-1" tab="overview" />)

    expect(
      screen.queryByRole('button', { name: 'Удалить сервер' }),
    ).toBeNull()
  })
})
