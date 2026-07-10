import { describe, expect, it, vi } from 'vitest'

import type {
  LocalMediaIntent,
  NativeMediaSession,
  ScreenSourceSpec,
} from '@syrnike13/platform'

import {
  NativeMediaIntentError,
  NativeMediaReconciler,
} from './native-media-reconciler'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function createExecutionHarness() {
  const microphoneStarts: Array<ReturnType<typeof deferred<NativeMediaSession>>> = []
  const screenStarts: Array<ReturnType<typeof deferred<NativeMediaSession>>> = []
  const calls = {
    cancelPendingStarts: vi.fn(async () => undefined),
    startMicrophone: vi.fn((options: any) => {
      const next = deferred<NativeMediaSession>()
      microphoneStarts.push(next)
      return next.promise
    }),
    reconnectMicrophone: vi.fn((sessionId: string, options: any) => {
      const next = deferred<NativeMediaSession>()
      microphoneStarts.push(next)
      return next.promise
    }),
    setMicrophoneMuted: vi.fn(async () => undefined),
    prepareScreen: vi.fn(async () => undefined),
    startScreen: vi.fn((options: any) => {
      const next = deferred<NativeMediaSession>()
      screenStarts.push(next)
      return next.promise
    }),
    disconnectPreparedScreen: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
  }
  const scheduledRetries: Array<{
    delayMs: number
    cancelled: boolean
    run(): void
  }> = []
  const reconciler = new NativeMediaReconciler({
    execution: calls,
    schedule: (callback, delayMs) => {
      const task = {
        delayMs,
        cancelled: false,
        run() {
          if (!task.cancelled) callback()
        },
      }
      scheduledRetries.push(task)
      return {
        cancel() {
          task.cancelled = true
        },
      }
    },
  })
  return {
    reconciler,
    calls,
    microphoneStarts,
    screenStarts,
    scheduledRetries,
  }
}

function intent(overrides: Partial<LocalMediaIntent> = {}): LocalMediaIntent {
  return {
    operationId: 'voice-op-1',
    envelopeRevision: 1,
    microphone: {
      revision: 1,
      state: 'off',
    },
    screen: {
      revision: 1,
      state: 'off',
    },
    ...overrides,
  }
}

function microphonePublish(
  revision: number,
  muted = false,
): LocalMediaIntent['microphone'] {
  return {
    revision,
    state: 'publish',
    muted,
    audioBitrateKbps: 96,
    credentials: {
      url: 'wss://livekit.example',
      token: 'token-value',
      participantIdentity: 'user:desktop-native:microphone',
    },
  }
}

function microphoneRetain(
  revision: number,
  muted = false,
): LocalMediaIntent['microphone'] {
  return {
    revision,
    state: 'retain',
    muted,
  }
}

function screenPublish(revision: number): LocalMediaIntent['screen'] {
  return {
    revision,
    state: 'publish',
    credentials: {
      url: 'wss://livekit.example',
      token: 'token-value',
      participantIdentity: 'user:desktop-native:screen',
    },
    source: screenSource(),
  }
}

function screenPrepare(revision: number): LocalMediaIntent['screen'] {
  return {
    revision,
    state: 'prepare',
    credentials: {
      url: 'wss://livekit.example',
      token: 'token-value',
      participantIdentity: 'user:desktop-native:screen',
    },
    source: screenSource(),
  }
}

function screenSource(): ScreenSourceSpec {
  return {
    sourceId: 'window:1',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 8_000_000,
    audioBitrate: 128_000,
    audioRequested: true,
  }
}

