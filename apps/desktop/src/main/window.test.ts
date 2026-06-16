import { beforeEach, describe, expect, it, vi } from 'vitest'

import { shouldOpenExternalUrl } from './external-open'

const openExternalMock = vi.hoisted(() => vi.fn())
const setWindowOpenHandlerMock = vi.hoisted(() => vi.fn())
const loadUrlMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
  },
  BrowserWindow: vi.fn(function BrowserWindow() {
    return {
      loadURL: loadUrlMock,
      on: vi.fn(),
      show: vi.fn(),
      webContents: {
        openDevTools: vi.fn(),
        setWindowOpenHandler: setWindowOpenHandlerMock,
      },
    }
  }),
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: vi.fn(),
      },
    },
  },
  shell: {
    openExternal: openExternalMock,
  },
}))

vi.mock('./desktop-app-identity', () => ({
  desktopWindowIconAssetName: () => 'icon.png',
}))

vi.mock('./media-permissions', () => ({
  installMediaPermissions: vi.fn(),
}))

vi.mock('./paths', () => ({
  resolveDesktopAsset: (assetName: string) => assetName,
  resolvePreloadScript: () => 'preload.js',
}))

describe('desktop window external URL policy', () => {
  beforeEach(() => {
    loadUrlMock.mockReset()
    openExternalMock.mockReset()
    setWindowOpenHandlerMock.mockReset()
  })

  it('opens music app deeplinks outside the app window', () => {
    expect(shouldOpenExternalUrl('spotify:track:5JHNg1hxZFT7TDEphhM4wj')).toBe(
      true,
    )
    expect(shouldOpenExternalUrl('yandexmusic://')).toBe(true)
    expect(shouldOpenExternalUrl('yandexmusic://search?text=Artist%20Track')).toBe(
      true,
    )
    expect(shouldOpenExternalUrl('yandexmusic://album/1/track/2')).toBe(true)
  })

  it('does not treat app-internal protocols as external music links', () => {
    expect(shouldOpenExternalUrl('syrnike13://invite/token')).toBe(false)
  })

  it('handles failed external protocol opens without leaving an unhandled rejection', async () => {
    const externalOpenCatch = vi.fn()
    openExternalMock.mockReturnValue({ catch: externalOpenCatch })
    const { createMainWindow } = await import('./window')

    createMainWindow('https://app.example')

    const handler = setWindowOpenHandlerMock.mock.calls[0]?.[0]
    expect(handler).toBeTypeOf('function')
    expect(handler({ url: 'yandexmusic://search?text=Artist%20Track' })).toEqual({
      action: 'deny',
    })
    expect(openExternalMock).toHaveBeenCalledWith(
      'yandexmusic://search?text=Artist%20Track',
    )
    expect(externalOpenCatch).toHaveBeenCalledWith(expect.any(Function))
  })
})
