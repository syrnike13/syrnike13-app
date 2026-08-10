import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import type { MediaRuntimeCommand, MediaRuntimeEvent } from './contract'
import { NativeMediaController } from './native-media-controller'
import { NativeRuntimeRequestError } from './runtime-supervisor'
import type {
  NativeRuntimeSupervisor,
  NativeRuntimeSupervisorSnapshot,
} from './runtime-supervisor'

function createHarness(remoteVideoFirstFrameTimeoutMs?: number) {
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
  const retry = vi.fn(async () => snapshot.ready)
  const shutdown = vi.fn(async () => undefined)
  const start = vi.fn(async () => snapshot.ready)
  const diagnostics = vi.fn()
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
    start,
    startEffect: () =>
      Effect.tryPromise({
        try: start,
        catch: (cause) => cause,
      }),
    retry,
    retryEffect: () =>
      Effect.tryPromise({
        try: retry,
        catch: (cause) => cause,
      }),
    request,
    requestEffect: (command: MediaRuntimeCommand, timeoutMs: number) =>
      Effect.tryPromise({
        try: () => request(command, timeoutMs),
        catch: (cause) => cause,
      }),
    shutdown,
    shutdownEffect: () =>
      Effect.tryPromise({
        try: shutdown,
        catch: (cause) => cause,
      }),
  } as unknown as NativeRuntimeSupervisor
  const controller = new NativeMediaController({
    supervisor,
    runtimeAvailable: () => true,
    getSelfWindowHwnd: () => '42',
    remoteVideoFirstFrameTimeoutMs,
    diagnostics,
  })
  eventListener?.({
    type: 'sessionLifecycle',
    sequence: 0,
    sessionId: 'voice',
    generation: 3,
    kind: 'voice',
    state: { status: 'running', sessionId: 'voice' },
  })
  return {
    controller,
    request,
    retry,
    shutdown,
    diagnostics,
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
  it('projects degraded state and delegates retry to the supervisor', async () => {
    const harness = createHarness()
    harness.state({
      runtime: 'media',
      status: 'degraded',
      restartCount: 3,
      degradedReason: 'circuit open',
      degradedRetryAttempt: 1,
      nextRetryAt: 30_000,
    })

    expect(harness.controller.getRuntimeState()).toEqual({
      available: true,
      status: 'degraded',
      restartCount: 3,
      degradedReason: 'circuit open',
      degradedRetryAttempt: 1,
      nextRetryAt: 30_000,
    })
    await harness.controller.retryRuntime()
    expect(harness.retry).toHaveBeenCalledTimes(1)
  })

  it('owns demand only for the current voice session and clears timers on turnover', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()

      harness.event({
        type: 'sessionLifecycle',
        sequence: 1,
        sessionId: 'next-voice',
        generation: 4,
        kind: 'voice',
        state: { status: 'starting', sessionId: 'next-voice' },
      })
      await vi.runAllTimersAsync()
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)

      expect(harness.request).not.toHaveBeenCalled()
      expect(harness.controller.isCurrentVoiceSession('next-voice', 4)).toBe(true)

      harness.event({
        type: 'sessionLifecycle',
        sequence: 2,
        sessionId: 'stale-voice',
        generation: 3,
        kind: 'voice',
        state: { status: 'running', sessionId: 'stale-voice' },
      })
      expect(harness.controller.isCurrentVoiceSession('next-voice', 4)).toBe(true)

      harness.event({
        type: 'sessionLifecycle',
        sequence: 3,
        sessionId: 'next-voice',
        generation: 3,
        kind: 'voice',
        state: { status: 'idle' },
      })
      expect(harness.controller.isCurrentVoiceSession('next-voice', 4)).toBe(true)

      harness.event({
        type: 'sessionLifecycle',
        sequence: 4,
        sessionId: 'next-voice',
        generation: 5,
        kind: 'voice',
        state: { status: 'idle' },
      })
      expect(harness.controller.isCurrentVoiceSession('next-voice', 4)).toBe(false)
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains current video publications for a new renderer and fences stale events', () => {
    const harness = createHarness()
    harness.event({
      type: 'remoteVideoPublicationAvailable',
      sequence: 1,
      sessionId: 'voice',
      generation: 3,
      trackId: 'screen-a',
      participantIdentity: 'member-a',
      source: 'screen',
    })

    expect(harness.controller.listRemoteVideoPublications()).toEqual([{
      sessionId: 'voice',
      generation: 3,
      trackId: 'screen-a',
      participantIdentity: 'member-a',
      source: 'screen',
    }])

    harness.event({
      type: 'remoteVideoPublicationUnavailable',
      sequence: 2,
      sessionId: 'voice',
      generation: 2,
      trackId: 'screen-a',
      participantIdentity: 'member-a',
      source: 'screen',
    })
    expect(harness.controller.listRemoteVideoPublications()).toHaveLength(1)

    harness.event({
      type: 'sessionLifecycle',
      sequence: 3,
      sessionId: 'voice-next',
      generation: 4,
      kind: 'voice',
      state: { status: 'running', sessionId: 'voice-next' },
    })
    expect(harness.controller.listRemoteVideoPublications()).toEqual([])
  })

  it('retains camera inventory before the first native frame exists', () => {
    const harness = createHarness()
    harness.event({
      type: 'remoteVideoPublicationAvailable',
      sequence: 1,
      sessionId: 'voice',
      generation: 3,
      trackId: 'camera-a',
      participantIdentity: 'member-a',
      source: 'camera',
    })

    expect(harness.controller.listRemoteVideoPublications()).toEqual([{
      sessionId: 'voice',
      generation: 3,
      trackId: 'camera-a',
      participantIdentity: 'member-a',
      source: 'camera',
    }])
  })

  it('retires remote video immediately when the current voice epoch terminates', () => {
    const harness = createHarness()
    const listener = vi.fn()
    harness.controller.subscribe(listener)
    harness.event({
      type: 'remoteVideoPublicationAvailable',
      sequence: 1,
      sessionId: 'voice',
      generation: 3,
      trackId: 'screen-a',
      participantIdentity: 'member-a',
      source: 'screen',
    })

    harness.event({
      type: 'voiceTerminal',
      sequence: 2,
      sessionId: 'voice',
      generation: 3,
      error: {
        code: 'rtc_terminal',
        message: 'transport ended',
        stage: 'connectVoice',
        retryable: true,
      },
    })

    expect(harness.controller.listRemoteVideoPublications()).toEqual([])
    expect(harness.controller.isCurrentVoiceSession('voice', 3)).toBe(false)
    expect(listener).toHaveBeenCalledWith({
      type: 'remoteVideoSessionReset',
      sessionId: 'voice',
      generation: 3,
    })
  })

  it('treats stale generation replies as superseded without retrying', async () => {
    const harness = createHarness()
    harness.request.mockRejectedValueOnce(new NativeRuntimeRequestError({
      code: 'stale_generation',
      message: 'superseded',
      retryable: false,
    }))

    await expect(
      harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true),
    ).resolves.toBeUndefined()
    harness.request.mockClear()
    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(false)
    expect(harness.request).not.toHaveBeenCalled()
    await harness.controller.dispose()
  })

  it('retires recovery when native reports a stale generation', async () => {
    const harness = createHarness()
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
    harness.request.mockRejectedValueOnce(new NativeRuntimeRequestError({
      code: 'stale_generation',
      message: 'superseded',
      retryable: false,
    }))

    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(false)
    harness.request.mockClear()
    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(false)
    expect(harness.request).not.toHaveBeenCalled()
    await harness.controller.dispose()
  })

  it('preserves the native subscription when the renderer resets', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()

      harness.controller.resetRemoteVideoDemands()
      await vi.advanceTimersByTimeAsync(500)

      expect(harness.request).not.toHaveBeenCalled()
      expect(harness.controller.isRemoteVideoDemanded('voice', 3, 'screen'))
        .toBe(true)
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks the native owner to recover when no first frame arrives', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()

      await vi.advanceTimersByTimeAsync(1_250)

      expect(harness.request.mock.calls.map(([command]) => command)).toEqual([
        expect.objectContaining({ type: 'retryRemoteVideo' }),
      ])
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps local recovery and user demand alive after the degraded threshold', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      const listener = vi.fn()
      harness.controller.subscribe(listener)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()

      await vi.advanceTimersByTimeAsync(30_000)

      const recoveryCommands = harness.request.mock.calls
        .map(([command]) => command)
        .filter((command) => command.type === 'retryRemoteVideo')
      expect(recoveryCommands.length).toBeGreaterThan(3)
      expect(harness.request.mock.calls.some(([command]) =>
        command.type === 'setRemoteVideoDemand' && !command.demanded,
      )).toBe(false)
      expect(harness.diagnostics).toHaveBeenCalledWith(expect.objectContaining({
        event: 'remote_video_recovery_degraded',
        recoveryAttempt: 3,
        reason: 'local_recovery_budget_exceeded',
      }))
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'remoteVideoDemandFailed',
      }))
      expect(harness.controller.isRemoteVideoDemanded('voice', 3, 'screen'))
        .toBe(true)
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a demanded screen healthy while frames continue arriving', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()
      harness.event({
        type: 'remoteVideoFrame',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        participantIdentity: 'remote',
        source: 'screen',
        frameSequence: 1,
        timestampUs: 1_000,
        width: 1280,
        height: 720,
        ntHandle: new Uint8Array(8),
      })
      harness.controller.markRemoteVideoFramePresented('voice', 3, 'screen')

      await vi.advanceTimersByTimeAsync(1_000)
      harness.event({
        type: 'remoteVideoFrame',
        sequence: 2,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        participantIdentity: 'remote',
        source: 'screen',
        frameSequence: 2,
        timestampUs: 2_000,
        width: 1280,
        height: 720,
        ntHandle: new Uint8Array(8),
      })
      harness.controller.markRemoteVideoFramePresented('voice', 3, 'screen')
      await vi.advanceTimersByTimeAsync(1_000)

      expect(harness.request).not.toHaveBeenCalled()
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers when frames decode but never reach the renderer', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()
      harness.event({
        type: 'remoteVideoFrame',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        participantIdentity: 'remote',
        source: 'screen',
        frameSequence: 1,
        timestampUs: 1_000,
        width: 1280,
        height: 720,
        ntHandle: new Uint8Array(8),
      })

      await vi.advanceTimersByTimeAsync(1_250)

      expect(harness.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'retryRemoteVideo',
        }),
        expect.any(Number),
      )
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers a demanded screen that stops producing frames', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.event({
        type: 'remoteVideoFrame',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        participantIdentity: 'remote',
        source: 'screen',
        frameSequence: 1,
        timestampUs: 1_000,
        width: 1280,
        height: 720,
        ntHandle: new Uint8Array(8),
      })
      harness.controller.markRemoteVideoFramePresented('voice', 3, 'screen')
      harness.request.mockClear()

      await vi.advanceTimersByTimeAsync(1_250)

      expect(harness.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'retryRemoteVideo',
        }),
        expect.any(Number),
      )
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers promptly when the current SDK track is removed', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()
      harness.event({
        type: 'remoteVideoTrackRemoved',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
      })

      await vi.advanceTimersByTimeAsync(250)
      expect(harness.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'retryRemoteVideo',
        }),
        expect.any(Number),
      )
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets recovery when the screen publication disappears', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()
      harness.event({
      type: 'remoteVideoPublicationUnavailable',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        participantIdentity: 'remote',
        source: 'screen',
      })

      await vi.advanceTimersByTimeAsync(4_000)

      expect(harness.request).not.toHaveBeenCalled()
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels stale screen recovery when the native runtime is lost', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      const listener = vi.fn()
      harness.controller.subscribe(listener)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.event({
        type: 'remoteVideoPublicationAvailable',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        participantIdentity: 'remote',
        source: 'screen',
      })
      harness.request.mockClear()
      harness.state({
        runtime: 'media',
        status: 'recovering',
        restartCount: 1,
        lastFailure: 'utility exited',
      })

      await vi.advanceTimersByTimeAsync(30_000)

      expect(harness.request).not.toHaveBeenCalled()
      expect(listener).toHaveBeenCalledWith({
        type: 'remoteVideoSessionReset',
        sessionId: 'voice',
        generation: 3,
      })
      expect(harness.controller.listRemoteVideoPublications()).toEqual([])
      await expect(
        harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
      ).resolves.toBe(false)
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delegates recovery for a demanded remote video track', async () => {
    const harness = createHarness()
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
    expect(harness.controller.isRemoteVideoDemanded('voice', 3, 'screen'))
      .toBe(true)
    harness.request.mockClear()

    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(true)
    expect(harness.request.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ type: 'retryRemoteVideo' }),
    ])
    expect(harness.controller.isRemoteVideoDemanded('voice', 3, 'screen'))
      .toBe(true)
    harness.controller.markRemoteVideoFramePresented('voice', 3, 'screen')
    expect(harness.controller.isRemoteVideoDemanded('voice', 3, 'screen'))
      .toBe(true)

    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', false)
    expect(harness.controller.isRemoteVideoDemanded('voice', 3, 'screen'))
      .toBe(false)
    harness.request.mockClear()
    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(false)
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('resets network recovery when native decoding produces a frame', async () => {
    const harness = createHarness()
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen')
      harness.event({
        type: 'remoteVideoFrame',
        sequence: attempt + 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        participantIdentity: 'remote',
        source: 'screen',
        frameSequence: attempt + 1,
        timestampUs: (attempt + 1) * 1_000,
        width: 1280,
        height: 720,
        ntHandle: new Uint8Array(8),
      })
    }

    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(true)
    await harness.controller.dispose()
  })

  it('resets the recovery budget after a native frame is received', async () => {
    const harness = createHarness()
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen')
    }
    harness.controller.markRemoteVideoFramePresented('voice', 3, 'screen')

    await expect(
      harness.controller.recoverRemoteVideoDemand('voice', 3, 'screen'),
    ).resolves.toBe(true)
    await harness.controller.dispose()
  })

  it('uses the same native-owned recovery after a subscription failure', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      const listener = vi.fn()
      harness.controller.subscribe(listener)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()
      harness.event({
        type: 'remoteVideoFailed',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        source: 'screen',
        reason: 'subscription',
      })
      await vi.advanceTimersByTimeAsync(250)

      expect(harness.request.mock.calls.map(([command]) => command)).toEqual([
        expect.objectContaining({
          type: 'retryRemoteVideo',
        }),
      ])
      expect(harness.request.mock.calls.some(([command]) =>
        command.type === 'setRemoteVideoDemand' && !command.demanded,
      )).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(harness.diagnostics).toHaveBeenCalledWith(expect.objectContaining({
        event: 'remote_video_recovery_degraded',
        reason: 'subscription_recovery_budget_exceeded',
      }))
      expect(harness.controller.isRemoteVideoDemanded('voice', 3, 'screen'))
        .toBe(true)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({
        type: 'remoteVideoDemandFailed',
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        message: 'Не удалось подключиться к видеопотоку',
      })
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers an unexpected SDK track removal through the native owner', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      await vi.advanceTimersByTimeAsync(1_000)
      harness.request.mockClear()
      harness.event({
        type: 'remoteVideoTrackRemoved',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
      })
      await vi.advanceTimersByTimeAsync(250)

      expect(harness.request.mock.calls.map(([command]) => command)).toEqual([
        expect.objectContaining({
          type: 'retryRemoteVideo',
        }),
      ])
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps retrying until a replacement track exists within the budget', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(1_000)
      await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
      harness.request.mockClear()
      harness.event({
        type: 'remoteVideoFailed',
        sequence: 1,
        sessionId: 'voice',
        generation: 3,
        trackId: 'screen',
        source: 'screen',
        reason: 'subscription',
      })
      await vi.advanceTimersByTimeAsync(250)
      await vi.advanceTimersByTimeAsync(1_500)

      const retries = harness.request.mock.calls
        .map(([command]) => command)
        .filter((command) => command.type === 'retryRemoteVideo')
      expect(retries).toHaveLength(2)
      expect(retries).toEqual([
        expect.objectContaining({ type: 'retryRemoteVideo' }),
        expect.objectContaining({ type: 'retryRemoteVideo' }),
      ])
      await harness.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restore a stalled track after the user stops watching it', async () => {
    const harness = createHarness()
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', true)
    harness.request.mockClear()
    let releaseRecovery!: () => void
    let recoveryRequests = 0
    harness.request.mockImplementation(async (command: MediaRuntimeCommand) => {
      if (command.type === 'retryRemoteVideo' && ++recoveryRequests === 1) {
        await new Promise<void>((resolve) => { releaseRecovery = resolve })
      }
      return undefined
    })

    const recovery = harness.controller.recoverRemoteVideoDemand(
      'voice',
      3,
      'screen',
    )
    await waitUntil(() => recoveryRequests === 1)
    await harness.controller.setRemoteVideoDemand('voice', 3, 'screen', false)
    releaseRecovery()

    await expect(recovery).resolves.toBe(false)
    expect(harness.request.mock.calls.filter(
      ([command]) => command.type === 'retryRemoteVideo',
    )).toHaveLength(1)
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
      type: 'sessionLifecycle',
      sequence: 2,
      sessionId: 'screen-a',
      generation: 3,
      kind: 'screen',
      state: { status: 'idle' },
    })
    harness.request.mockClear()
    await harness.controller.setLocalScreenPreviewDemand({
      demanded: true,
      width: 1600,
      height: 900,
      fps: 30,
    })
    expect(harness.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'setLocalScreenPreviewDemand',
      sessionId: 'screen-a',
      generation: 4,
    }), expect.any(Number))

    harness.event({
      type: 'sessionStopped',
      sequence: 3,
      sessionId: 'screen-a',
      generation: 5,
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
      sequence: 4,
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
      metrics: { revision: 1, inputDb: -18, thresholdDb: -28, open: true },
    })

    expect(listener).toHaveBeenCalledWith({
      type: 'microphoneMetrics',
      event: { revision: 1, inputDb: -18, thresholdDb: -28, open: true },
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
      metrics: { revision: 1, inputDb: -12, thresholdDb: -28, open: true },
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
      event: { revision: 1, inputDb: -12, thresholdDb: -28, open: true },
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
      sessionId: expect.any(String),
      generation: expect.any(Number),
    })
    expect(restored?.sessionId).not.toBe(first.sessionId)
    expect(restored?.generation).toBeGreaterThan(first.generation)
  })

  it('lets runtime shutdown own preview teardown during app disposal', async () => {
    const harness = createHarness()
    await harness.controller.startMicrophonePreview()
    harness.request.mockClear()

    await harness.controller.dispose()

    expect(harness.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stopPreview' }),
      expect.anything(),
    )
    expect(harness.shutdown).toHaveBeenCalledTimes(1)
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
