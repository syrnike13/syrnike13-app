import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import {
  createInitialVoiceMediaDesiredState,
  type VoiceLease,
} from '@syrnike13/platform'

import type {
  NativeRuntimeCommand,
  NativeRuntimeEvent,
} from '../native-runtime/contract'
import type {
  NativeRuntimeRequestOptions,
  NativeRuntimeGenerationLane,
  NativeRuntimeSupervisorSnapshot,
} from '../native-runtime/runtime-supervisor'
import type { DiagnosticLogRecord } from '../native-runtime/diagnostic-log'
import { createMediaIncidentTimeline } from '../native-video/media-incident-timeline'
import {
  NativeRtcEngineAdapter,
  type NativeVoiceRuntime,
} from './native-rtc-engine-adapter'

class FakeRuntime implements NativeVoiceRuntime {
  readonly commands: NativeRuntimeCommand[] = []
  readonly timeouts: Array<{
    command: NativeRuntimeCommand
    timeoutMs: number
  }> = []
  readonly diagnostics: Array<NativeRuntimeRequestOptions['diagnostic']> = []
  private readonly eventListeners = new Set<(event: NativeRuntimeEvent) => void>()
  private readonly stateListeners = new Set<
    (snapshot: NativeRuntimeSupervisorSnapshot) => void
  >()
  private readonly generationSequences: Record<
    NativeRuntimeGenerationLane,
    number
  > = {
    voice: 0,
    microphone: 0,
    screen: 0,
    camera: 0,
  }
  private microphoneConfigRevision = 0

  constructor(
    private readonly onRequest?: (
      command: NativeRuntimeCommand,
    ) => Promise<unknown> | undefined,
  ) {}

  async request(
    command: NativeRuntimeCommand,
    timeoutMs: number,
    options: NativeRuntimeRequestOptions = {},
  ): Promise<unknown> {
    this.commands.push(command)
    this.timeouts.push({ command, timeoutMs })
    this.diagnostics.push(options.diagnostic)
    await this.onRequest?.(command)
    return undefined
  }

  requestEffect(
    command: NativeRuntimeCommand,
    timeoutMs: number,
    options: NativeRuntimeRequestOptions = {},
  ) {
    return Effect.tryPromise({
      try: () => this.request(command, timeoutMs, options),
      catch: (cause) => cause,
    })
  }

  allocateGeneration(lane: NativeRuntimeGenerationLane) {
    return ++this.generationSequences[lane]
  }

  allocateMicrophoneConfigRevision() {
    return ++this.microphoneConfigRevision
  }

