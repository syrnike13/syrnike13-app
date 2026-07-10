import { describe, expect, it, vi } from 'vitest'

import { isNativeRuntimeEvent } from './contract'
import { NativeMediaController } from './native-media-controller'

function createHarness() {
  let eventListener: ((event: unknown) => void) | null = null
  let stateListener: ((state: any) => void) | null = null
  const request = vi.fn(async (command: any) => {
    if (command.type === 'connectMicrophone') {
      return {
        kind: 'microphone',
        sessionId: command.sessionId,
        audio: {
          mode: 'microphone',
          sampleRate: 48_000,
          channels: 1,
          noiseSuppression: 'software',
          echoCancellation: 'software',
        },
        nativeParticipantIdentity: command.options.livekit.participantIdentity,
      }
    }
    if (command.type === 'startScreenCapture') {
      return {
        kind: 'screen',
        sessionId: command.sessionId,
        encoder: 'webrtc',
        width: command.options.width,
        height: command.options.height,
        fps: command.options.fps,
        bitrate: command.options.bitrate,
      }
    }
    return undefined
  })
  const supervisor = {
    onEvent(listener: (event: unknown) => void) {
      eventListener = listener
      return () => {}
    },
    onStateChange(listener: (state: any) => void) {
      stateListener = listener
      return () => {}
    },
    getSnapshot: () => ({
      runtime: 'media',
      status: 'ready',
      restartCount: 0,
      ready: {
        capabilities: ['microphone', 'screen', 'screenAudio'],
      },
    }),
    start: vi.fn(async () => undefined),
    request,
    shutdown: vi.fn(async () => undefined),
  }
  const controller = new NativeMediaController({
    supervisor: supervisor as any,
    runtimeAvailable: () => true,
    getSelfWindowHwnd: () => '123',
    processId: 99,
  })
  return {
    controller,
    request,
    event: (event: unknown) => eventListener?.(event),
    state: (state: unknown) => stateListener?.(state),
  }
}

function microphoneOptions(requestId = 'mic-request-1') {
  return {
    kind: 'microphone' as const,
    requestId,
    sampleRate: 48_000 as const,
    channels: 1 as const,
    noiseSuppression: true,
    echoCancellation: true,
    inputVolume: 1,
    muted: false,
    livekit: {
      url: 'wss://livekit.example',
      token: 'token',
      participantIdentity: 'user:desktop-native:microphone-1',
    },
  }
}

function screenOptions(requestId = 'screen-request-1') {
  return {
    kind: 'screen' as const,
    requestId,
    sourceId: 'window:1',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 8_000_000,
    audio: { requested: true },
    livekit: {
      url: 'wss://livekit.example',
      token: 'token',
      participantIdentity: 'user:desktop-native:screen-1',
    },
  }
}

function previewOptions() {
  return {
    sampleRate: 48_000 as const,
    channels: 1 as const,
    noiseSuppression: true,
    echoCancellation: true,
    inputVolume: 1,
    voiceGateEnabled: false,
    voiceGateThresholdDb: -45,
    voiceGateAutoThreshold: true,
  }
}