describe('NativeMediaReconciler', () => {
  it('isolates observed-state listeners from reconciliation', async () => {
    const harness = createExecutionHarness()
    const healthyListener = vi.fn()
    harness.reconciler.subscribe(() => {
      throw new Error('broken reconciler observer')
    })
    harness.reconciler.subscribe(healthyListener)

    await harness.reconciler.applyIntent(intent({ envelopeRevision: 2 }))
    await vi.waitFor(() => {
      expect(healthyListener).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'microphone',
          operationId: 'voice-op-1',
          state: 'off',
        }),
      )
    })
  })

  it('accepts quickly while microphone publish is blocked and coalesces newer off intent', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))

    await expect(
      harness.reconciler.applyIntent(
        intent({
          microphone: microphonePublish(2, false),
          envelopeRevision: 2,
        }),
      ),
    ).resolves.toEqual({
      operationId: 'voice-op-1',
      acceptedEnvelopeRevision: 2,
      disposition: 'accepted',
    })
    await vi.waitFor(() => expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1))

    await expect(
      harness.reconciler.applyIntent(
        intent({
          microphone: { revision: 3, state: 'off' },
          envelopeRevision: 3,
        }),
      ),
    ).resolves.toEqual({
      operationId: 'voice-op-1',
      acceptedEnvelopeRevision: 3,
      disposition: 'accepted',
    })
    expect(harness.calls.cancelPendingStarts).toHaveBeenCalledWith('microphone')

    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-session-1',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone',
    })

    await vi.waitFor(() => {
      expect(harness.calls.stopSession).toHaveBeenCalledWith('mic-session-1')
    })

    expect(
      events.filter(
        (event) => event.kind === 'microphone' && event.state === 'published',
      ),
    ).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'microphone',
        revision: 3,
        state: 'off',
      }),
    )
  })

  it('adopts a publish that commits while retain is becoming current', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))

    await harness.reconciler.applyIntent(
      intent({
        microphone: microphonePublish(2, false),
        envelopeRevision: 2,
      }),
    )
    await vi.waitFor(() => expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1))

    await expect(
      harness.reconciler.applyIntent(
        intent({
          microphone: microphoneRetain(3, true),
          envelopeRevision: 3,
        }),
      ),
    ).resolves.toMatchObject({
      disposition: 'accepted',
      acceptedEnvelopeRevision: 3,
    })

    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-session-2',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone',
    })

    await vi.waitFor(() => {
      expect(harness.calls.setMicrophoneMuted).toHaveBeenCalledWith(
        'mic-session-2',
        true,
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'microphone',
          revision: 3,
          state: 'retained',
          muted: true,
        }),
      )
    })
    expect(
      events.filter(
        (event) => event.kind === 'microphone' && event.state === 'published',
      ),
    ).toEqual([])
  })

  it('retains and mutes a real committed microphone while next credentials are pending', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))
    await harness.reconciler.applyIntent(
      intent({
        microphone: microphonePublish(2, false),
        envelopeRevision: 2,
      }),
    )
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1)
    })
    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-committed-a',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone',
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({ state: 'published', revision: 2 }),
      )
    })

    await harness.reconciler.applyIntent({
      ...intent(),
      operationId: 'voice-op-b',
      envelopeRevision: 3,
      microphone: microphoneRetain(3, true),
    })
    await vi.waitFor(() => {
      expect(harness.calls.setMicrophoneMuted).toHaveBeenCalledWith(
        'mic-committed-a',
        true,
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          operationId: 'voice-op-b',
          revision: 3,
          state: 'retained',
          muted: true,
        }),
      )
    })
  })

  it('reconciles from a stale native commit instead of losing the real publication', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))

    await harness.reconciler.applyIntent(intent({
      operationId: 'voice-op-a',
      envelopeRevision: 2,
      microphone: microphonePublish(2, false),
    }))
    await vi.waitFor(() => expect(harness.microphoneStarts).toHaveLength(1))
    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-shared-session',
      nativeParticipantIdentity: 'native-a',
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({
        operationId: 'voice-op-a',
        state: 'published',
      }))
    })

    await harness.reconciler.applyIntent(intent({
      operationId: 'voice-op-b',
      envelopeRevision: 3,
      microphone: {
        ...microphonePublish(3, false),
        credentials: {
          url: 'wss://livekit.example',
          token: 'token-b',
          participantIdentity: 'native-b:microphone',
        },
      },
    }))
    await vi.waitFor(() => expect(harness.microphoneStarts).toHaveLength(2))

    await harness.reconciler.applyIntent(intent({
      operationId: 'voice-op-a',
      envelopeRevision: 4,
      microphone: {
        ...microphonePublish(4, true),
        credentials: {
          url: 'wss://livekit.example',
          token: 'token-a-2',
          participantIdentity: 'native-a-2:microphone',
        },
      },
    }))
    harness.microphoneStarts[1].resolve({
      kind: 'microphone',
      sessionId: 'mic-shared-session',
      nativeParticipantIdentity: 'native-b:microphone',
    })

    await vi.waitFor(() => {
      expect(harness.calls.reconnectMicrophone).toHaveBeenCalledTimes(2)
    })
    expect(harness.calls.stopSession).not.toHaveBeenCalledWith('mic-shared-session')
    expect(harness.calls.reconnectMicrophone.mock.calls[1]?.[0]).toBe(
      'mic-shared-session',
    )

    harness.microphoneStarts[2].resolve({
      kind: 'microphone',
      sessionId: 'mic-shared-session',
      nativeParticipantIdentity: 'native-a-2:microphone',
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({
        operationId: 'voice-op-a',
        revision: 4,
        state: 'published',
        participantIdentity: 'native-a-2:microphone',
      }))
    })
    expect(events).not.toContainEqual(expect.objectContaining({
      operationId: 'voice-op-b',
      revision: 3,
      state: 'published',
    }))
  })

  it('reconciles B to A retain when only the envelope owner changes', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))
    await harness.reconciler.applyIntent(
      intent({
        microphone: microphonePublish(2, false),
        envelopeRevision: 2,
      }),
    )
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1)
    })
    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-retained-a',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone',
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          operationId: 'voice-op-1',
          revision: 2,
          state: 'published',
        }),
      )
    })

    await harness.reconciler.applyIntent({
      ...intent(),
      operationId: 'voice-op-b',
      envelopeRevision: 3,
      microphone: microphoneRetain(3, true),
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          operationId: 'voice-op-b',
          revision: 3,
          state: 'retained',
        }),
      )
    })
    const bEvent = events.find(
      (event) =>
        event.kind === 'microphone' &&
        event.operationId === 'voice-op-b' &&
        event.revision === 3 &&
        event.state === 'retained',
    )

    await harness.reconciler.applyIntent({
      ...intent(),
      operationId: 'voice-op-1',
      envelopeRevision: 4,
      microphone: microphoneRetain(3, true),
    })

    await vi.waitFor(() => {
      expect(harness.calls.setMicrophoneMuted).toHaveBeenCalledTimes(2)
      expect(events).toContainEqual(
        expect.objectContaining({
          operationId: 'voice-op-1',
          revision: 3,
          state: 'retained',
        }),
      )
    })
    const aEvent = events.findLast(
      (event) =>
        event.kind === 'microphone' &&
        event.operationId === 'voice-op-1' &&
        event.revision === 3 &&
        event.state === 'retained',
    )
    expect(aEvent.reconcileAttempt).toBeGreaterThan(bEvent.reconcileAttempt)
  })

  it('returns duplicate for the same exact envelope', async () => {
    const harness = createExecutionHarness()
    const localIntent = intent({
      microphone: microphonePublish(2, false),
      envelopeRevision: 2,
    })

    await expect(harness.reconciler.applyIntent(localIntent)).resolves.toMatchObject({
      disposition: 'accepted',
      acceptedEnvelopeRevision: 2,
    })
    await expect(harness.reconciler.applyIntent(localIntent)).resolves.toMatchObject({
      disposition: 'duplicate',
      acceptedEnvelopeRevision: 2,
    })
  })

  it('rejects stale or conflicting envelopes as typed stale_intent', async () => {
    const harness = createExecutionHarness()

    await harness.reconciler.applyIntent(
      intent({
        microphone: microphonePublish(2, false),
        envelopeRevision: 2,
      }),
    )

    await expect(
      harness.reconciler.applyIntent(
        intent({
          microphone: microphonePublish(2, true),
          envelopeRevision: 2,
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<NativeMediaIntentError>>({
        code: 'stale_intent',
      }),
    )

    await expect(
      harness.reconciler.applyIntent(
        intent({
          microphone: microphonePublish(2, true),
          envelopeRevision: 3,
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<NativeMediaIntentError>>({
        code: 'stale_intent',
      }),
    )
  })

  it('treats microphone and screen revisions independently', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))

    await harness.reconciler.applyIntent(
      intent({
        microphone: microphonePublish(2, false),
        screen: screenPrepare(1),
        envelopeRevision: 2,
      }),
    )
    await vi.waitFor(() => expect(harness.calls.prepareScreen).toHaveBeenCalledTimes(1))

    await expect(
      harness.reconciler.applyIntent(
        intent({
          microphone: microphonePublish(2, false),
          screen: screenPublish(2),
          envelopeRevision: 3,
        }),
      ),
    ).resolves.toMatchObject({
      disposition: 'accepted',
      acceptedEnvelopeRevision: 3,
    })

    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-session-3',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone',
    })

    await vi.waitFor(() => expect(harness.calls.startScreen).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'microphone',
          revision: 2,
          state: 'published',
        }),
      )
    })
    expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1)
  })

  it('does not promote stale screen completion over a newer off revision', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))

    await harness.reconciler.applyIntent(
      intent({
        screen: screenPublish(2),
        envelopeRevision: 2,
      }),
    )
    await vi.waitFor(() => expect(harness.calls.startScreen).toHaveBeenCalledTimes(1))

    await harness.reconciler.applyIntent(
      intent({
        screen: { revision: 3, state: 'off' },
        envelopeRevision: 3,
      }),
    )

    harness.screenStarts[0].resolve({
      kind: 'screen',
      sessionId: 'screen-session-1',
      encoder: 'webrtc',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 8_000_000,
      nativeParticipantIdentity: 'user:desktop-native:screen',
    })

    await vi.waitFor(() => {
      expect(harness.calls.stopSession).toHaveBeenCalledWith('screen-session-1')
    })
    expect(
      events.filter((event) => event.kind === 'screen' && event.state === 'published'),
    ).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'screen',
        revision: 3,
        state: 'off',
      }),
    )
  })

  it('reapplies only the latest immutable intent after a runtime restart', async () => {
    const harness = createExecutionHarness()
    const desired = intent({
      microphone: microphonePublish(2, true),
      envelopeRevision: 2,
    })
    await harness.reconciler.applyIntent(desired)
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1)
    })
    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-before-crash',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone',
    })
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1)
    })

    harness.reconciler.recoverAfterRuntimeRestart(1)
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(2)
    })
    harness.reconciler.recoverAfterRuntimeRestart(1)
    expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(2)

    expect(harness.calls.startMicrophone.mock.calls[1]?.[0]).toMatchObject({
      requestId: 'voice-op-1:microphone:2',
      muted: true,
    })
  })

  it('projects stop failures as observed errors without losing desired intent', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))
    await harness.reconciler.applyIntent(
      intent({
        microphone: microphonePublish(2),
        envelopeRevision: 2,
      }),
    )
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1)
    })
    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-stop-failure',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone',
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'microphone', state: 'published' }),
      )
    })
    harness.calls.stopSession.mockRejectedValueOnce(new Error('sensitive failure'))

    await harness.reconciler.applyIntent(
      intent({
        microphone: { revision: 3, state: 'off' },
        envelopeRevision: 3,
      }),
    )
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'microphone',
          revision: 3,
          state: 'error',
          errorStage: 'off',
          errorMessage: 'Native media execution failed',
        }),
      )
    })
    expect(JSON.stringify(events)).not.toContain('sensitive failure')
    expect(harness.scheduledRetries).toEqual([
      expect.objectContaining({ delayMs: 250, cancelled: false }),
    ])
  })

  it('retries the current revision with backoff but cancels retry for newer intent', async () => {
    const harness = createExecutionHarness()
    await harness.reconciler.applyIntent(
      intent({
        microphone: microphonePublish(2),
        envelopeRevision: 2,
      }),
    )
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1)
    })
    harness.microphoneStarts[0].reject(new Error('publish failed'))
    await vi.waitFor(() => {
      expect(harness.scheduledRetries).toHaveLength(1)
    })
    expect(harness.scheduledRetries[0].delayMs).toBe(250)

    harness.scheduledRetries[0].run()
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(2)
    })
    harness.microphoneStarts[1].reject(new Error('publish failed again'))
    await vi.waitFor(() => {
      expect(harness.scheduledRetries).toHaveLength(2)
    })
    expect(harness.scheduledRetries[1].delayMs).toBe(1_000)

    await harness.reconciler.applyIntent(
      intent({
        microphone: { revision: 3, state: 'off' },
        envelopeRevision: 3,
      }),
    )
    expect(harness.scheduledRetries[1].cancelled).toBe(true)
    harness.scheduledRetries[1].run()
    expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(2)
  })

  it('turns an unexpected committed terminal event into fenced error and retry', async () => {
    const harness = createExecutionHarness()
    const events: any[] = []
    harness.reconciler.subscribe((event) => events.push(event))
    await harness.reconciler.applyIntent(
      intent({
        microphone: microphonePublish(2),
        envelopeRevision: 2,
      }),
    )
    await vi.waitFor(() => {
      expect(harness.calls.startMicrophone).toHaveBeenCalledTimes(1)
    })
    harness.microphoneStarts[0].resolve({
      kind: 'microphone',
      sessionId: 'mic-terminal',
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone',
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({ state: 'published', revision: 2 }),
      )
    })

    harness.reconciler.observeExecutionEvent({
      type: 'executionTerminal',
      event: {
        kind: 'microphone',
        sessionId: 'mic-terminal',
        code: 'livekit_disconnected',
        stage: 'microphone',
        retryable: true,
      },
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'microphone',
        operationId: 'voice-op-1',
        revision: 2,
        state: 'error',
        errorCode: 'livekit_disconnected',
        retryable: true,
      }),
    )
    expect(harness.scheduledRetries).toEqual([
      expect.objectContaining({ delayMs: 250, cancelled: false }),
    ])
  })
})
