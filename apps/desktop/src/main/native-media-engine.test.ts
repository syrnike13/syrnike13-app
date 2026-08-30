import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@syrnike13/platform'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler)
    }),
  },
}))

describe('native media unavailable boundary', () => {
  beforeEach(() => electron.handlers.clear())

  it('returns one finite unavailable state without a runtime lifecycle', async () => {
    const runtime = await import('./native-media-engine')
    const webContents = {}
    const getWindow = () => ({
      isDestroyed: () => false,
      webContents,
    })

    runtime.registerNativeMediaRuntimeIpc(getWindow)

    const event = { sender: webContents }
    expect(
      electron.handlers.get(IPC.mediaGetRuntimeState)?.(event),
    ).toEqual(runtime.NATIVE_MEDIA_UNAVAILABLE_STATE)
    expect(
      electron.handlers.get(IPC.mediaRetryRuntime)?.(event),
    ).toEqual(runtime.NATIVE_MEDIA_UNAVAILABLE_STATE)
    expect(
      electron.handlers.get(IPC.mediaListDevices)?.(event, 'audioinput'),
    ).toEqual([])
    expect(runtime).not.toHaveProperty('startNativeMediaRuntime')
    expect(runtime).not.toHaveProperty('disposeNativeMediaRuntime')
  })

  it('creates the resource-free unavailable RTC adapter', async () => {
    const runtime = await import('./native-media-engine')
    const adapter = runtime.createNativeRtcEngineAdapter()

    expect(adapter.telemetry()).toBeNull()
    adapter.dispose()
  })
})