describe('NativeMediaController', () => {
  it('emits an anonymous operation result when a native session start fails', async () => {
    const harness = createHarness()
    const events: any[] = []
    harness.controller.subscribe((event) => events.push(event))
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'connectMicrophone') throw new Error('publish failed')
      return undefined
    })

    await expect(
      harness.controller.startSession(microphoneOptions()),
    ).rejects.toThrow('publish failed')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'operationMetric',
        operation: 'sessionStart',
        kind: 'microphone',
        outcome: 'failed',
        durationMs: expect.any(Number),
      }),
    )
  })

  it('keeps recency cancellation out of the eligible start failure metric', async () => {
    const harness = createHarness()
    const events: any[] = []
    harness.controller.subscribe((event) => events.push(event))
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'connectMicrophone') {
        throw new Error('Native microphone start cancelled')
      }
      return undefined
    })

    await expect(
      harness.controller.startSession(microphoneOptions()),
    ).rejects.toThrow('cancelled')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'operationMetric',
        outcome: 'cancelled',
      }),
    )
  })

  it('starts microphone and screen through independent typed queues', async () => {
    const harness = createHarness()
    let releaseMicrophone!: () => void
    const waitForMicrophone = new Promise<void>((resolve) => {
      releaseMicrophone = resolve
    })
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'connectMicrophone') {
        await waitForMicrophone
        return {
          kind: 'microphone',
          sessionId: command.sessionId,
          audio: {
            mode: 'microphone',
            sampleRate: 48_000,
            channels: 1,
            noiseSuppression: 'software',
            echoCancellation: 'software',
          },
          nativeParticipantIdentity: command.options.livekit.participantIdentity,
        }
      }
      if (command.type === 'startScreenCapture') {
        return {
          kind: 'screen',
          sessionId: command.sessionId,
          encoder: 'webrtc',
          width: 1920,
          height: 1080,
          fps: 60,
          bitrate: 8_000_000,
        }
      }
      return undefined
    })

    const microphone = harness.controller.startSession(microphoneOptions())
    const screen = harness.controller.startSession(screenOptions())
    await expect(screen).resolves.toMatchObject({ kind: 'screen' })
    releaseMicrophone()
    await expect(microphone).resolves.toMatchObject({ kind: 'microphone' })
  })

  it('validates renderer input before mutating generations or dispatching', () => {
    const harness = createHarness()
    expect(() =>
      harness.controller.startSession({ ...screenOptions(), fps: 0 }),
    ).toThrow('Invalid native media session options')
    expect(() =>
      harness.controller.startSession({ ...screenOptions(), fps: 59.5 }),
    ).toThrow('Invalid native media session options')
    expect(harness.request).not.toHaveBeenCalled()
    expect(harness.controller.getState().engine.activeSessions).toEqual([])
  })

  it('restores the committed generation after a failed microphone reconnect', async () => {
    const harness = createHarness()
    const session = await harness.controller.startSession(microphoneOptions())
    const generations: number[] = []
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'connectMicrophone') {
        generations.push(command.generation)
        throw new Error('candidate failed')
      }
      if (command.type === 'configureMicrophone') {
        generations.push(command.generation)
      }
      return undefined
    })

    await expect(
      harness.controller.reconnectMicrophoneSession(
        session.sessionId,
        microphoneOptions('mic-request-2'),
      ),
    ).rejects.toThrow('candidate failed')
    await harness.controller.configureMicrophoneRuntime(session.sessionId, {
      inputVolume: 0.5,
    })
    expect(generations[1]).toBeLessThan(generations[0])
  })

  it('keeps a native-committed generation when post-await recency becomes stale', async () => {
    const harness = createHarness()
    const session = await harness.controller.startSession(microphoneOptions())
    const reconnectGenerations: number[] = []
    let resolveFirst!: (value: unknown) => void
    const firstResult = new Promise((resolve) => {
      resolveFirst = resolve
    })
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'connectMicrophone') {
        reconnectGenerations.push(command.generation)
        if (command.options.requestId === 'mic-request-2') return firstResult
        throw new Error('latest candidate failed')
      }
      if (command.type === 'configureMicrophone') {
        reconnectGenerations.push(command.generation)
      }
      return undefined
    })
    harness.request.mockClear()

    const stale = harness.controller.reconnectMicrophoneSession(
      session.sessionId,
      microphoneOptions('mic-request-2'),
    )
    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.some(
          ([command]) => command.type === 'connectMicrophone',
        ),
      ).toBe(true),
    )
    const latest = harness.controller.reconnectMicrophoneSession(
      session.sessionId,
      microphoneOptions('mic-request-3'),
    )
    resolveFirst({
      kind: 'microphone',
      sessionId: session.sessionId,
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone-2',
    })

    await expect(stale).rejects.toThrow('cancelled')
    await expect(latest).rejects.toThrow('latest candidate failed')
    await harness.controller.configureMicrophoneRuntime(session.sessionId, {
      inputVolume: 0.75,
    })
    expect(reconnectGenerations[2]).toBe(reconnectGenerations[0])
    expect(reconnectGenerations[2]).toBeLessThan(reconnectGenerations[1])
  })

  it('terminally fences an in-flight reconnect before disconnecting', async () => {
    const harness = createHarness()
    const session = await harness.controller.startSession(microphoneOptions())
    let resolveReconnect!: (value: unknown) => void
    const reconnectResult = new Promise((resolve) => {
      resolveReconnect = resolve
    })
    harness.request.mockImplementation(async (command: any) => {
      if (
        command.type === 'connectMicrophone' &&
        command.options.requestId === 'mic-request-2'
      ) {
        return reconnectResult
      }
      return undefined
    })
    harness.request.mockClear()

    const reconnect = harness.controller.reconnectMicrophoneSession(
      session.sessionId,
      microphoneOptions('mic-request-2'),
    )
    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.some(
          ([command]) => command.type === 'connectMicrophone',
        ),
      ).toBe(true),
    )
    const candidate = harness.request.mock.calls.find(
      ([command]) => command.type === 'connectMicrophone',
    )?.[0]
    await harness.controller.stopSession(session.sessionId)
    const terminal = harness.request.mock.calls.find(
      ([command]) => command.type === 'disconnectMicrophone',
    )?.[0]
    expect(terminal.generation).toBeGreaterThan(candidate.generation)

    resolveReconnect({
      kind: 'microphone',
      sessionId: session.sessionId,
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: 'user:desktop-native:microphone-2',
    })
    await expect(reconnect).rejects.toThrow('cancelled')
    expect(harness.controller.getState().engine.activeSessions).toEqual([])
  })

  it('disconnects the prepared screen with its owned generation', async () => {
    const harness = createHarness()
    await harness.controller.prepareScreenSession({
      livekit: screenOptions().livekit,
    })
    await harness.controller.disconnectPreparedScreenSession()

    const connect = harness.request.mock.calls.find(
      ([command]) => command.type === 'connectScreen',
    )?.[0]
    const disconnect = harness.request.mock.calls.find(
      ([command]) => command.type === 'disconnectScreen',
    )?.[0]
    expect(disconnect.generation).toBe(connect.generation)
    expect(disconnect.sessionId).toBe(connect.sessionId)
  })

  it('keeps screen generations monotonic across prepare, disconnect, prepare, start, and stop', async () => {
    const harness = createHarness()
    await harness.controller.prepareScreenSession({
      livekit: screenOptions().livekit,
    })
    const firstConnect = harness.request.mock.calls.find(
      ([command]) => command.type === 'connectScreen',
    )?.[0]

    await harness.controller.disconnectPreparedScreenSession()
    const firstDisconnect = harness.request.mock.calls.find(
      ([command]) =>
        command.type === 'disconnectScreen' &&
        command.sessionId === firstConnect.sessionId,
    )?.[0]

    await harness.controller.prepareScreenSession({
      livekit: {
        ...screenOptions().livekit,
        token: 'next-room-token',
      },
    })
    const secondConnect = harness.request.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'connectScreen')
      .at(-1)

    const session = await harness.controller.startSession({
      ...screenOptions(),
      livekit: {
        ...screenOptions().livekit,
        token: 'next-room-token',
      },
    })
    const start = harness.request.mock.calls.find(
      ([command]) => command.type === 'startScreenCapture',
    )?.[0]

    await harness.controller.stopSession(session.sessionId)
    const stop = harness.request.mock.calls.find(
      ([command]) => command.type === 'stopScreenCapture',
    )?.[0]
    const terminalDisconnect = harness.request.mock.calls
      .map(([command]) => command)
      .find(
        (command) =>
          command.type === 'disconnectScreen' &&
          command.sessionId === session.sessionId &&
          command.terminal,
      )

    expect(firstDisconnect.generation).toBe(firstConnect.generation)
    expect(secondConnect.generation).toBeGreaterThan(firstDisconnect.generation)
    expect(start.sessionId).toBe(secondConnect.sessionId)
    expect(start.generation).toBeGreaterThan(secondConnect.generation)
    expect(stop.generation).toBeGreaterThan(start.generation)
    expect(terminalDisconnect.generation).toBe(stop.generation)
  })

  it('transfers prepared screen ownership and disconnects the active room on stop', async () => {
    const harness = createHarness()
    await harness.controller.prepareScreenSession({
      livekit: screenOptions().livekit,
    })
    const prepared = harness.request.mock.calls.find(
      ([command]) => command.type === 'connectScreen',
    )?.[0]

    const session = await harness.controller.startSession(screenOptions())
    const start = harness.request.mock.calls.find(
      ([command]) => command.type === 'startScreenCapture',
    )?.[0]
    expect(start.sessionId).toBe(prepared.sessionId)
    expect(start.generation).toBeGreaterThan(prepared.generation)

    await harness.controller.stopSession(session.sessionId)
    const stop = harness.request.mock.calls.find(
      ([command]) => command.type === 'stopScreenCapture',
    )?.[0]
    const disconnects = harness.request.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'disconnectScreen')
    expect(stop.generation).toBeGreaterThan(start.generation)
    expect(disconnects).toContainEqual({
      type: 'disconnectScreen',
      sessionId: start.sessionId,
      generation: stop.generation,
      terminal: true,
    })

    const disconnectCount = disconnects.length
    await harness.controller.disconnectPreparedScreenSession()
    expect(
      harness.request.mock.calls.filter(
        ([command]) => command.type === 'disconnectScreen',
      ),
    ).toHaveLength(disconnectCount)
  })

  it('reconnects a recovered prepared screen with a fresh screen generation before start consumes it', async () => {
    const harness = createHarness()
    await harness.controller.prepareScreenSession({
      livekit: screenOptions().livekit,
    })
    const initialConnect = harness.request.mock.calls.find(
      ([command]) => command.type === 'connectScreen',
    )?.[0]

    harness.state({ status: 'recovering', restartCount: 1, lastFailure: 'crash' })
    harness.state({ status: 'ready', restartCount: 1 })
    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(
          ([command]) => command.type === 'connectScreen',
        ),
      ).toHaveLength(2),
    )

    const recoveredConnect = harness.request.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'connectScreen')
      .at(-1)

    await harness.controller.startSession(screenOptions())
    const start = harness.request.mock.calls.find(
      ([command]) => command.type === 'startScreenCapture',
    )?.[0]

    expect(recoveredConnect.sessionId).toBe(initialConnect.sessionId)
    expect(recoveredConnect.generation).toBeGreaterThan(initialConnect.generation)
    expect(start.sessionId).toBe(recoveredConnect.sessionId)
    expect(start.generation).toBeGreaterThan(recoveredConnect.generation)
  })

  it('does not let prepare retag or disconnect an active screen session', async () => {
    const harness = createHarness()
    const session = await harness.controller.startSession(screenOptions())
    const requestCount = harness.request.mock.calls.length

    await expect(
      harness.controller.prepareScreenSession({
        livekit: {
          ...screenOptions().livekit,
          token: 'next-room-token',
        },
      }),
    ).rejects.toThrow('while screen sharing is active')

    expect(harness.request).toHaveBeenCalledTimes(requestCount)
    expect(harness.controller.getState().engine.activeSessions).toEqual([
      expect.objectContaining({ sessionId: session.sessionId, kind: 'screen' }),
    ])
  })

  it('waits for terminal screen disconnect before preparing another room', async () => {
    const harness = createHarness()
    const session = await harness.controller.startSession(screenOptions())
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'stopScreenCapture') await stopGate
      return undefined
    })

    const stop = harness.controller.stopSession(session.sessionId)
    const prepare = harness.controller.prepareScreenSession({
      livekit: {
        ...screenOptions().livekit,
        token: 'next-room-token',
      },
    })
    await Promise.resolve()
    expect(
      harness.request.mock.calls.some(([command]) => command.type === 'connectScreen'),
    ).toBe(false)

    releaseStop()
    await stop
    await prepare
    const terminalDisconnectIndex = harness.request.mock.calls.findIndex(
      ([command]) => command.type === 'disconnectScreen' && command.terminal,
    )
    const prepareConnectIndex = harness.request.mock.calls.findIndex(
      ([command]) => command.type === 'connectScreen',
    )
    expect(terminalDisconnectIndex).toBeGreaterThanOrEqual(0)
    expect(prepareConnectIndex).toBeGreaterThan(terminalDisconnectIndex)
  })

  it('serializes a connecting prepare before consuming it in screen start', async () => {
    const harness = createHarness()
    let releasePrepare!: () => void
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'connectScreen') {
        await prepareGate
        return undefined
      }
      if (command.type === 'startScreenCapture') {
        return {
          kind: 'screen',
          sessionId: command.sessionId,
          encoder: 'webrtc',
          width: command.options.width,
          height: command.options.height,
          fps: command.options.fps,
          bitrate: command.options.bitrate,
        }
      }
      return undefined
    })

    const prepare = harness.controller.prepareScreenSession({
      livekit: screenOptions().livekit,
    })
    const start = harness.controller.startSession(screenOptions())
    await Promise.resolve()
    expect(
      harness.request.mock.calls.some(
        ([command]) => command.type === 'startScreenCapture',
      ),
    ).toBe(false)

    releasePrepare()
    await prepare
    await expect(start).resolves.toMatchObject({ kind: 'screen' })

    const connect = harness.request.mock.calls.find(
      ([command]) => command.type === 'connectScreen',
    )?.[0]
    const capture = harness.request.mock.calls.find(
      ([command]) => command.type === 'startScreenCapture',
    )?.[0]
    expect(capture.sessionId).toBe(connect.sessionId)
    expect(capture.generation).toBeGreaterThan(connect.generation)
    expect(
      harness.request.mock.calls.some(
        ([command]) => command.type === 'disconnectScreen',
      ),
    ).toBe(false)
  })

  it('reports a recovering runtime loss without deleting desired sessions', async () => {
    const harness = createHarness()
    const session = await harness.controller.startSession(microphoneOptions())
    const listener = vi.fn()
    harness.controller.subscribe(listener)

    harness.state({
      status: 'recovering',
      restartCount: 1,
      lastFailure: 'host exited',
    })
    expect(listener).toHaveBeenCalledWith({
      type: 'runtimeLost',
      event: {
        sessionId: session.sessionId,
        reason: 'exit',
        message: 'host exited',
        recovering: true,
      },
    })
    expect(harness.controller.getState().engine.activeSessions).toHaveLength(1)
  })

  it('reports deterministic ABI mismatch as a handshake failure', async () => {
    const harness = createHarness()
    const session = await harness.controller.startSession(microphoneOptions())
    const listener = vi.fn()
    harness.controller.subscribe(listener)

    harness.state({
      status: 'degraded',
      restartCount: 1,
      degradedReason: 'Native runtime contract mismatch',
    })

    expect(listener).toHaveBeenCalledWith({
      type: 'runtimeLost',
      event: {
        sessionId: session.sessionId,
        reason: 'handshake_failed',
        message: 'Native runtime contract mismatch',
        recovering: false,
      },
    })
  })

  it('clears prepared screen and preview ownership when the supervisor degrades', async () => {
    const harness = createHarness()
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'startPreview') {
        return { sessionId: command.sessionId }
      }
      return undefined
    })
    const listener = vi.fn()
    harness.controller.subscribe(listener)
    await harness.controller.prepareScreenSession({
      livekit: screenOptions().livekit,
    })
    const preview = await harness.controller.startMicrophonePreview(previewOptions())

    harness.state({
      status: 'degraded',
      restartCount: 1,
      degradedReason: 'Native runtime unavailable',
    })

    expect(listener).toHaveBeenCalledWith({
      type: 'streamError',
      event: { sessionId: preview.sessionId, message: 'Native runtime unavailable' },
    })
    expect(listener).toHaveBeenCalledWith({
      type: 'streamEnded',
      sessionId: preview.sessionId,
    })

    harness.request.mockClear()
    await harness.controller.disconnectPreparedScreenSession()
    await harness.controller.stopMicrophonePreview(preview.sessionId)
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('does not duplicate a start that was already waiting for runtime recovery', async () => {
    const harness = createHarness()
    let resolveStart!: (value: unknown) => void
    const startResult = new Promise((resolve) => {
      resolveStart = resolve
    })
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'connectMicrophone') return startResult
      return undefined
    })
    const start = harness.controller.startSession(microphoneOptions())
    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(
          ([command]) => command.type === 'connectMicrophone',
        ),
      ).toHaveLength(1),
    )

    harness.state({ status: 'recovering', restartCount: 1, lastFailure: 'crash' })
    harness.state({ status: 'ready', restartCount: 1 })
    await Promise.resolve()
    expect(
      harness.request.mock.calls.filter(
        ([command]) => command.type === 'connectMicrophone',
      ),
    ).toHaveLength(1)

    const command = harness.request.mock.calls.find(
      ([candidate]) => candidate.type === 'connectMicrophone',
    )?.[0]
    resolveStart({
      kind: 'microphone',
      sessionId: command.sessionId,
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: command.options.livekit.participantIdentity,
    })
    await expect(start).resolves.toMatchObject({ kind: 'microphone' })
  })

  it('does not restore a pre-crash session over a newer user intent', async () => {
    const harness = createHarness()
    await harness.controller.startSession(microphoneOptions('mic-before-crash'))
    harness.state({ status: 'recovering', restartCount: 1, lastFailure: 'crash' })

    let resolveNewStart!: (value: unknown) => void
    const newStartResult = new Promise((resolve) => {
      resolveNewStart = resolve
    })
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'connectMicrophone') return newStartResult
      return undefined
    })
    const nextOptions = microphoneOptions('mic-after-crash')
    const next = harness.controller.startSession(nextOptions)
    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(
          ([command]) => command.type === 'connectMicrophone',
        ),
      ).toHaveLength(2),
    )
    harness.state({ status: 'ready', restartCount: 1 })
    const command = harness.request.mock.calls
      .map(([candidate]) => candidate)
      .filter((candidate) => candidate.type === 'connectMicrophone')
      .at(-1)
    resolveNewStart({
      kind: 'microphone',
      sessionId: command.sessionId,
      audio: {
        mode: 'microphone',
        sampleRate: 48_000,
        channels: 1,
        noiseSuppression: 'software',
        echoCancellation: 'software',
      },
      nativeParticipantIdentity: nextOptions.livekit.participantIdentity,
    })

    await expect(next).resolves.toMatchObject({ sessionId: command.sessionId })
    await Promise.resolve()
    expect(
      harness.request.mock.calls.filter(
        ([candidate]) => candidate.type === 'connectMicrophone',
      ),
    ).toHaveLength(2)
  })

  it('ignores stale generation-scoped runtime errors', async () => {
    const harness = createHarness()
    const session = await harness.controller.startSession(microphoneOptions())
    const connect = harness.request.mock.calls.find(
      ([command]) => command.type === 'connectMicrophone',
    )?.[0]
    const listener = vi.fn()
    harness.controller.subscribe(listener)

    harness.event({
      type: 'runtimeError',
      sequence: 1,
      error: {
        code: 'candidate_failed',
        message: 'stale candidate failed',
        retryable: true,
        sessionId: session.sessionId,
        generation: connect.generation - 1,
      },
    })

    expect(listener).not.toHaveBeenCalled()
    expect(harness.controller.getState().engine.lastError).toBeNull()
  })

  it('routes preview metrics and terminates a failed preview once', async () => {
    const harness = createHarness()
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'startPreview') {
        return { sessionId: command.sessionId }
      }
      return undefined
    })
    const listener = vi.fn()
    harness.controller.subscribe(listener)
    const preview = await harness.controller.startMicrophonePreview(previewOptions())
    const start = harness.request.mock.calls.find(
      ([command]) => command.type === 'startPreview',
    )?.[0]

    harness.event({
      type: 'microphoneMetrics',
      sequence: 1,
      sessionId: preview.sessionId,
      generation: start.generation,
      metrics: {
        sessionId: preview.sessionId,
        inputDb: -20,
        thresholdDb: -45,
        open: true,
      },
    })
    expect(listener).toHaveBeenCalledWith({
      type: 'microphoneMetrics',
      event: {
        sessionId: preview.sessionId,
        inputDb: -20,
        thresholdDb: -45,
        open: true,
      },
    })

    harness.event({
      type: 'runtimeError',
      sequence: 2,
      error: {
        code: 'microphone_preview_failed',
        message: 'capture failed',
        stage: 'preview',
        retryable: true,
        sessionId: preview.sessionId,
        generation: start.generation,
      },
    })
    harness.event({
      type: 'sessionStopped',
      sequence: 3,
      sessionId: preview.sessionId,
      generation: start.generation,
      reason: 'runtime_error',
    })
    expect(listener).toHaveBeenCalledWith({
      type: 'streamError',
      event: { sessionId: preview.sessionId, message: 'capture failed' },
    })
    expect(listener.mock.calls).toContainEqual([
      { type: 'streamEnded', sessionId: preview.sessionId },
    ])
    expect(
      listener.mock.calls.filter(
        ([event]) => event.type === 'streamEnded' && event.sessionId === preview.sessionId,
      ),
    ).toHaveLength(1)
  })

  it('stops the previous running preview before replacing it', async () => {
    const harness = createHarness()
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'startPreview') {
        return { sessionId: command.sessionId }
      }
      return undefined
    })

    const first = await harness.controller.startMicrophonePreview(previewOptions())
    harness.request.mockClear()

    const second = await harness.controller.startMicrophonePreview({
      ...previewOptions(),
      inputVolume: 0.5,
    })

    const stop = harness.request.mock.calls.find(
      ([command]) => command.type === 'stopPreview',
    )?.[0]
    const start = harness.request.mock.calls.find(
      ([command]) => command.type === 'startPreview',
    )?.[0]

    expect(stop.sessionId).toBe(first.sessionId)
    expect(stop.generation).toBeLessThan(start.generation)
    expect(second.sessionId).toBe(start.sessionId)
  })

  it('cancels a stale preview start when stop wins the race', async () => {
    const harness = createHarness()
    let resolveStart!: (value: unknown) => void
    const startResult = new Promise((resolve) => {
      resolveStart = resolve
    })
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'startPreview') {
        return startResult
      }
      return undefined
    })

    const start = harness.controller.startMicrophonePreview(previewOptions())
    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.some(
          ([command]) => command.type === 'startPreview',
        ),
      ).toBe(true),
    )
    const pendingStart = harness.request.mock.calls.find(
      ([command]) => command.type === 'startPreview',
    )?.[0]

    await harness.controller.stopMicrophonePreview()
    resolveStart({ sessionId: pendingStart.sessionId })

    await expect(start).rejects.toThrow('cancelled')
    expect(harness.request.mock.calls).toContainEqual([
      {
        type: 'stopPreview',
        sessionId: pendingStart.sessionId,
        generation: pendingStart.generation,
      },
      expect.any(Number),
    ])
  })

  it('releases preview ownership when native preview startup fails', async () => {
    const harness = createHarness()
    harness.request.mockRejectedValueOnce(new Error('preview startup failed'))

    await expect(
      harness.controller.startMicrophonePreview(previewOptions()),
    ).rejects.toThrow('preview startup failed')
    harness.request.mockClear()

    await harness.controller.stopMicrophonePreview()
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('restores the current running preview after runtime recovery with the same session id', async () => {
    const harness = createHarness()
    harness.request.mockImplementation(async (command: any) => {
      if (command.type === 'startPreview') {
        return { sessionId: command.sessionId }
      }
      return undefined
    })

    const preview = await harness.controller.startMicrophonePreview(previewOptions())
    const initialStart = harness.request.mock.calls.find(
      ([command]) => command.type === 'startPreview',
    )?.[0]

    harness.state({ status: 'recovering', restartCount: 1, lastFailure: 'crash' })
    harness.state({ status: 'ready', restartCount: 1 })
    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(
          ([command]) => command.type === 'startPreview',
        ),
      ).toHaveLength(2),
    )

    const restoredStart = harness.request.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'startPreview')
      .at(-1)

    expect(restoredStart.sessionId).toBe(preview.sessionId)
    expect(restoredStart.generation).toBeGreaterThan(initialStart.generation)
  })

  it('accepts only nested sequenced native events', () => {
    expect(
      isNativeRuntimeEvent({
        type: 'microphoneMetrics',
        sequence: 1,
        sessionId: 'mic-1',
        generation: 0,
        metrics: {
          sessionId: 'mic-1',
          inputDb: -20,
          thresholdDb: -45,
          open: true,
        },
      }),
    ).toBe(true)
    expect(
      isNativeRuntimeEvent({
        type: 'microphoneMetrics',
        sequence: 1,
        sessionId: 'mic-1',
        generation: 0,
        inputDb: -20,
      }),
    ).toBe(false)
  })
})
