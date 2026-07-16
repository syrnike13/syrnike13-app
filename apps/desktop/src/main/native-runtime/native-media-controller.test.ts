import { describe, expect, it, vi } from 'vitest'

import type { MediaRuntimeCommand, MediaRuntimeEvent } from './contract'
import { NativeMediaController } from './native-media-controller'
import type {
  NativeRuntimeSupervisor,
  NativeRuntimeSupervisorSnapshot,
} from './runtime-supervisor'

function createHarness() {
  let eventListener: ((event: MediaRuntimeEvent) => void) | null = null
  let stateListener:
    | ((snapshot: NativeRuntimeSupervisorSnapshot) => void)
    | null = null
  let snapshot: NativeRuntimeSupervisorSnapshot = {
    runtime: 'media',
    status: 'ready',
    restartCount: 0,
    ready: {
      type: 'ready',
      runtime: 'media',
      contractVersion: 1,
      build: {
        electron: 'test',
        napi: '8',
        livekit: '1.3.0',
        commit: 'test',
      },
      capabilities: ['microphone', 'screen'],
    },
  }
  const request = vi.fn(async (command: MediaRuntimeCommand) => {
    if (command.type === 'startPreview') {
      return { sessionId: command.sessionId }
    }
    if (command.type === 'listDevices') {
      return [{ deviceId: 'default', kind: command.kind, label: 'Default' }]
    }
    return undefined
  })
  const supervisor = {
    onEvent(listener: (event: MediaRuntimeEvent) => void) {
      eventListener = listener
      return () => undefined
    },
    onStateChange(
      listener: (value: NativeRuntimeSupervisorSnapshot) => void,
    ) {
      stateListener = listener
      return () => undefined
    },
    getSnapshot: () => snapshot,
    start: vi.fn(async () => snapshot.ready),
    request,
    shutdown: vi.fn(async () => undefined),
  } as unknown as NativeRuntimeSupervisor
  const controller = new NativeMediaController({
    supervisor,
    runtimeAvailable: () => true,
    getSelfWindowHwnd: () => '42',
  })
  return {
    controller,
    request,
    event(event: MediaRuntimeEvent) {
      eventListener?.(event)
    },
    state(next: NativeRuntimeSupervisorSnapshot) {
      snapshot = next
      stateListener?.(next)
    },
  }
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('NativeMediaController retained tools', () => {
  it('restarts only a remote video track that is still demanded', async () => {
    const harness = createHarness()
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
    harness.request.mockClear()

    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(true)
    expect(harness.request.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ type: 'setRemoteVideoDemand', demanded: false }),
      expect.objectContaining({ type: 'setRemoteVideoDemand', demanded: true }),
    ])

    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', false)
    harness.request.mockClear()
    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(false)
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('does not restore a stalled track after the user stops watching it', async () => {
    const harness = createHarness()
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
    harness.request.mockClear()
    let releaseRecovery!: () => void
    let unsubscribeRequests = 0
    harness.request.mockImplementation(async (command: MediaRuntimeCommand) => {
      if (command.type === 'setRemoteVideoDemand' && !command.demanded &&
        ++unsubscribeRequests === 1) {
        await new Promise<void>((resolve) => { releaseRecovery = resolve })
      }
      return undefined
    })

    const recovery = harness.controller.recoverRemoteVideoDemand(
      'voice',
      3,
      'screen',
    )
    await waitUntil(() => unsubscribeRequests === 1)
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', false)
    releaseRecovery()

    await expect(recovery).resolves.toBe(false)
    expect(harness.request.mock.calls.some(
      ([command]) => command.type === 'setRemoteVideoDemand' && command.demanded,
    )).toBe(false)
  })

  it('persists local screen preview demand and binds it to each active generation', async () => {
    const harness = createHarness()
    await harness.controller.setLocalScreenPreviewDemand({
      demanded: true,
      width: 1280,
      height: 720,
      fps: 30,
    })
    expect(harness.request).not.toHaveBeenCalled()

    harness.event({
      type: 'sessionLifecycle',
      sequence: 1,
      sessionId: 'screen-a',
      generation: 4,
      kind: 'screen',
      state: { status: 'starting', sessionId: 'screen-a' },
    })
    await waitUntil(() => harness.request.mock.calls.some(
      ([command]) => command.type === 'setLocalScreenPreviewDemand',
    ))
    expect(harness.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'setLocalScreenPreviewDemand',
      sessionId: 'screen-a',
      generation: 4,
      demanded: true,
      options: { width: 1280, height: 720, fps: 30 },
    }), expect.any(Number))

    harness.event({
      type: 'sessionStopped',
      sequence: 2,
      sessionId: 'screen-a',
      generation: 4,
    })
    harness.request.mockClear()
    await harness.controller.setLocalScreenPreviewDemand({
      demanded: false,
      width: 1920,
      height: 1080,
      fps: 30,
    })
    expect(harness.request).not.toHaveBeenCalled()
    harness.event({
      type: 'sessionLifecycle',
      sequence: 3,
      sessionId: 'screen-b',
      generation: 5,
      kind: 'screen',
      state: { status: 'starting', sessionId: 'screen-b' },
    })
    await waitUntil(() => harness.request.mock.calls.length > 0)
    expect(harness.request).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'screen-b',
      generation: 5,
      demanded: false,
      options: { width: 1920, height: 1080, fps: 30 },
    }), expect.any(Number))
  })

  it('rejects non-finite local screen preview demand before persisting it', async () => {
    const harness = createHarness()
    await expect(harness.controller.setLocalScreenPreviewDemand({
      demanded: true,
      width: Number.NaN,
      height: 720,
      fps: 30,
    })).rejects.toThrow('Invalid local screen preview demand')
    harness.event({
      type: 'sessionLifecycle',
      sequence: 1,
      sessionId: 'screen-a',
      generation: 1,
      kind: 'screen',
      state: { status: 'starting', sessionId: 'screen-a' },
    })
    await waitUntil(() => harness.request.mock.calls.length > 0)
    expect(harness.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'setLocalScreenPreviewDemand',
      demanded: false,
      options: { width: 1280, height: 720, fps: 30 },
    }), expect.any(Number))
  })


  it('forwards microphone levels without requiring self-monitoring', () => {
    const harness = createHarness()
    const listener = vi.fn()
    harness.controller.subscribe(listener)

    harness.event({
      type: 'microphoneMetrics',
      sequence: 1,
      metrics: { inputDb: -18, thresholdDb: -28, open: true },
    })

    expect(listener).toHaveBeenCalledWith({
      type: 'microphoneMetrics',
      event: { inputDb: -18, thresholdDb: -28, open: true },
    })
    expect(
      harness.request.mock.calls.some(
        ([command]) => command.type === 'startPreview',
      ),
    ).toBe(false)
  })

  it('coalesces preview start and lets the actor warm its shared pipeline', async () => {
    const harness = createHarness()
    const first = harness.controller.startMicrophonePreview()
    const second = harness.controller.startMicrophonePreview()

    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(
      harness.request.mock.calls.filter(
        ([command]) => command.type === 'startPreview',
      ),
    ).toHaveLength(1)
    expect(
      harness.request.mock.calls.some(
        ([command]) => command.type === 'warmMicrophone',
      ),
    ).toBe(false)

    harness.request.mockClear()
    await harness.controller.startMicrophonePreview()
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('stops a preview that lost the start/stop race', async () => {
    const harness = createHarness()
    let resolveStart!: (value: unknown) => void
    harness.request.mockImplementation(async (command: MediaRuntimeCommand) => {
      if (command.type !== 'startPreview') return undefined
      return new Promise((resolve) => {
        resolveStart = resolve
      })
    })

    const start = harness.controller.startMicrophonePreview()
    await waitUntil(() =>
      harness.request.mock.calls.some(
        ([command]) => command.type === 'startPreview',
      ),
    )
    const command = harness.request.mock.calls.find(
      ([candidate]) => candidate.type === 'startPreview',
    )?.[0]
    if (!command || command.type !== 'startPreview') throw new Error('missing start')
    await harness.controller.stopMicrophonePreview()
    resolveStart({ sessionId: command.sessionId })

    await expect(start).rejects.toThrow('cancelled')
    expect(harness.request.mock.calls).toContainEqual([
      {
        type: 'stopPreview',
        sessionId: command.sessionId,
        generation: command.generation,
      },
      expect.any(Number),
    ])
  })

  it('forwards identity-free levels and terminal preview state', async () => {
    const harness = createHarness()
    const listener = vi.fn()
    harness.controller.subscribe(listener)
    await harness.controller.startMicrophonePreview()
    const command = harness.request.mock.calls.find(
      ([candidate]) => candidate.type === 'startPreview',
    )?.[0]
    if (!command || command.type !== 'startPreview') throw new Error('missing start')

    harness.event({
      type: 'microphoneMetrics',
      sequence: 1,
      metrics: { inputDb: -12, thresholdDb: -28, open: true },
    })
    harness.event({
      type: 'runtimeError',
      sequence: 2,
      requestId: 'preview',
      error: {
        code: 'microphone_preview_failed',
        message: 'capture failed',
        retryable: true,
        sessionId: command.sessionId,
        generation: command.generation,
      },
    })

    expect(listener).toHaveBeenCalledWith({
      type: 'microphoneMetrics',
      event: { inputDb: -12, thresholdDb: -28, open: true },
    })
    expect(listener).toHaveBeenCalledWith({
      type: 'microphonePreviewState',
      event: { status: 'error', message: 'capture failed' },
    })
  })

  it('restores a running preview after a new runtime epoch', async () => {
    const harness = createHarness()
    await harness.controller.startMicrophonePreview()
    const first = harness.request.mock.calls.find(
      ([command]) => command.type === 'startPreview',
    )?.[0]
    if (!first || first.type !== 'startPreview') throw new Error('missing start')

    harness.state({
      runtime: 'media',
      status: 'recovering',
      restartCount: 1,
      lastFailure: 'utility exited',
    })
    harness.state({
      runtime: 'media',
      status: 'ready',
      restartCount: 1,
      ready: {
        type: 'ready',
        runtime: 'media',
        contractVersion: 1,
        build: {
          electron: 'test',
          napi: '8',
          livekit: '1.3.0',
          commit: 'test',
        },
        capabilities: ['microphone', 'screen'],
      },
    })
    await waitUntil(
      () =>
        harness.request.mock.calls.filter(
          ([command]) => command.type === 'startPreview',
        ).length === 2,
    )
    const restored = harness.request.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'startPreview')
      .at(-1)
    expect(restored).toMatchObject({
      sessionId: first.sessionId,
      generation: expect.any(Number),
    })
    expect(restored?.generation).toBeGreaterThan(first.generation)
  })

  it('keeps device queries and screen capability narrow', async () => {
    const harness = createHarness()
    await expect(harness.controller.listDevices('audioinput')).resolves.toEqual([
      { deviceId: 'default', kind: 'audioinput', label: 'Default' },
    ])
    await expect(harness.controller.supportsNativeScreenCapture()).resolves.toBe(
      true,
    )
  })
})
