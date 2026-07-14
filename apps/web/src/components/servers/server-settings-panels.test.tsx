// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Channel, File as ApiFile } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsPanelContent } from '#/components/servers/server-settings-panels'
import { syncStore } from '#/features/sync/sync-store'

Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
  value: () => false,
})

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  value: () => undefined,
})

const mocks = vi.hoisted(() => ({
  editServer: vi.fn(),
  uploadEmoji: vi.fn(),
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
  uploadEmoji: (...args: Parameters<typeof mocks.uploadEmoji>) =>
    mocks.uploadEmoji(...args),
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

function textChannel(
  id: string,
  name: string,
  overrides: Partial<Extract<Channel, { channel_type: 'TextChannel' }>> = {},
) {
  return {
    _id: id,
    channel_type: 'TextChannel',
    server: 'server-1',
    name,
    description: null,
    nsfw: false,
    slowmode: 0,
    default_permissions: null,
    ...overrides,
  } satisfies Extract<Channel, { channel_type: 'TextChannel' }>
}

async function chooseSystemMessageChannel(label: string) {
  fireEvent.pointerDown(screen.getByLabelText('Канал системных сообщений'), {
    button: 0,
    ctrlKey: false,
    pointerId: 1,
    pointerType: 'mouse',
  })
  fireEvent.click(await screen.findByRole('option', { name: label }))
}

describe('ServerSettingsPanelContent overview', () => {
  beforeEach(() => {
    syncStore.reset()
    upsertServer()
    syncStore.upsertChannel(textChannel('channel-1', 'general'))
    syncStore.upsertChannel(textChannel('channel-2', 'announcements'))
    mocks.fetchServerEmojis.mockResolvedValue([])
    mocks.uploadEmoji.mockResolvedValue('emoji-file')
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
      'icons',
      icon,
    )
    expect(mocks.uploadMediaFile).toHaveBeenNthCalledWith(
      2,
      'session-token',
      'banners',
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

  it('saves the system messages channel from overview settings', async () => {
    render(<ServerSettingsPanelContent serverId="server-1" tab="overview" />)

    await chooseSystemMessageChannel('#announcements')
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editServer).toHaveBeenCalledWith('session-token', 'server-1', {
        system_messages: {
          user_joined: 'channel-2',
          user_left: 'channel-2',
          user_kicked: 'channel-2',
          user_banned: 'channel-2',
        },
      })
    })
  })

  it('removes the server description when the field is cleared', async () => {
    upsertServer({ description: 'Старое описание' })

    render(<ServerSettingsPanelContent serverId="server-1" tab="overview" />)

    fireEvent.change(screen.getByLabelText('Описание'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editServer).toHaveBeenCalledWith('session-token', 'server-1', {
        remove: ['Description'],
      })
    })
  })

  it('removes system messages when the system channel is cleared', async () => {
    upsertServer({
      system_messages: {
        user_joined: 'channel-1',
        user_left: 'channel-1',
        user_kicked: 'channel-1',
        user_banned: 'channel-1',
      },
    })

    render(<ServerSettingsPanelContent serverId="server-1" tab="overview" />)

    await chooseSystemMessageChannel('Не отправлять')
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      expect(mocks.editServer).toHaveBeenCalledWith('session-token', 'server-1', {
        remove: ['SystemMessages'],
      })
    })
  })

  it('deletes an owned server from the overview danger zone through a dialog', async () => {
    upsertServer({ owner: 'user-1' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ServerSettingsPanelContent serverId="server-1" tab="overview" />)

    fireEvent.click(screen.getByRole('button', { name: 'Удалить сервер' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Server')
    expect(mocks.deleteOrLeaveServer).not.toHaveBeenCalled()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Удалить сервер' }),
    )

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

  it('deletes a server emoji through a confirmation dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mocks.fetchServerEmojis.mockResolvedValue([
      {
        _id: 'emoji-1',
        parent: { type: 'Server', id: 'server-1' },
        creator_id: 'user-1',
        name: 'party',
      },
    ])

    render(<ServerSettingsPanelContent serverId="server-1" tab="emoji" />)

    expect(await screen.findByText(':party:')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Удалить'))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toContain(':party:')

    fireEvent.click(screen.getByRole('button', { name: 'Удалить emoji' }))

    await waitFor(() => {
      expect(mocks.deleteServerEmoji).toHaveBeenCalledWith(
        'session-token',
        'emoji-1',
      )
    })
  })

  it('rejects invalid server emoji names before upload', async () => {
    const file = new File(['emoji'], 'party.png', { type: 'image/png' })

    render(<ServerSettingsPanelContent serverId="server-1" tab="emoji" />)

    fireEvent.change(screen.getByLabelText('Имя'), {
      target: { value: 'party parrot!' },
    })
    fireEvent.change(screen.getByLabelText('Файл'), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Имя emoji должно содержать только латиницу, цифры и подчёркивания.',
      )
    })
    expect(mocks.uploadEmoji).not.toHaveBeenCalled()
    expect(mocks.createServerEmoji).not.toHaveBeenCalled()
  })
})
