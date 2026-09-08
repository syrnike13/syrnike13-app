import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@syrnike13/platform'
import { createInactiveMediaPaths } from './media-runtime/contract'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  rendererReady: vi.fn(), rendererGone: vi.fn(), disposeFrames: vi.fn(),
  setRemoteDemand: vi.fn(), setScreenPreview: vi.fn(),
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
  createElectronMediaUtilityAdapterFactory: () => () => {
    throw new Error('This test must not spawn a utility process')
  },
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
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); electron.handlers.clear() })
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
    const window = {
      isDestroyed: () => false,
      webContents,
    }
    let windowCreated = false
    const getWindow = () => windowCreated ? window : null

    runtime.registerNativeMediaRuntimeIpc(getWindow)
    expect(callbacks.size).toBe(0)
    windowCreated = true

    const event = { sender: webContents, senderFrame: webContents.mainFrame }
    const invoke = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)?.(event, ...args)
    return { runtime, callbacks, invoke, webContents }
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
})
