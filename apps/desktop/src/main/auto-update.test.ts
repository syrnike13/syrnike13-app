import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => {
  const listeners = new Map<string, Set<(value: any) => void>>()

  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    checkForUpdates: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (value: any) => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    emit(event: string, value?: any) {
      for (const listener of listeners.get(event) ?? []) listener(value)
    },
    reset() {
      listeners.clear()
      this.autoDownload = false
      this.autoInstallOnAppQuit = false
      this.allowDowngrade = true
      this.checkForUpdates.mockClear()
      this.quitAndInstall.mockClear()
      this.on.mockClear()
    },
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: true },
}))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: updater },
}))

describe('desktop auto-update startup flow', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    vi.resetModules()
    updater.reset()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('downloads and immediately installs an update found during startup', async () => {
    const updates = await import('./auto-update')
    dispose = updates.disposeDesktopAutoUpdate
    const send = vi.fn()
    const prepareToQuit = vi.fn()

    updates.initializeDesktopAutoUpdate(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send },
        }) as never,
      prepareToQuit,
    )

    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)

    updater.emit('update-available', { version: '0.6.0' })
    updater.emit('download-progress', { percent: 42 })
    updater.emit('update-downloaded', { version: '0.6.0' })

    expect(updates.getDesktopUpdateState()).toEqual({
      status: 'installing',
      version: '0.6.0',
    })
    expect(prepareToQuit).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('keeps updates discovered after startup ready for user action', async () => {
    const updates = await import('./auto-update')
    dispose = updates.disposeDesktopAutoUpdate

    updates.initializeDesktopAutoUpdate(() => null, vi.fn())
    updater.emit('update-not-available')
    updater.emit('update-available', { version: '0.6.0' })
    updater.emit('update-downloaded', { version: '0.6.0' })

    expect(updates.getDesktopUpdateState()).toEqual({
      status: 'ready',
      version: '0.6.0',
    })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})
