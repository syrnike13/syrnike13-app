import { describe, expect, it } from 'vitest'
import {
  createInitialVoiceMediaDesiredState,
  type VoiceLease,
} from '@syrnike13/platform'

import type {
  NativeRuntimeCommand,
  NativeRuntimeEvent,
} from '../native-runtime/contract'
import type {
  NativeRuntimeGenerationLane,
  NativeRuntimeSupervisorSnapshot,
} from '../native-runtime/runtime-supervisor'
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

  async request<T = unknown>(command: NativeRuntimeCommand, timeoutMs: number) {
    this.commands.push(command)
    this.timeouts.push({ command, timeoutMs })
    await this.onRequest?.(command)
    return undefined as T
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
      projectedCode: 'microphone_device_fallback',
      message: 'Selected audio input is unavailable; using system default',
    },
    {
      kind: 'output' as const,
      code: 'audio_output_fallback_default',
      projectedCode: 'output_device_fallback',
      message: 'Selected audio output is unavailable; using system default',
    },
  ])('keeps $kind running and reports a typed fallback to default', async ({
    kind,
    code,
    projectedCode,
    message,
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
      media: {
        state: 'running',
        error: expect.objectContaining({ code: projectedCode }),
      },
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

  it('keeps the output generation while default endpoint recovery is pending', async () => {
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
        message: 'audio_output_default_recovered',
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
