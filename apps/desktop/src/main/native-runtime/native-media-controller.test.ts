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
