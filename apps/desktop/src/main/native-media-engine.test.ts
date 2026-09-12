import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@syrnike13/platform'
import { createInactiveMediaPaths, MEDIA_LIFECYCLE_SCHEMA_SHA256 } from './media-runtime/contract'
import type { MediaUtilityCallbacks } from './media-runtime/media-utility-adapter'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  rendererReady: vi.fn(), rendererGone: vi.fn(), disposeFrames: vi.fn(),
  setRemoteDemand: vi.fn(), setScreenPreview: vi.fn(),
  createUtility: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('./media-runtime/media-utility-adapter', () => ({
  mediaUtilityAvailable: () => true,
  createElectronMediaUtilityAdapterFactory: () => () => electron.createUtility(),
}))
vi.mock('./media-runtime/media-frame-controller', () => ({
  MediaFrameController: class {
    presentationPaths() { return createInactiveMediaPaths() }
    rendererReady = electron.rendererReady
    rendererGone = electron.rendererGone
    dispose = electron.disposeFrames
    setRemoteDemand = electron.setRemoteDemand
    setScreenPreview = electron.setScreenPreview
  },
}))

describe('native media product boundary', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); electron.handlers.clear()
    electron.createUtility.mockImplementation(() => { throw new Error('This test must not spawn a utility process') })
  })
  afterEach(() => vi.restoreAllMocks())

  async function setup() {
    const runtime = await import('./native-media-engine')
    const callbacks = new Map<string, (...args: unknown[]) => void>()
    const webContents = {
      mainFrame: {},
      on: (event: string, handler: (...args: unknown[]) => void) => callbacks.set(event, handler),
      once: (event: string, handler: (...args: unknown[]) => void) => callbacks.set(event, handler),
      send: vi.fn(),
    }
    let destroyed = false
    const window = {
      isDestroyed: () => destroyed,
      get webContents() {
        if (destroyed) throw new Error('Object has been destroyed')
        return webContents
      },
    }
    let windowCreated = false
    const getWindow = () => windowCreated ? window : null

    runtime.registerNativeMediaRuntimeIpc(getWindow)
    expect(callbacks.size).toBe(0)
    windowCreated = true

    const event = { sender: webContents, senderFrame: webContents.mainFrame }
    const invoke = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)?.(event, ...args)
    return { runtime, callbacks, invoke, webContents,
      destroyWindow: () => { destroyed = true },
      clearWindow: () => { windowCreated = false },
    }
  }

  it('exposes a stopped native owner and retires frame ownership on disposal', async () => {
    const { runtime, invoke } = await setup()
    const adapter = runtime.createNativeRtcEngineAdapter()
    expect(invoke(IPC.mediaGetRuntimeState)).toMatchObject({ available: true, status: 'stopped', hostEpoch: 0 })
    expect(adapter.telemetry()).toMatchObject({ engineState: 'stopped' })
    await adapter.dispose()
    expect(electron.disposeFrames).toHaveBeenCalledOnce()
    expect(invoke(IPC.mediaGetRuntimeState)).toEqual(runtime.NATIVE_MEDIA_UNAVAILABLE_STATE)
  })

  it.each(['native', 'utility'])('reports a %s failure and supervisor retirement as one causal incident', async source => {
    vi.useFakeTimers()
    try {
      let callbacks: MediaUtilityCallbacks | undefined
      electron.createUtility.mockReturnValue({
        pid: 81,
        start: (value: MediaUtilityCallbacks) => { callbacks = value },
        postMessage: vi.fn(), kill: async () => {},
      })
      const { runtime } = await setup()
      const incidents = await import('./native-runtime/diagnostic-incidents')
      incidents.configureNativeDiagnosticIncidentAccount('test-account')
      const adapter = runtime.createNativeRtcEngineAdapter()
      try {
        const started = adapter['runtime'].start()
        callbacks!.onMessage({
          type: 'ready', protocolVersion: 4, engineState: 'running',
          build: { commit: 'c'.repeat(40), napi: '8', protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256 },
        })
        await started
        if (source === 'native') {
          callbacks!.onMessage({
            type: 'event', protocolVersion: 4,
            event: {
              type: 'fatalEngineFailure', sequence: 1,
              failure: { code: 'native_owner_stop_timeout', message: 'Owner did not join', stage: 'shutdown', retryable: true },
            },
          })
        } else {
          callbacks!.onExit({ code: 9, source: 'exit', expected: false, uptimeMs: 20, stderr: '', stderrTruncated: false })
        }
        const batch = incidents.leaseNativeDiagnosticIncidents('test-account')!
        expect(batch.incidents).toHaveLength(1)
        expect(batch.incidents[0]).toMatchObject({
          scope: source === 'native' ? 'native-media-controller' : 'native-runtime-supervisor',
          event: source === 'native' ? 'fatalEngineFailure' : 'utility_crashed',
          severity: 'fatal', occurrenceCount: 2,
          relatedEvidence: [expect.objectContaining({ scope: 'native-runtime-supervisor', event: 'runtime_degraded' })],
        })
      } finally { await adapter.dispose() }
    } finally { vi.useRealTimers() }
  })

  it('requires the explicit Retry IPC after exhausting utility recovery', async () => {
    vi.useFakeTimers()
    try {
      const hosts: MediaUtilityCallbacks[] = []
      electron.createUtility.mockImplementation(() => ({
        pid: 81, start: (callbacks: MediaUtilityCallbacks) => hosts.push(callbacks),
        postMessage: vi.fn(), kill: async () => {},
      }))
      const { runtime, invoke } = await setup()
      const adapter = runtime.createNativeRtcEngineAdapter()
      const ready = () => {
        const host = hosts.at(-1)
        if (!host) throw new Error('Host was not created')
        host.onMessage({
          type: 'ready', protocolVersion: 4, engineState: 'running',
          build: { commit: 'c'.repeat(40), napi: '8', protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256 },
        })
      }
      const exit = () => {
        const host = hosts.at(-1)
        if (!host) throw new Error('Host was not created')
        host.onExit({ code: 9, source: 'exit', expected: false, uptimeMs: 20, stderr: '', stderrTruncated: false })
      }
      const started = invoke(IPC.mediaRetryRuntime)
      ready()
      await started
      for (const delay of [250, 1000]) {
        exit()
        await vi.advanceTimersByTimeAsync(delay)
        ready()
      }
      exit()
      expect(invoke(IPC.mediaGetRuntimeState)).toMatchObject({ status: 'failed' })
      await expect(invoke(IPC.mediaListDevices, 'audioinput')).rejects.toMatchObject({
        failure: { code: 'unexpected_exit' },
      })
      expect(hosts).toHaveLength(3)
      const retried = invoke(IPC.mediaRetryRuntime)
      expect(hosts).toHaveLength(4)
      ready()
      await expect(retried).resolves.toMatchObject({ status: 'ready' })
      const disposed = adapter.dispose()
      await vi.advanceTimersByTimeAsync(3500)
      await disposed
    } finally { vi.useRealTimers() }
  })

  it('reattaches a listening renderer after account rotation and revokes it on reload', async () => {
    const { runtime, callbacks, invoke } = await setup()
    const first = runtime.createNativeRtcEngineAdapter()
    invoke(IPC.mediaReplayRemoteVideoPublications)
    expect(electron.rendererReady).toHaveBeenCalledOnce()
    await first.dispose()
    const second = runtime.createNativeRtcEngineAdapter()
    expect(electron.rendererReady).toHaveBeenCalledTimes(2)
    callbacks.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: false })
    expect(electron.rendererGone).toHaveBeenCalledOnce()
    await second.dispose()
    const third = runtime.createNativeRtcEngineAdapter()
    expect(electron.rendererReady).toHaveBeenCalledTimes(2)
    await third.dispose()
  })

  it('validates renderer demand and rejects foreign senders', async () => {
    const { runtime, invoke, webContents } = await setup()
    const adapter = runtime.createNativeRtcEngineAdapter()
    invoke(IPC.mediaSetLocalScreenPreviewDemand, { demanded: true, width: 1280, height: 720, fps: 30 })
    expect(electron.setScreenPreview).toHaveBeenCalledWith(true)
    expect(() => invoke(IPC.mediaSetRemoteVideoDemand, 'session', 1, 'track', 'true')).toThrow('Invalid IPC input')
    expect(electron.setRemoteDemand).not.toHaveBeenCalled()
    expect(() => electron.handlers.get(IPC.mediaReplayRemoteVideoPublications)?.({ sender: {} })).toThrow('Untrusted')
    expect(() => electron.handlers.get(IPC.mediaReplayRemoteVideoPublications)?.({ sender: webContents, senderFrame: {} })).toThrow('Untrusted')
    await adapter.dispose()
  })

  it('retires a destroyed renderer without accessing its destroyed BrowserWindow', async () => {
    const { runtime, callbacks, invoke, destroyWindow } = await setup()
    const adapter = runtime.createNativeRtcEngineAdapter()
    invoke(IPC.mediaReplayRemoteVideoPublications)
    destroyWindow()
    expect(() => callbacks.get('destroyed')?.()).not.toThrow()
    expect(electron.rendererGone).toHaveBeenCalledOnce()
    await adapter.dispose()
  })

  it('ignores teardown from a window that no longer owns the runtime', async () => {
    const { runtime, callbacks, invoke, clearWindow, destroyWindow } = await setup()
    const adapter = runtime.createNativeRtcEngineAdapter()
    invoke(IPC.mediaReplayRemoteVideoPublications)
    clearWindow()
    destroyWindow()
    expect(() => callbacks.get('destroyed')?.()).not.toThrow()
    expect(electron.rendererGone).not.toHaveBeenCalled()
    await adapter.dispose()
  })
})
