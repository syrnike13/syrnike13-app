import { describe, expect, it } from 'vitest'
import {
  createInitialVoiceMediaDesiredState,
  type VoiceLease,
} from '@syrnike13/platform'

import type {
  NativeRuntimeCommand,
  NativeRuntimeEvent,
} from '../native-runtime/contract'
import type { NativeRuntimeSupervisorSnapshot } from '../native-runtime/runtime-supervisor'
import {
  NativeRtcEngineAdapter,
  type NativeVoiceRuntime,
} from './native-rtc-engine-adapter'

class FakeRuntime implements NativeVoiceRuntime {
  readonly commands: NativeRuntimeCommand[] = []
  private readonly eventListeners = new Set<(event: NativeRuntimeEvent) => void>()
  private readonly stateListeners = new Set<
    (snapshot: NativeRuntimeSupervisorSnapshot) => void
  >()

  constructor(
    private readonly onRequest?: (
      command: NativeRuntimeCommand,
    ) => Promise<unknown> | undefined,
  ) {}

  async request<T = unknown>(command: NativeRuntimeCommand) {
    this.commands.push(command)
    await this.onRequest?.(command)
    return undefined as T
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
    const microphone = runtime.commands.find(
      (command) => command.type === 'connectMicrophone',
    )
    expect(microphone).toMatchObject({
      sessionId: 'epoch-a',
      excludeProcessId: 42,
      options: {
        livekit: lease.credential,
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
        detail: { code: string }
      }
      error.detail = { code: 'gpu_encoder_unavailable' }
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
        detail: { code: string }
      }
      error.detail = { code: 'target_closed' }
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

  it('keeps output running and reports when native rendering falls back to default', async () => {
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
      type: 'sessionLifecycle',
      sequence: 1,
      sessionId: lease.connectionEpoch,
      generation: 1,
      kind: 'output',
      state: {
        status: 'running',
        sessionId: lease.connectionEpoch,
        deviceId: 'default',
        message: 'Selected audio output is unavailable; using system default',
      },
    } as NativeRuntimeEvent)

    expect(events).toContainEqual(expect.objectContaining({
      type: 'mediaState',
      kind: 'output',
      media: {
        state: 'running',
        error: expect.objectContaining({ code: 'output_device_fallback' }),
      },
    }))
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
      metrics: { inputDb: -12, thresholdDb: -28, open: true },
    })
    expect(events).toContainEqual({
      type: 'speakingChanged',
      participantIdentities: ['participant'],
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    })

    runtime.emitEvent({
      type: 'activeSpeakers',
      sequence: 4,
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