  onEvent(listener: (event: NativeRuntimeEvent) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: (snapshot: NativeRuntimeSupervisorSnapshot) => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  emitEvent(event: NativeRuntimeEvent) {
    for (const listener of this.eventListeners) listener(event)
  }

  emitState(snapshot: NativeRuntimeSupervisorSnapshot) {
    for (const listener of this.stateListeners) listener(snapshot)
  }
}

const lease: VoiceLease = {
  channelId: 'channel-a',
  rtcEngine: 'windows_native',
  clientInstanceId: 'desktop-a',
  operationId: 'op-a',
  connectionEpoch: 'epoch-a',
  authorityVersion: 1,
  credential: {
    url: 'wss://voice.invalid',
    token: 'token',
    participantIdentity: 'participant',
  },
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Condition was not reached')
}

function commandGenerationLane(
  command: NativeRuntimeCommand,
): NativeRuntimeGenerationLane | undefined {
  switch (command.type) {
    case 'connectVoice':
    case 'disconnectVoice':
    case 'configureRemoteAudio':
    case 'configureVoiceOutput':
      return 'voice'
    case 'warmMicrophone':
    case 'connectMicrophone':
    case 'disconnectMicrophone':
    case 'invalidateMicrophone':
    case 'setMicrophoneMuted':
      return 'microphone'
    case 'connectScreen':
    case 'startScreenCapture':
    case 'stopScreenCapture':
    case 'disconnectScreen':
      return 'screen'
    case 'connectCamera':
    case 'disconnectCamera':
      return 'camera'
    default:
      return undefined
  }
}

describe('NativeRtcEngineAdapter', () => {
  it('connects one voice Room before starting a non-blocking microphone track', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime, () => 42)
    const desired = createInitialVoiceMediaDesiredState()

    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )

    const commandTypes = runtime.commands.map((command) => command.type)
    expect(commandTypes[0]).toBe('connectVoice')
    expect(commandTypes.indexOf('warmMicrophone')).toBeGreaterThan(0)
    expect(commandTypes.indexOf('connectMicrophone')).toBeGreaterThan(
      commandTypes.indexOf('warmMicrophone'),
    )
    expect(
      runtime.commands.find((command) => command.type === 'warmMicrophone'),
    ).toMatchObject({
      config: {
        bypassSystemAudioInputProcessing: true,
        automaticGainControl: true,
      },
    })
    const microphone = runtime.commands.find(
      (command) => command.type === 'connectMicrophone',
    )
    expect(microphone).toMatchObject({
      sessionId: 'epoch-a',
      excludeProcessId: 42,
      options: {
        participantIdentity: lease.credential.participantIdentity,
        muted: true,
      },
    })
    const voiceIndex = runtime.commands.findIndex(
      (command) => command.type === 'connectVoice',
    )
    const microphoneIndex = runtime.commands.findIndex(
      (command) => command.type === 'connectMicrophone',
    )
    expect(runtime.diagnostics[voiceIndex]).toMatchObject({
      actionId: expect.stringMatching(/^media-action-/),
      operationId: 'op-a',
      revision: 0,
    })
    expect(runtime.diagnostics[microphoneIndex]).toMatchObject({
      actionId: expect.stringMatching(/^media-action-/),
      operationId: 'op-a',
      revision: 1,
    })
    adapter.dispose()
  })

  it('keeps one warmed microphone pipeline across Room moves', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const desired = createInitialVoiceMediaDesiredState()
    adapter.updateDesiredMedia(desired)
    await adapter.prewarmMicrophone()

    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )
    await adapter.disconnect('move')

    const nextLease: VoiceLease = {
      ...lease,
      channelId: 'channel-b',
      operationId: 'op-b',
      connectionEpoch: 'epoch-b',
      authorityVersion: 2,
    }
    await adapter.connect(nextLease, desired, new AbortController().signal)
    await waitUntil(
      () =>
        runtime.commands.filter(
          (command) => command.type === 'connectMicrophone',
        ).length === 2,
    )

    expect(
      runtime.commands.filter((command) => command.type === 'warmMicrophone'),
    ).toHaveLength(1)
    adapter.dispose()
  })

  it('keeps generations and microphone config revisions monotonic across adapter recreation', async () => {
    const runtime = new FakeRuntime()
    const firstAdapter = new NativeRtcEngineAdapter(runtime)
    const firstDesired = {
      ...createInitialVoiceMediaDesiredState(),
      microphoneDeviceId: 'microphone-a',
      screenEnabled: true,
      screenSourceId: 'screen-a',
      cameraEnabled: true,
      cameraDeviceId: 'camera-a',
    }
    firstAdapter.updateDesiredMedia(firstDesired)
    await firstAdapter.prewarmMicrophone()
    const reconfiguredDesired = {
      ...firstDesired,
      microphoneDeviceId: 'microphone-b',
    }
    firstAdapter.updateDesiredMedia(reconfiguredDesired)
    await waitUntil(() =>
      runtime.commands.filter((command) => command.type === 'configureMicrophone')
        .length === 2,
    )
    await firstAdapter.connect(
      lease,
      reconfiguredDesired,
      new AbortController().signal,
    )
    await waitUntil(() =>
      ['connectMicrophone', 'connectScreen', 'connectCamera'].every((type) =>
        runtime.commands.some((command) => command.type === type),
      ),
    )
    await firstAdapter.disconnect('logout')
    firstAdapter.dispose()

    const firstCommands = [...runtime.commands]
    const maxFirstGeneration = (lane: NativeRuntimeGenerationLane) =>
      Math.max(...firstCommands
        .filter((command) => commandGenerationLane(command) === lane)
        .map((command) => 'generation' in command ? command.generation : 0))
    const maxFirstConfigRevision = Math.max(...firstCommands
      .filter((command) => command.type === 'configureMicrophone')
      .map((command) => command.revision))

    const secondAdapter = new NativeRtcEngineAdapter(runtime)
    const secondLease = {
      ...lease,
      operationId: 'op-b',
      connectionEpoch: 'epoch-b',
      authorityVersion: 2,
    }
    const secondDesired = {
      ...reconfiguredDesired,
      microphoneDeviceId: 'microphone-c',
      screenSourceId: 'screen-b',
      cameraDeviceId: 'camera-b',
    }
    await secondAdapter.connect(
      secondLease,
      secondDesired,
      new AbortController().signal,
    )
    await waitUntil(() =>
      ['connectMicrophone', 'connectScreen', 'connectCamera'].every((type) =>
        runtime.commands.some((command) =>
          command.type === type &&
          'sessionId' in command &&
          command.sessionId === secondLease.connectionEpoch),
      ),
    )

    const secondConnect = (type: NativeRuntimeCommand['type']) => {
      const command = runtime.commands.find((candidate) =>
        candidate.type === type &&
        'sessionId' in candidate &&
        candidate.sessionId === secondLease.connectionEpoch)
      if (!command || !('generation' in command)) {
        throw new Error(`Missing ${type} command for recreated adapter`)
      }
      return command.generation
    }
    expect(secondConnect('connectVoice')).toBeGreaterThan(
      maxFirstGeneration('voice'),
    )
    expect(secondConnect('connectMicrophone')).toBeGreaterThan(
      maxFirstGeneration('microphone'),
    )
    expect(secondConnect('connectScreen')).toBeGreaterThan(
      maxFirstGeneration('screen'),
    )
    expect(secondConnect('connectCamera')).toBeGreaterThan(
      maxFirstGeneration('camera'),
    )
    const secondConfig = runtime.commands.filter(
      (command) => command.type === 'configureMicrophone',
    ).at(-1)
    expect(secondConfig).toMatchObject({
      type: 'configureMicrophone',
      revision: expect.any(Number),
    })
    expect(
      secondConfig?.type === 'configureMicrophone'
        ? secondConfig.revision
        : 0,
    ).toBeGreaterThan(maxFirstConfigRevision)

    await secondAdapter.disconnect('logout')
    secondAdapter.dispose()
  })

  it('does not reconcile an identical desired media snapshot twice', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      screenEnabled: true,
      screenSourceId: 'screen-a',
    }

    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'startScreenCapture'),
    )
    const startsBefore = runtime.commands.filter(
      (command) => command.type === 'startScreenCapture',
    ).length

    adapter.updateDesiredMedia({ ...desired })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runtime.commands.filter(
      (command) => command.type === 'startScreenCapture',
    )).toHaveLength(startsBefore)
    adapter.dispose()
  })

  it('waits for RTC reconnection before starting a requested screen share', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = createInitialVoiceMediaDesiredState()
    await adapter.connect(lease, desired, new AbortController().signal)

    runtime.emitEvent({
      type: 'voiceConnectionState',
      sequence: 1,
      sessionId: lease.connectionEpoch,
      generation: 1,
      state: 'reconnecting',
    })
    adapter.updateDesiredMedia({
      ...desired,
      screenEnabled: true,
      screenSourceId: 'screen-a',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runtime.commands.some(
      (command) => command.type === 'connectScreen',
    )).toBe(false)

    runtime.emitEvent({
      type: 'voiceConnectionState',
      sequence: 2,
      sessionId: lease.connectionEpoch,
      generation: 1,
      state: 'connected',
    })
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectScreen'),
    )

    expect(events).toContainEqual(expect.objectContaining({
      type: 'transientReconnectStarted',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'transientReconnectSucceeded',
    }))
    adapter.dispose()
  })

  it('retries a transient screen startup failure only after its backoff', async () => {
    let screenStarts = 0
    const runtime = new FakeRuntime(async (command) => {
      if (command.type !== 'startScreenCapture') return
      screenStarts += 1
      if (screenStarts === 1) throw new Error('transient GPU startup failure')
    })
    const adapter = new NativeRtcEngineAdapter(
      runtime,
      () => 42,
      { screenRetryDelaysMs: [30], screenRuntimeSettleDelayMs: 0 },
    )
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      screenEnabled: true,
      screenSourceId: 'screen-a',
    }

    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() => screenStarts === 1)
    adapter.updateDesiredMedia({ ...desired })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screenStarts).toBe(1)

    await waitUntil(() => screenStarts === 2)
    adapter.dispose()
  })

  it('lets the capture stack settle after a utility runtime restart', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(
      runtime,
      () => 42,
      { screenRuntimeSettleDelayMs: 30 },
    )
    const desired = createInitialVoiceMediaDesiredState()
    await adapter.connect(lease, desired, new AbortController().signal)

    runtime.emitState({
      runtime: 'media',
      status: 'recovering',
      restartCount: 1,
      hostEpoch: 2,
    })
    runtime.emitState({
      runtime: 'media',
      status: 'ready',
      restartCount: 1,
      hostEpoch: 2,
    })
    adapter.updateDesiredMedia({
      ...desired,
      screenEnabled: true,
      screenSourceId: 'screen-a',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runtime.commands.some(
      (command) => command.type === 'connectScreen',
    )).toBe(false)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectScreen'),
    )
    adapter.dispose()
  })

  it('does not enqueue mute behind an unfinished microphone publication', async () => {
    let releasePublication!: () => void
    const publicationPending = new Promise<void>((resolve) => {
      releasePublication = resolve
    })
    const runtime = new FakeRuntime((command) =>
      command.type === 'connectMicrophone' ? publicationPending : undefined,
    )
    const adapter = new NativeRtcEngineAdapter(runtime)
    const desired = createInitialVoiceMediaDesiredState()

    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )
    adapter.updateDesiredMedia({
      ...desired,
      userMuted: false,
      effectiveMuted: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(
      runtime.commands.filter((command) => command.type === 'setMicrophoneMuted'),
    ).toHaveLength(0)

    releasePublication()
    await waitUntil(() =>
      runtime.commands.some(
        (command) =>
          command.type === 'setMicrophoneMuted' && command.muted === false,
      ),
    )
    adapter.dispose()
  })

  it('does not start tracks before the shared voice Room is ready', async () => {
    let releaseVoice!: () => void
    const voicePending = new Promise<void>((resolve) => {
      releaseVoice = resolve
    })
    const runtime = new FakeRuntime((command) =>
      command.type === 'connectVoice' ? voicePending : undefined,
    )
    const adapter = new NativeRtcEngineAdapter(runtime)
    const desired = createInitialVoiceMediaDesiredState()
    const connecting = adapter.connect(
      lease,
      desired,
      new AbortController().signal,
    )
    await waitUntil(() => runtime.commands[0]?.type === 'connectVoice')

    adapter.updateDesiredMedia({
      ...desired,
      cameraEnabled: true,
      screenEnabled: true,
      screenSourceId: 'screen-a',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(
      runtime.commands.some((command) =>
        ['warmMicrophone', 'connectMicrophone', 'connectCamera', 'connectScreen'].includes(
          command.type,
        ),
      ),
    ).toBe(false)

    releaseVoice()
    await connecting
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )
    adapter.dispose()
  })

  it('applies mute as desired media without reconnecting voice', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const desired = createInitialVoiceMediaDesiredState()
    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )
    const voiceConnects = runtime.commands.filter(
      (command) => command.type === 'connectVoice',
    ).length

    adapter.updateDesiredMedia({
      ...desired,
      userMuted: false,
      effectiveMuted: false,
    })
    await waitUntil(() =>
      runtime.commands.some(
        (command) =>
          command.type === 'setMicrophoneMuted' && command.muted === false,
      ),
    )
    expect(
      runtime.commands.filter((command) => command.type === 'connectVoice'),
    ).toHaveLength(voiceConnects)
    adapter.dispose()
  })

  it('keeps the Room connected when remote output settings fail', async () => {
    const runtime = new FakeRuntime((command) => {
      if (command.type === 'configureRemoteAudio') {
        return Promise.reject(new Error('output device unavailable'))
      }
      return undefined
    })
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    adapter.updateRemoteAudioSettings({
      revision: 1,
      userVolumes: {},
      userMutes: {},
      streamVolumes: {},
      streamMutes: {},
    })

    await expect(
      adapter.connect(
        lease,
        createInitialVoiceMediaDesiredState(),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()

    expect(runtime.commands.some((command) => command.type === 'connectVoice')).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'output',
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
      media: expect.objectContaining({ state: 'failed' }),
    }))
    adapter.dispose()
  })

  it('reports a voice terminal event with exact operation and epoch', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )
    runtime.emitEvent({
      type: 'voiceTerminal',
      sequence: 1,
      sessionId: 'epoch-a',
      generation: 1,
      error: {
        code: 'rtc_terminal',
        message: 'network lost',
        retryable: true,
        sessionId: 'epoch-a',
        generation: 1,
      },
    })

    expect(events).toContainEqual({
      type: 'terminalFailure',
      operationId: 'op-a',
      connectionEpoch: 'epoch-a',
      failure: {
        code: 'rtc_terminal',
        message: 'network lost',
        retryable: true,
        stage: undefined,
      },
    })
    adapter.dispose()
  })

  it('preserves supervisor retryability when native voice connect fails', async () => {
    const runtime = new FakeRuntime((command) => {
      if (command.type !== 'connectVoice') return undefined
      return Promise.reject(Object.assign(new Error('native runtime degraded'), {
        detail: {
          code: 'runtime_degraded',
          message: 'native runtime degraded',
          retryable: false,
          stage: 'connectVoice',
          hresult: -2_147_024_895,
        },
      }))
    })
    const adapter = new NativeRtcEngineAdapter(runtime)

    await expect(adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )).rejects.toMatchObject({
      failure: {
        code: 'runtime_degraded',
        retryable: false,
        stage: 'connectVoice',
        hresult: -2_147_024_895,
      },
    })
    adapter.dispose()
  })

  it('emits one Runtime Loss per causal host epoch', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'configureMicrophone'),
    )
    expect(
      (
        adapter as unknown as {
          microphoneAppliedConfigRevision: number
        }
      ).microphoneAppliedConfigRevision,
    ).toBeGreaterThan(0)

    const recovering: NativeRuntimeSupervisorSnapshot = {
      runtime: 'media',
      status: 'recovering',
      restartCount: 1,
      hostEpoch: 7,
      failure: {
        cause: 'process_exit',
        message: 'utility exited',
        retryable: true,
      },
      lastFailure: 'utility exited',
    }
    runtime.emitState(recovering)
    runtime.emitState(recovering)

    expect(
      (
        adapter as unknown as {
          microphoneAppliedConfigRevision: number
        }
      ).microphoneAppliedConfigRevision,
    ).toBe(0)
    expect(events.filter((event) =>
      typeof event === 'object' && event !== null &&
      'type' in event && event.type === 'terminalFailure')).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'availabilityChanged',
      available: false,
      retryable: true,
    }))
    adapter.dispose()
  })

  it('turns a current native screen terminal event into an isolated media failure', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      screenEnabled: true,
      screenSourceId: 'window:42',
      screenAudioEnabled: true,
    }
    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'startScreenCapture'),
    )
    const start = runtime.commands.find(
      (command) => command.type === 'startScreenCapture',
    )
    if (!start || start.type !== 'startScreenCapture') {
      throw new Error('screen start command was not emitted')
    }

    runtime.emitEvent({
      type: 'screenCaptureEnded',
      sequence: 10,
      sessionId: lease.connectionEpoch,
      generation: start.generation,
      reason: 'gpu_encoder_unavailable',
      message: 'No compatible H.264 hardware encoder is available',
    })

    expect(events).toContainEqual({
      type: 'mediaState',
      kind: 'screen',
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
      media: {
        state: 'failed',
        error: {
          code: 'screen_gpu_encoder_unavailable',
          message: 'No compatible H.264 hardware encoder is available',
          retryable: true,
          stage: 'screen_capture',
        },
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'mediaState',
        kind: 'screen_audio',
        media: expect.objectContaining({ state: 'failed' }),
      }),
    )

    runtime.emitEvent({
      type: 'screenCaptureEnded',
      sequence: 11,
      sessionId: lease.connectionEpoch,
      generation: start.generation,
      reason: 'runtime_error',
      message: 'stale duplicate',
    })
    expect(
      events.filter(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'mediaState' &&
          'kind' in event &&
          event.kind === 'screen' &&
          'media' in event &&
          typeof event.media === 'object' &&
          event.media !== null &&
          'state' in event.media &&
          event.media.state === 'failed',
      ),
    ).toHaveLength(1)
    adapter.dispose()
  })

  it('retries failed screen audio without republishing healthy screen video', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime, undefined, {
      screenRetryDelaysMs: [0],
    })
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      screenEnabled: true,
      screenSourceId: 'window:audio-retry',
      screenAudioEnabled: true,
    }
    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'startScreenCapture'),
    )
    const firstStart = runtime.commands.find(
      (command) => command.type === 'startScreenCapture',
    )
    if (!firstStart || firstStart.type !== 'startScreenCapture') {
      throw new Error('screen start command was not emitted')
    }
    const connectCount = runtime.commands.filter(
      (command) => command.type === 'connectScreen',
    ).length

    runtime.emitEvent({
      type: 'sessionLifecycle',
      sequence: 80,
      sessionId: lease.connectionEpoch,
      generation: firstStart.generation,
      kind: 'screen_audio',
      state: {
        status: 'error',
        sessionId: lease.connectionEpoch,
        message: 'The loopback endpoint was removed',
      },
      error: {
        code: 'audio_device_lost',
        message: 'The loopback endpoint was removed',
        retryable: true,
        sessionId: lease.connectionEpoch,
        generation: firstStart.generation,
      },
    })

    await waitUntil(() =>
      runtime.commands.filter(
        (command) => command.type === 'startScreenCapture',
      ).length >= 2,
    )
    const starts = runtime.commands.filter(
      (command) => command.type === 'startScreenCapture',
    )
    expect(starts.at(-1)?.generation).toBe(firstStart.generation)
    expect(runtime.commands.filter(
      (command) => command.type === 'connectScreen',
    )).toHaveLength(connectCount)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'screen_audio',
      media: expect.objectContaining({
        state: 'failed',
        error: expect.objectContaining({ code: 'audio_device_lost' }),
      }),
    }))
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'screen',
      media: expect.objectContaining({ state: 'failed' }),
    }))

    runtime.emitEvent({
      type: 'sessionLifecycle',
      sequence: 81,
      sessionId: lease.connectionEpoch,
      generation: firstStart.generation,
      kind: 'screen_audio',
      state: {
        status: 'running',
        sessionId: lease.connectionEpoch,
      },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'screen_audio',
      media: { state: 'running' },
    }))
    adapter.dispose()
  })

  it('republishes only the microphone across repeated server mute cycles', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      userMuted: false,
      effectiveMuted: false,
      cameraEnabled: true,
      cameraDeviceId: 'camera-server-mute',
      screenEnabled: true,
      screenSourceId: 'screen:server-mute-demo',
      screenAudioEnabled: true,
    }
    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(
      () =>
        runtime.commands.some(
          (command) => command.type === 'connectMicrophone',
        ) &&
        runtime.commands.some(
          (command) => command.type === 'connectCamera',
        ) &&
        runtime.commands.some(
          (command) => command.type === 'startScreenCapture',
        ),
    )
    const firstMicrophone = runtime.commands.find(
      (command) => command.type === 'connectMicrophone',
    )
    if (!firstMicrophone || firstMicrophone.type !== 'connectMicrophone') {
      throw new Error('Initial microphone command was not recorded')
    }

    const firstCamera = runtime.commands.find(
      (command) => command.type === 'connectCamera',
    )
    const firstScreen = runtime.commands.find(
      (command) => command.type === 'startScreenCapture',
    )
    if (!firstCamera || firstCamera.type !== 'connectCamera') {
      throw new Error('Initial camera command was not recorded')
    }
    if (!firstScreen || firstScreen.type !== 'startScreenCapture') {
      throw new Error('Initial screen command was not recorded')
    }
    expect(firstScreen.options.audio).toEqual({ requested: true })

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const microphone = runtime.commands.filter(
        (command) => command.type === 'connectMicrophone',
      ).at(-1)
      if (!microphone || microphone.type !== 'connectMicrophone') {
        throw new Error(`Microphone publication ${cycle} was not recorded`)
      }
      adapter.updateDesiredMedia({
        ...desired,
        serverMuted: true,
        effectiveMuted: true,
      })
      await waitUntil(
        () =>
          runtime.commands.filter(
            (command) =>
              command.type === 'setMicrophoneMuted' && command.muted,
          ).length === cycle + 1,
      )

      runtime.emitEvent({
        type: 'localMicrophoneUnpublished',
        sessionId: lease.connectionEpoch,
        generation: microphone.generation,
        trackId: `TR_MIC_${cycle + 1}`,
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(
        runtime.commands.filter(
          (command) => command.type === 'connectMicrophone',
        ),
      ).toHaveLength(cycle + 1)

      adapter.updateDesiredMedia({
        ...desired,
        serverMuted: false,
        effectiveMuted: false,
      })
      await waitUntil(
        () =>
          runtime.commands.filter(
            (command) => command.type === 'connectMicrophone',
          ).length === cycle + 2,
      )
    }

    const microphonePublications = runtime.commands.filter(
      (command) => command.type === 'connectMicrophone',
    )
    expect(microphonePublications).toHaveLength(4)
    for (let index = 1; index < microphonePublications.length; index += 1) {
      expect(microphonePublications[index]).toMatchObject({
        sessionId: lease.connectionEpoch,
        options: { muted: false },
      })
      expect(microphonePublications[index]?.generation).toBeGreaterThan(
        microphonePublications[index - 1]?.generation ?? 0,
      )
    }
    expect(
      runtime.commands.filter((command) => command.type === 'connectVoice'),
    ).toHaveLength(1)
    expect(
      runtime.commands.filter((command) => command.type === 'connectCamera'),
    ).toEqual([firstCamera])
    expect(
      runtime.commands.filter((command) => command.type === 'disconnectCamera'),
    ).toHaveLength(0)
    expect(
      runtime.commands.filter((command) => command.type === 'connectScreen'),
    ).toHaveLength(1)
    expect(
      runtime.commands.filter(
        (command) => command.type === 'startScreenCapture',
      ),
    ).toEqual([firstScreen])
    expect(
      runtime.commands.filter((command) => command.type === 'disconnectScreen'),
    ).toHaveLength(0)

    runtime.emitEvent({
      type: 'voiceConnectionState',
      sequence: 20,
      sessionId: lease.connectionEpoch,
      generation: 1,
      state: 'reconnecting',
    })
    runtime.emitEvent({
      type: 'voiceConnectionState',
      sequence: 21,
      sessionId: lease.connectionEpoch,
      generation: 1,
      state: 'connected',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      runtime.commands.filter((command) => command.type === 'connectVoice'),
    ).toHaveLength(1)
    expect(
      runtime.commands.filter((command) => command.type === 'connectCamera'),
    ).toEqual([firstCamera])
    expect(
      runtime.commands.filter((command) => command.type === 'disconnectCamera'),
    ).toHaveLength(0)
    expect(
      runtime.commands.filter((command) => command.type === 'connectScreen'),
    ).toHaveLength(1)
    expect(
      runtime.commands.filter(
        (command) => command.type === 'startScreenCapture',
      ),
    ).toEqual([firstScreen])
    expect(
      runtime.commands.filter((command) => command.type === 'disconnectScreen'),
    ).toHaveLength(0)
    adapter.dispose()
  })

  it('republishes screen capture after a typed pipeline stall', async () => {
    const runtime = new FakeRuntime()
    const diagnostics = vi.fn()
    const adapter = new NativeRtcEngineAdapter(
      runtime,
      () => 42,
      {
        screenRetryDelaysMs: [10],
        screenRuntimeSettleDelayMs: 0,
        diagnostics,
      },
    )
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(lease, {
      ...createInitialVoiceMediaDesiredState(),
      screenEnabled: true,
      screenSourceId: 'screen:1',
    }, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.filter(
        (command) => command.type === 'startScreenCapture',
      ).length === 1,
    )
    const firstStart = runtime.commands.find(
      (command) => command.type === 'startScreenCapture',
    )
    if (!firstStart || firstStart.type !== 'startScreenCapture') {
      throw new Error('screen start command was not emitted')
    }

    runtime.emitEvent({
      type: 'screenCaptureEnded',
      sequence: 10,
      sessionId: lease.connectionEpoch,
      generation: firstStart.generation,
      reason: 'encoder_output_stalled',
      message: 'Screen encoder stopped producing output',
    })

    await waitUntil(() =>
      runtime.commands.filter(
        (command) => command.type === 'startScreenCapture',
      ).length === 2,
    )
    const starts = runtime.commands.filter(
      (command) => command.type === 'startScreenCapture',
    )
    expect(starts[1]).toMatchObject({
      type: 'startScreenCapture',
      sessionId: lease.connectionEpoch,
      options: { sourceId: 'screen:1' },
    })
    expect(starts[1]?.generation).not.toBe(firstStart.generation)
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      event: 'screen_pipeline_stalled',
      reason: 'encoder_output_stalled',
      errorCode: 'screen_encoder_output_stalled',
      generation: firstStart.generation,
    }))
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      event: 'screen_republished',
      outcome: 'success',
      generation: starts[1]?.generation,
      recoveryAttempt: 1,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'screen',
      media: {
        state: 'failed',
        error: expect.objectContaining({
          code: 'screen_encoder_output_stalled',
          retryable: true,
        }),
      },
    }))
    adapter.dispose()
  })

  it('keeps a terminal GPU permission failure non-retryable in the desktop layer', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(lease, {
      ...createInitialVoiceMediaDesiredState(),
      screenEnabled: true,
      screenSourceId: 'screen:1',
    }, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'startScreenCapture'),
    )
    const start = runtime.commands.find(
      (command) => command.type === 'startScreenCapture',
    )
    if (!start || start.type !== 'startScreenCapture') {
      throw new Error('screen start command was not emitted')
    }

    runtime.emitEvent({
      type: 'screenCaptureEnded',
      sequence: 12,
      sessionId: lease.connectionEpoch,
      generation: start.generation,
      reason: 'gpu_permission_denied',
      message: 'Screen capture permission is denied',
    })

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'screen',
      media: {
        state: 'failed',
        error: expect.objectContaining({
          code: 'screen_gpu_permission_denied',
          retryable: false,
        }),
      },
    }))
    adapter.dispose()
  })

  it('preserves a typed hardware error when native screen startup is rejected', async () => {
    const runtime = new FakeRuntime((command) => {
      if (command.type !== 'startScreenCapture') return undefined
      const error = new Error('gpu_encoder_unavailable') as Error & {
        detail: { code: string; message: string; retryable: boolean }
      }
      error.detail = {
        code: 'gpu_encoder_unavailable',
        message: 'No compatible encoder',
        retryable: true,
      }
      return Promise.reject(error)
    })
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      screenEnabled: true,
      screenSourceId: 'screen:1',
    }

    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() => events.some((event) =>
      typeof event === 'object' && event !== null &&
      'kind' in event && event.kind === 'screen' &&
      'media' in event && typeof event.media === 'object' && event.media !== null &&
      'state' in event.media && event.media.state === 'failed'))

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'screen',
      media: {
        state: 'failed',
        error: expect.objectContaining({
          code: 'screen_gpu_encoder_unavailable',
        }),
      },
    }))
    adapter.dispose()
  })

  it('reports a closed screen target as a non-retryable startup failure', async () => {
    const runtime = new FakeRuntime((command) => {
      if (command.type !== 'startScreenCapture') return undefined
      const error = new Error('target_closed') as Error & {
        detail: { code: string; message: string; retryable: boolean }
      }
      error.detail = {
        code: 'target_closed',
        message: 'Target closed',
        retryable: false,
      }
      return Promise.reject(error)
    })
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.connect(lease, {
      ...createInitialVoiceMediaDesiredState(),
      screenEnabled: true,
      screenSourceId: 'window:1234',
    }, new AbortController().signal)
    await waitUntil(() => events.some((event) =>
      typeof event === 'object' && event !== null &&
      'kind' in event && event.kind === 'screen' &&
      'media' in event && typeof event.media === 'object' && event.media !== null &&
      'state' in event.media && event.media.state === 'failed'))

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'screen',
      media: {
        state: 'failed',
        error: expect.objectContaining({
          code: 'screen_capture_target_closed',
          message: 'Источник демонстрации больше недоступен',
          retryable: false,
        }),
      },
    }))
    adapter.dispose()
  })

  it('ignores stale native events from an older generation of the same epoch', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    events.length = 0

    runtime.emitEvent({
      type: 'voiceTerminal',
      sequence: 1,
      sessionId: lease.connectionEpoch,
      generation: 0,
      error: {
        code: 'rtc_terminal',
        message: 'stale disconnect',
        retryable: true,
        sessionId: lease.connectionEpoch,
        generation: 0,
      },
    })
    runtime.emitEvent({
      type: 'activeSpeakers',
      sequence: 2,
      sessionId: lease.connectionEpoch,
      generation: 0,
      participantIdentities: ['stale-user'],
    })

    expect(events).toEqual([])
    adapter.dispose()
  })

  it.each([
    {
      kind: 'microphone' as const,
      code: 'audio_input_fallback_default',
      message: 'Selected audio input is unavailable; using system default',
      expectedMedia: { state: 'running' },
    },
    {
      kind: 'output' as const,
      code: 'audio_output_fallback_default',
      message: 'Selected audio output is unavailable; using system default',
      expectedMedia: {
        state: 'running',
        error: expect.objectContaining({ code: 'output_device_fallback' }),
      },
    },
  ])('keeps $kind running with the expected fallback projection', async ({
    kind,
    code,
    message,
    expectedMedia,
  }) => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )
    if (kind === 'microphone') {
      await waitUntil(() =>
        runtime.commands.some((command) => command.type === 'connectMicrophone'),
      )
    }
    const generation = runtime.commands.find((command) =>
      command.type === (kind === 'microphone' ? 'connectMicrophone' : 'connectVoice'),
    )?.generation
    expect(generation).toBeTypeOf('number')

    runtime.emitEvent({
      type: 'sessionLifecycle',
      sequence: 1,
      sessionId: lease.connectionEpoch,
      generation: generation!,
      kind,
      state: {
        status: 'running',
        sessionId: lease.connectionEpoch,
        deviceId: 'default',
        message,
      },
      error: {
        code,
        message,
        retryable: false,
        sessionId: lease.connectionEpoch,
        generation: generation!,
      },
    } as NativeRuntimeEvent)

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind,
      media: expectedMedia,
    }))
    adapter.dispose()
  })

  it('keeps the microphone generation while endpoint recovery is pending', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      userMuted: false,
      effectiveMuted: false,
    }
    await adapter.connect(
      lease,
      desired,
      new AbortController().signal,
    )
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )
    const generation = runtime.commands.find(
      (command) => command.type === 'connectMicrophone',
    )?.generation
    expect(generation).toBeTypeOf('number')
    const microphoneConfig = runtime.commands.find(
      (command) => command.type === 'configureMicrophone',
    )
    if (!microphoneConfig || microphoneConfig.type !== 'configureMicrophone') {
      throw new Error('Expected configureMicrophone command')
    }
    await waitUntil(() => events.some((event) =>
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'mediaState' &&
      'kind' in event &&
      event.kind === 'microphone' &&
      'media' in event &&
      typeof event.media === 'object' &&
      event.media !== null &&
      'state' in event.media &&
      event.media.state === 'running',
    ))

    runtime.emitEvent({
      type: 'microphoneMetrics',
      sequence: 1,
      metrics: {
        revision: microphoneConfig.revision,
        inputDb: -12,
        thresholdDb: -28,
        open: true,
      },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'speakingChanged',
      participantIdentities: [lease.credential.participantIdentity],
    }))

    runtime.emitEvent({
      type: 'sessionLifecycle',
      sequence: 2,
      sessionId: lease.connectionEpoch,
      generation: generation!,
      kind: 'microphone',
      state: {
        status: 'starting',
        sessionId: lease.connectionEpoch,
        message: 'Default endpoint is temporarily unavailable',
      },
      error: {
        code: 'audio_endpoint_invalidated',
        message: 'Default endpoint is temporarily unavailable',
        retryable: true,
        sessionId: lease.connectionEpoch,
        generation: generation!,
      },
    })
    runtime.emitEvent({
      type: 'sessionLifecycle',
      sequence: 3,
      sessionId: lease.connectionEpoch,
      generation: generation!,
      kind: 'microphone',
      state: {
        status: 'running',
        sessionId: lease.connectionEpoch,
        deviceId: 'default',
        message: 'audio_input_default_recovered',
      },
    })

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'microphone',
      media: expect.objectContaining({
        state: 'starting',
        error: expect.objectContaining({ code: 'audio_endpoint_invalidated' }),
      }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'speakingChanged',
      participantIdentities: [],
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'microphone',
      media: { state: 'running' },
    }))
    adapter.dispose()
  })

  it.each([
    'audio_output_default_recovered',
    'audio_output_recovered',
  ])('keeps the output generation while %s is pending', async (recoveryMessage) => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )
    const generation = runtime.commands.find(
      (command) => command.type === 'connectVoice',
    )?.generation
    expect(generation).toBeTypeOf('number')

    runtime.emitEvent({
      type: 'sessionLifecycle',
      sequence: 1,
      sessionId: lease.connectionEpoch,
      generation: generation!,
      kind: 'output',
      state: {
        status: 'starting',
        sessionId: lease.connectionEpoch,
        message: 'Default audio output is temporarily unavailable',
      },
      error: {
        code: 'audio_endpoint_invalidated',
        message: 'Default audio output is temporarily unavailable',
        retryable: true,
        sessionId: lease.connectionEpoch,
        generation: generation!,
      },
    })
    runtime.emitEvent({
      type: 'sessionLifecycle',
      sequence: 2,
      sessionId: lease.connectionEpoch,
      generation: generation!,
      kind: 'output',
      state: {
        status: 'running',
        sessionId: lease.connectionEpoch,
        deviceId: 'default',
        message: recoveryMessage,
      },
    })

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'output',
      media: expect.objectContaining({ state: 'starting' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'output',
      media: { state: 'running' },
    }))
    adapter.dispose()
  })

  it('keeps the previous output owned when a user device change rolls back', async () => {
    let outputRequests = 0
    const runtime = new FakeRuntime((command) => {
      if (command.type !== 'configureVoiceOutput') return undefined
      outputRequests += 1
      if (outputRequests !== 2) return undefined
      throw Object.assign(new Error('Output access was denied'), {
        detail: {
          code: 'audio_access_denied',
          message: 'Output access was denied',
          retryable: false,
          stage: 'configureVoiceOutput',
          hresult: -2_147_024_895,
        },
      })
    })
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = createInitialVoiceMediaDesiredState()
    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() => outputRequests === 1)

    adapter.updateDesiredMedia({
      ...desired,
      outputDeviceId: 'blocked-output',
      outputVolume: 0.5,
      userDeafened: true,
    })
    await waitUntil(() => outputRequests === 2)
    await waitUntil(() => events.some((event) =>
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'mediaState' &&
      'kind' in event &&
      event.kind === 'output' &&
      'media' in event &&
      typeof event.media === 'object' &&
      event.media !== null &&
      'error' in event.media &&
      typeof event.media.error === 'object' &&
      event.media.error !== null &&
      'code' in event.media.error &&
      event.media.error.code === 'audio_access_denied',
    ))

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'output',
      media: {
        state: 'running',
        error: expect.objectContaining({
          code: 'audio_access_denied',
          retryable: false,
        }),
      },
    }))
    adapter.dispose()
  })

  it('retires output ownership when both candidate and rollback renderers fail', async () => {
    let outputRequests = 0
    const runtime = new FakeRuntime((command) => {
      if (command.type !== 'configureVoiceOutput') return undefined
      outputRequests += 1
      if (outputRequests !== 2) return undefined
      throw Object.assign(new Error('Previous output rollback failed'), {
        detail: {
          code: 'audio_output_rollback_failed',
          message: 'Previous output rollback failed',
          retryable: true,
          stage: 'configureVoiceOutput',
        },
      })
    })
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = createInitialVoiceMediaDesiredState()
    await adapter.connect(lease, desired, new AbortController().signal)
    adapter.updateDesiredMedia({
      ...desired,
      outputDeviceId: 'broken-output',
    })
    await waitUntil(() => outputRequests === 2)
    await waitUntil(() => events.some((event) =>
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'mediaState' &&
      'kind' in event &&
      event.kind === 'output' &&
      'media' in event &&
      typeof event.media === 'object' &&
      event.media !== null &&
      'state' in event.media &&
      event.media.state === 'failed',
    ))

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'output',
      media: expect.objectContaining({
        state: 'failed',
        error: expect.objectContaining({
          code: 'output_config_failed',
        }),
      }),
    }))
    adapter.dispose()
  })

  it.each(['screen', 'camera', 'output'] as const)(
    'retires failed %s state before retrying that kind',
    async (kind) => {
      const runtime = new FakeRuntime()
      const adapter = new NativeRtcEngineAdapter(runtime)
      const events: unknown[] = []
      adapter.subscribe((event) => events.push(event))
      const desired = {
        ...createInitialVoiceMediaDesiredState(),
        screenEnabled: kind === 'screen',
        screenSourceId: 'screen-a',
        cameraEnabled: kind === 'camera',
        cameraDeviceId: 'camera-a',
      }
      await adapter.connect(lease, desired, new AbortController().signal)
      await waitUntil(() =>
        events.some((event) =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'mediaState' &&
          'kind' in event &&
          event.kind === kind &&
          'media' in event &&
          typeof event.media === 'object' &&
          event.media !== null &&
          'state' in event.media &&
          event.media.state === 'running'),
      )

      const commandType = kind === 'screen'
        ? 'connectScreen'
        : kind === 'camera'
          ? 'connectCamera'
          : 'configureVoiceOutput'
      const first = runtime.commands.find(
        (command) => command.type === commandType,
      )
      if (!first || !('generation' in first)) {
        throw new Error(`Expected initial ${kind} command`)
      }

      runtime.emitEvent({
        type: 'sessionLifecycle',
        sequence: runtime.commands.length,
        sessionId: lease.connectionEpoch,
        generation: first.generation,
        kind,
        state: {
          status: 'error',
          sessionId: lease.connectionEpoch,
          message: `${kind} failed`,
        },
        error: {
          code: `${kind}_failed`,
          message: `${kind} failed`,
          retryable: true,
          sessionId: lease.connectionEpoch,
          generation: first.generation,
        },
      })

      adapter.retryMedia(kind)
      await waitUntil(() =>
        runtime.commands.filter((command) => command.type === commandType)
          .length === 2,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      const retries = runtime.commands.filter(
        (command) => command.type === commandType,
      )
      expect(retries).toHaveLength(2)
      const second = retries[1]
      if (!second || !('generation' in second)) {
        throw new Error(`Expected retried ${kind} command`)
      }
      if (kind === 'output') {
        expect(second.generation).toBe(first.generation)
      } else {
        expect(second.generation).toBeGreaterThan(first.generation)
      }
      adapter.dispose()
    },
  )

  it('retires a failed microphone, ignores later metrics, and reconnects on retry', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      userMuted: false,
      effectiveMuted: false,
    }
    await adapter.connect(
      lease,
      desired,
      new AbortController().signal,
    )
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )
    await waitUntil(() =>
      events.some((event) =>
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'mediaState' &&
        'kind' in event &&
        event.kind === 'microphone' &&
        'media' in event &&
        typeof event.media === 'object' &&
        event.media !== null &&
        'state' in event.media &&
        event.media.state === 'running'),
    )
    const microphone = runtime.commands.find(
      (command) => command.type === 'connectMicrophone',
    )
    if (!microphone || microphone.type !== 'connectMicrophone') {
      throw new Error('Expected connectMicrophone command')
    }
    const microphoneConfig = runtime.commands.find(
      (command) => command.type === 'configureMicrophone',
    )
    if (!microphoneConfig || microphoneConfig.type !== 'configureMicrophone') {
      throw new Error('Expected configureMicrophone command')
    }

    runtime.emitEvent({
      type: 'microphoneMetrics',
      sequence: 1,
      metrics: {
        revision: microphoneConfig.revision,
        inputDb: -12,
        thresholdDb: -28,
        open: true,
      },
    })
    expect(events).toContainEqual({
      type: 'speakingChanged',
      participantIdentities: [lease.credential.participantIdentity],
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    })

    runtime.emitEvent({
      type: 'sessionLifecycle',
      sequence: 2,
      sessionId: lease.connectionEpoch,
      generation: microphone.generation,
      kind: 'microphone',
      state: {
        status: 'error',
        sessionId: lease.connectionEpoch,
        message: 'Microphone access was denied',
      },
      error: {
        code: 'audio_access_denied',
        message: 'Microphone access was denied',
        retryable: false,
        stage: 'microphone_capture',
        sessionId: lease.connectionEpoch,
        generation: microphone.generation,
        hresult: -2_147_024_895,
      },
    })

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'microphone',
      media: {
        state: 'failed',
        error: {
          code: 'audio_access_denied',
          message: 'Microphone access was denied',
          retryable: false,
          stage: 'microphone_capture',
          hresult: -2_147_024_895,
        },
      },
    }))
    expect(events).toContainEqual({
      type: 'speakingChanged',
      participantIdentities: [],
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    })
    const speakingEventCount = events.filter(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'speakingChanged',
    ).length
    runtime.emitEvent({
      type: 'microphoneMetrics',
      sequence: 3,
      metrics: {
        revision: microphoneConfig.revision,
        inputDb: -12,
        thresholdDb: -28,
        open: true,
      },
    })
    expect(events.filter(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'speakingChanged',
    )).toHaveLength(speakingEventCount)

    adapter.retryMedia('microphone')
    await waitUntil(() =>
      runtime.commands.filter((command) => command.type === 'connectMicrophone')
        .length === 2,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const microphoneReconnects = runtime.commands.filter(
      (command) => command.type === 'connectMicrophone',
    )
    expect(microphoneReconnects).toHaveLength(2)
    expect(microphoneReconnects[1]?.generation).toBeGreaterThan(
      microphone.generation,
    )
    adapter.dispose()
  })

  it('disconnects tracks before the shared voice Room', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    await adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )

    await adapter.disconnect('leave')

    const types = runtime.commands.map((command) => command.type)
    expect(types.at(-1)).toBe('disconnectVoice')
    expect(types).toContain('disconnectMicrophone')
    expect(types).toContain('disconnectScreen')
    adapter.dispose()
  })

  it('serializes overlapping Room replacements through complete teardown', async () => {
    let releaseFirstConnect!: () => void
    const firstConnectPending = new Promise<void>((resolve) => {
      releaseFirstConnect = resolve
    })
    let connectCount = 0
    const runtime = new FakeRuntime((command) => {
      if (command.type !== 'connectVoice') return undefined
      connectCount += 1
      return connectCount === 1 ? firstConnectPending : undefined
    })
    const adapter = new NativeRtcEngineAdapter(runtime)
    const desired = createInitialVoiceMediaDesiredState()
    const first = adapter.connect(
      lease,
      desired,
      new AbortController().signal,
    )
    await waitUntil(() => connectCount === 1)

    const replacementLease: VoiceLease = {
      ...lease,
      channelId: 'channel-b',
      operationId: 'op-b',
      connectionEpoch: 'epoch-b',
      authorityVersion: 2,
    }
    const replacement = adapter.connect(
      replacementLease,
      desired,
      new AbortController().signal,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connectCount).toBe(1)

    releaseFirstConnect()
    await first
    await replacement
    const voiceCommands = runtime.commands.filter((command) =>
      command.type === 'connectVoice' || command.type === 'disconnectVoice',
    )
    expect(voiceCommands.map((command) => command.type)).toEqual([
      'connectVoice',
      'disconnectVoice',
      'connectVoice',
    ])
    expect(voiceCommands.at(-1)).toMatchObject({
      type: 'connectVoice',
      sessionId: 'epoch-b',
    })
    adapter.dispose()
  })

  it('tears down an aborted Room attempt before accepting a replacement', async () => {
    const never = new Promise<void>(() => undefined)
    let connectCount = 0
    const runtime = new FakeRuntime((command) => {
      if (command.type !== 'connectVoice') return undefined
      connectCount += 1
      return connectCount === 1 ? never : undefined
    })
    const adapter = new NativeRtcEngineAdapter(runtime)
    const controller = new AbortController()
    const aborted = adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      controller.signal,
    )
    await waitUntil(() => connectCount === 1)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })

    const replacementLease: VoiceLease = {
      ...lease,
      channelId: 'channel-b',
      operationId: 'op-b',
      connectionEpoch: 'epoch-b',
      authorityVersion: 2,
    }
    await adapter.connect(
      replacementLease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )
    const voiceCommands = runtime.commands.filter((command) =>
      command.type === 'connectVoice' || command.type === 'disconnectVoice',
    )
    expect(voiceCommands.map((command) => command.type)).toEqual([
      'connectVoice',
      'disconnectVoice',
      'connectVoice',
    ])
    adapter.dispose()
  })

  it('tears down when abort wins immediately after native Room connect', async () => {
    const controller = new AbortController()
    const runtime = new FakeRuntime((command) => {
      if (command.type === 'connectVoice') controller.abort()
      return undefined
    })
    const adapter = new NativeRtcEngineAdapter(runtime)

    await expect(
      adapter.connect(
        lease,
        createInitialVoiceMediaDesiredState(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(
      runtime.commands
        .filter((command) =>
          command.type === 'connectVoice' || command.type === 'disconnectVoice',
        )
        .map((command) => command.type),
    ).toEqual(['connectVoice', 'disconnectVoice'])
    adapter.dispose()
  })

  it('tears down when abort arrives while applying Room audio settings', async () => {
    const controller = new AbortController()
    const runtime = new FakeRuntime((command) => {
      if (command.type === 'configureRemoteAudio') controller.abort()
      return undefined
    })
    const adapter = new NativeRtcEngineAdapter(runtime)
    adapter.updateRemoteAudioSettings({
      revision: 1,
      userVolumes: {},
      userMutes: {},
      streamVolumes: {},
      streamMutes: {},
    })

    await expect(
      adapter.connect(
        lease,
        createInitialVoiceMediaDesiredState(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(
      runtime.commands
        .filter((command) =>
          command.type === 'connectVoice' || command.type === 'disconnectVoice',
        )
        .map((command) => command.type),
    ).toEqual(['connectVoice', 'disconnectVoice'])
    adapter.dispose()
  })

  it('configures native output and camera without reconnecting voice', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const desired = createInitialVoiceMediaDesiredState()
    await adapter.connect(lease, desired, new AbortController().signal)

    adapter.updateDesiredMedia({
      ...desired,
      userDeafened: true,
      outputDeviceId: 'speakers-a',
      cameraEnabled: true,
      cameraDeviceId: 'camera-a',
      effectiveMuted: true,
    })
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectCamera'),
    )
    await waitUntil(() =>
      runtime.commands.some(
        (command) =>
          command.type === 'configureVoiceOutput' &&
          command.deafened &&
          command.deviceId === 'speakers-a',
      ),
    )
    expect(runtime.timeouts).toContainEqual({
      command: expect.objectContaining({ type: 'configureVoiceOutput' }),
      timeoutMs: 5_000,
    })

    expect(
      runtime.commands.filter((command) => command.type === 'connectVoice'),
    ).toHaveLength(1)
    adapter.dispose()
  })

  it('forwards native active speakers through the engine contract', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.connect(
      lease,
      createInitialVoiceMediaDesiredState(),
      new AbortController().signal,
    )

    runtime.emitEvent({
      type: 'activeSpeakers',
      sequence: 2,
      sessionId: lease.connectionEpoch,
      generation: 1,
      participantIdentities: ['voice:v1|web|c|e|o|user-b'],
    })

    expect(events).toContainEqual({
      type: 'speakingChanged',
      participantIdentities: ['user-b'],
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    })
    adapter.dispose()
  })

  it('exposes the latest generation-fenced native RTC telemetry', async () => {
    const runtime = new FakeRuntime()
    const timelineRecords: DiagnosticLogRecord[] = []
    const mediaTimeline = createMediaIncidentTimeline({
      record: (record) => timelineRecords.push(record),
    })
    const adapter = new NativeRtcEngineAdapter(runtime, undefined, {
      mediaTimeline,
    })
    await adapter.connect(
      lease,
      {
        ...createInitialVoiceMediaDesiredState(),
        screenEnabled: true,
        screenSourceId: 'screen:telemetry',
      },
      new AbortController().signal,
    )
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'startScreenCapture'),
    )
    const screenStart = runtime.commands.find(
      (command) => command.type === 'startScreenCapture',
    )
    if (!screenStart || screenStart.type !== 'startScreenCapture') {
      throw new Error('screen start command was not emitted')
    }

    runtime.emitEvent({
      type: 'voiceStats',
      sequence: 2,
      sessionId: lease.connectionEpoch,
      generation: 99,
      stats: {
        transport: { pingMs: 999 },
        outbound: [],
        inbound: [],
      },
    })
    expect(adapter.telemetry()).toBeNull()

    runtime.emitEvent({
      type: 'voiceStats',
      sequence: 3,
      sessionId: lease.connectionEpoch,
      generation: 1,
      stats: {
        transport: {
          pingMs: 42,
          bytesSent: 1_000,
          bytesReceived: 2_000,
        },
        outbound: [{
          id: 'publisher:audio-out',
          pcRole: 'publisher',
          kind: 'audio',
          packetsSent: 100,
          bytesSent: 12_000,
          packetLossPercent: 1.5,
        }],
        inbound: [{
          id: 'subscriber:audio-in',
          pcRole: 'subscriber',
          kind: 'audio',
          packetsReceived: 98,
          packetsLost: 2,
          bytesReceived: 11_000,
          jitter: 0.012,
          jitterBufferDelay: 0.26,
          jitterBufferTargetDelay: 0.42,
          jitterBufferEmittedCount: 20,
        }],
      },
    })

    expect(adapter.telemetry()).toMatchObject({
      transport: { pingMs: 42 },
      outbound: [{ id: 'publisher:audio-out', packetLossPercent: 1.5 }],
      inbound: [{ id: 'subscriber:audio-in', jitter: 0.012 }],
    })
    expect(timelineRecords).toContainEqual(expect.objectContaining({
      scope: 'desktop-voice',
      event: 'media_timeline',
      stage: 'webrtc_jitter',
      sessionId: lease.connectionEpoch,
      generation: 1,
      trackId: 'subscriber:audio-in',
      runtimeEpoch: 0,
      metrics: {
        jitterBufferDelayMs: 13,
        jitterBufferTargetDelayMs: 21,
        jitterBufferEmittedCount: 20,
        webRtcJitterMs: 12,
      },
    }))
    const rtcTimestamp = adapter.telemetry()?.timestamp

    runtime.emitEvent({
      type: 'stats',
      sequence: 4,
      sessionId: lease.connectionEpoch,
      generation: screenStart.generation,
      stats: {
        sessionId: lease.connectionEpoch,
        methods: { wgc_gpu: 60, dxgi_gpu: 0 },
        activeMethod: 'wgc_gpu',
        videoFrames: 120,
        videoGpuPoolSlotsAvailable: 2,
        videoGpuPoolSlotsTotal: 3,
        videoGpuSlotTimeouts: 4,
        videoGpuFramesDroppedStale: 5,
        videoPreviewFramesDroppedStale: 6,
        rtpStatsAvailable: true,
        rtpPacketsSent: 1_000,
        rtpBytesSent: 2_000_000,
        rtpFramesSent: 118,
        rtpFramesEncoded: 119,
        encoderImplementation: 'hardware-encoder',
      },
    })

    expect(adapter.telemetry()).toMatchObject({
      timestamp: rtcTimestamp,
      nativeCapture: {
        methods: { wgc_gpu: 60, dxgi_gpu: 0 },
        activeMethod: 'wgc_gpu',
        videoFrames: 120,
        videoGpuPoolSlotsAvailable: 2,
        videoGpuPoolSlotsTotal: 3,
        videoGpuSlotTimeouts: 4,
        videoGpuFramesDroppedStale: 5,
        videoPreviewFramesDroppedStale: 6,
        rtpStatsAvailable: true,
        rtpPacketsSent: 1_000,
        rtpBytesSent: 2_000_000,
        rtpFramesSent: 118,
        rtpFramesEncoded: 119,
        encoderImplementation: 'hardware-encoder',
      },
    })

    await adapter.disconnect('test')
    expect(adapter.telemetry()).toBeNull()
    adapter.dispose()
  })

  it('combines native microphone gate activity with remote activity', async () => {
    const runtime = new FakeRuntime()
    const adapter = new NativeRtcEngineAdapter(runtime)
    const events: unknown[] = []
    adapter.subscribe((event) => events.push(event))
    const desired = {
      ...createInitialVoiceMediaDesiredState(),
      effectiveMuted: false,
    }

    await adapter.connect(lease, desired, new AbortController().signal)
    await waitUntil(() =>
      runtime.commands.some((command) => command.type === 'connectMicrophone'),
    )
    await waitUntil(() =>
      events.some(
        (event) =>
          (event as { type?: string; kind?: string; media?: { state?: string } })
            .type === 'mediaState' &&
          (event as { kind?: string }).kind === 'microphone' &&
          (event as { media?: { state?: string } }).media?.state === 'running',
      ),
    )

    runtime.emitEvent({
      type: 'microphoneMetrics',
      sequence: 3,
      metrics: { revision: 0, inputDb: -12, thresholdDb: -28, open: true },
    })
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'speakingChanged',
      participantIdentities: ['participant'],
    }))

    runtime.emitEvent({
      type: 'microphoneMetrics',
      sequence: 4,
      metrics: { revision: 1, inputDb: -12, thresholdDb: -28, open: true },
    })
    expect(events).toContainEqual({
      type: 'speakingChanged',
      participantIdentities: ['participant'],
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    })

    runtime.emitEvent({
      type: 'activeSpeakers',
      sequence: 5,
      sessionId: lease.connectionEpoch,
      generation: 1,
      participantIdentities: ['remote-user'],
    })
    expect(events.at(-1)).toMatchObject({
      type: 'speakingChanged',
      participantIdentities: ['remote-user', 'participant'],
    })
    adapter.dispose()
  })
})
