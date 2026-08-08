import { beforeAll, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const listeners = new Map<
    string,
    Set<(event: unknown, payload: unknown) => void>
  >()
  return {
    exposed: null as unknown,
    listeners,
    contextBridge: {
      exposeInMainWorld: vi.fn((_name: string, value: unknown) => {
        electron.exposed = value
      }),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      send: vi.fn(),
      on: vi.fn(
        (
          channel: string,
          listener: (event: unknown, payload: unknown) => void,
        ) => {
          const channelListeners = listeners.get(channel) ?? new Set()
          channelListeners.add(listener)
          listeners.set(channel, channelListeners)
        },
      ),
      removeListener: vi.fn(
        (
          channel: string,
          listener: (event: unknown, payload: unknown) => void,
        ) => {
          listeners.get(channel)?.delete(listener)
        },
      ),
    },
    sharedTexture: {
      setSharedTextureReceiver: vi.fn(),
    },
    emit(channel: string, payload: unknown) {
      for (const listener of listeners.get(channel) ?? []) {
        listener({}, payload)
      }
    },
  }
})

vi.mock('electron', () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
  sharedTexture: electron.sharedTexture,
}))

import { IPC, type SyrnikeDesktopApi } from '@syrnike13/platform'

describe('desktop preload media runtime bridge', () => {
  let desktop: SyrnikeDesktopApi

  beforeAll(async () => {
    await import('./index')
    desktop = electron.exposed as SyrnikeDesktopApi
  })

  it('invokes runtime state and retry IPC channels', async () => {
    const ready = {
      available: true,
      status: 'ready' as const,
      restartCount: 4,
    }
    electron.ipcRenderer.invoke.mockResolvedValue(ready)

    await expect(desktop.media.getRuntimeState()).resolves.toEqual(ready)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      IPC.mediaGetRuntimeState,
    )
    await expect(desktop.media.retryRuntime()).resolves.toEqual(ready)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      IPC.mediaRetryRuntime,
    )
  })

  it('validates voice RTC telemetry returned by main IPC', async () => {
    const telemetry = {
      timestamp: 1_000,
      transport: { pingMs: 42 },
      outbound: [{
        id: 'publisher:audio-out',
        pcRole: 'publisher' as const,
        kind: 'audio' as const,
        packetsSent: 100,
      }],
      inbound: [],
    }
    electron.ipcRenderer.invoke.mockResolvedValueOnce(telemetry)

    await expect(desktop.voice.getTelemetry()).resolves.toEqual(telemetry)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      IPC.voiceGetTelemetry,
    )

    electron.ipcRenderer.invoke.mockResolvedValueOnce({
      ...telemetry,
      transport: { pingMs: -1 },
    })
    await expect(desktop.voice.getTelemetry()).rejects.toThrow()
  })

  it('rejects malformed runtime state returned by main IPC', async () => {
    electron.ipcRenderer.invoke.mockResolvedValueOnce({
      available: true,
      status: 'degraded',
      restartCount: -1,
    })
    await expect(desktop.media.getRuntimeState()).rejects.toThrow(
      'Invalid native media runtime state',
    )

    electron.ipcRenderer.invoke.mockResolvedValueOnce({
      available: true,
      status: 'unknown',
      restartCount: 0,
    })
    await expect(desktop.media.retryRuntime()).rejects.toThrow(
      'Invalid native media runtime state',
    )
  })

  it('delivers only validated runtime state events and unsubscribes', () => {
    const listener = vi.fn()
    const unsubscribe = desktop.media.onRuntimeState(listener)
    electron.emit(IPC.mediaRuntimeStateChanged, {
      available: true,
      status: 'degraded',
      restartCount: -1,
    })
    electron.emit(IPC.mediaRuntimeStateChanged, {
      available: true,
      status: 'degraded',
      restartCount: 3,
      degradedRetryAttempt: 1,
      nextRetryAt: 30_000,
    })

    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    electron.emit(IPC.mediaRuntimeStateChanged, {
      available: true,
      status: 'ready',
      restartCount: 4,
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
