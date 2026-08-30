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

import {
  IPC,
  type DesktopDisplayMediaSource,
  type SyrnikeDesktopApi,
} from '@syrnike13/platform'

describe('desktop preload media runtime bridge', () => {
  let desktop: SyrnikeDesktopApi

  beforeAll(async () => {
    await import('./index')
    desktop = electron.exposed as SyrnikeDesktopApi
  })

  it('invokes runtime state and retry IPC channels', async () => {
    const unavailable = {
      available: false,
      status: 'unavailable',
      restartCount: 0,
      failure: {
        code: 'native_media_unavailable',
        message: 'Native media is unavailable while the v2 engine is rebuilt.',
        retryable: false,
        stage: 'native_runtime',
      },
    }
    electron.ipcRenderer.invoke.mockResolvedValue(unavailable)

    await expect(desktop.media.getRuntimeState()).resolves.toEqual(unavailable)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      IPC.mediaGetRuntimeState,
    )
    await expect(desktop.media.retryRuntime()).resolves.toEqual(unavailable)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      IPC.mediaRetryRuntime,
    )
  })

  it('decodes metadata pages and lazy display-source visuals', async () => {
    const source: DesktopDisplayMediaSource = {
      id: 'window:42',
      name: 'Window',
      type: 'window',
      thumbnailDataUrl: null,
      appIconDataUrl: null,
    }
    const page = {
      sources: [source],
      page: 2,
      hasPrevious: true,
      hasNext: false,
    }
    electron.ipcRenderer.invoke.mockResolvedValueOnce(page)

    await expect(desktop.media.getDisplaySources('picker-1', 2)).resolves.toEqual(page)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      IPC.mediaGetDisplaySources,
      'picker-1',
      2,
    )

    const visual = { ...source, thumbnailDataUrl: 'data:image/bmp;base64,preview' }
    electron.ipcRenderer.invoke.mockResolvedValueOnce(visual)
    await expect(
      desktop.media.getDisplaySourceVisual('picker-1', source.id),
    ).resolves.toEqual(visual)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      IPC.mediaGetDisplaySourceVisual,
      'picker-1',
      source.id,
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
      available: false,
      status: 'stopped',
      restartCount: 0,
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
      available: false,
      status: 'stopped',
      restartCount: 0,
    })
    electron.emit(IPC.mediaRuntimeStateChanged, {
      available: false,
      status: 'unavailable',
      restartCount: 0,
      failure: {
        code: 'native_media_unavailable',
        message: 'Native media is unavailable while the v2 engine is rebuilt.',
        retryable: false,
        stage: 'native_runtime',
      },
    })

    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    electron.emit(IPC.mediaRuntimeStateChanged, {
      available: false,
      status: 'unavailable',
      restartCount: 0,
      failure: {
        code: 'native_media_unavailable',
        message: 'Native media is unavailable while the v2 engine is rebuilt.',
        retryable: false,
        stage: 'native_runtime',
      },
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('forwards native presentation resets to the renderer window', () => {
    const postMessage = vi.fn()
    const rendererWindow = {
      location: { origin: 'https://app.test' },
      postMessage,
    }
    vi.stubGlobal('window', rendererWindow)
    const metadata = {
      sessionId: 'voice',
      generation: 3,
      trackId: 'screen',
    }

    electron.emit(IPC.mediaNativeVideoPresentationReset, metadata)

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'syrnike-native-video-presentation-reset',
        metadata,
      },
      rendererWindow.location.origin,
    )
    vi.unstubAllGlobals()
  })
})
