import type {
  DesktopDisplayMediaSource,
  NativeMediaDeviceInfo,
  NativeMicrophoneMetricsEvent,
  NativeMicrophonePreviewStateEvent,
} from '@syrnike13/platform'

import type { DiagnosticLogSink } from './diagnostic-log'
import {
  isNativeRuntimeCommand,
  type MediaRuntimeCommand,
  type MediaRuntimeEvent,
} from './contract'
import type {
  NativeRuntimeSupervisor,
  NativeRuntimeSupervisorSnapshot,
} from './runtime-supervisor'

const QUERY_TIMEOUT_MS = 5_000
const SESSION_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 5_000

type PreviewSessionState = {
  sessionId: string
  generation: number
  status: 'starting' | 'running'
}

type LocalScreenPreviewDemand = {
  demanded: boolean
  width: number
  height: number
  fps: number
}

export type NativeMediaControllerEvent =
  | { type: 'microphoneMetrics'; event: NativeMicrophoneMetricsEvent }
  | { type: 'microphonePreviewState'; event: NativeMicrophonePreviewStateEvent }

export type NativeMediaControllerOptions = {
  supervisor: NativeRuntimeSupervisor
  runtimeAvailable: () => boolean
  getSelfWindowHwnd: () => string | undefined
  processId?: number
  diagnostics?: DiagnosticLogSink
}

export class NativeMediaController {
  private readonly listeners = new Set<(event: NativeMediaControllerEvent) => void>()
  private readonly unsubscribeRuntimeEvent: () => void
  private readonly unsubscribeRuntimeState: () => void
  private previewGeneration = 0
  private preview: PreviewSessionState | null = null
  private previewStartOperation: Promise<void> | null = null
  private lastRestoredRestartCount = 0
  private disposed = false
  private activeScreen: { sessionId: string; generation: number } | null = null
  private readonly remoteVideoDemands = new Map<
    string,
    { demanded: boolean; revision: number }
  >()
  private remoteVideoDemandRevision = 0
  private localScreenPreviewDemand: LocalScreenPreviewDemand = {
    demanded: false,
    width: 1280,
    height: 720,
    fps: 30,
  }

  constructor(private readonly options: NativeMediaControllerOptions) {
    this.unsubscribeRuntimeEvent = options.supervisor.onEvent((event) =>
      this.handleRuntimeEvent(event as MediaRuntimeEvent),
    )
    this.unsubscribeRuntimeState = options.supervisor.onStateChange((snapshot) =>
      this.handleSupervisorState(snapshot),
    )
  }

  subscribe(listener: (event: NativeMediaControllerEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start() {
    if (!this.options.runtimeAvailable()) return
    await this.options.supervisor.start()
  }

  async supportsNativeScreenCapture() {
    if (!this.options.runtimeAvailable()) return false
    await this.start()
    const snapshot = this.options.supervisor.getSnapshot()
    return snapshot.status === 'ready' && Boolean(snapshot.ready?.capabilities.includes('screen'))
  }

  async listDevices(
    kind: 'audioinput' | 'audiooutput' | 'videoinput',
  ): Promise<NativeMediaDeviceInfo[]> {
    if (!this.options.runtimeAvailable()) return []
    const result = await this.request<unknown>({ type: 'listDevices', kind }, QUERY_TIMEOUT_MS)
    return Array.isArray(result) ? result.filter(isNativeMediaDeviceInfo) : []
  }

  async listDisplaySources(): Promise<DesktopDisplayMediaSource[]> {
    if (!this.options.runtimeAvailable()) return []
    const result = await this.request<unknown>(
      { type: 'listDisplaySources', selfWindowHwnd: this.options.getSelfWindowHwnd() },
      QUERY_TIMEOUT_MS,
    )
    return Array.isArray(result) ? result.filter(isDesktopDisplayMediaSource) : []
  }

  startMicrophonePreview(): Promise<void> {
    if (this.preview?.status === 'running') return Promise.resolve()
    if (this.previewStartOperation) return this.previewStartOperation
    const generation = ++this.previewGeneration
    const operation = this.startMicrophonePreviewNow(generation)
    this.previewStartOperation = operation
    void operation.finally(() => {
      if (this.previewStartOperation === operation) this.previewStartOperation = null
    }).catch(() => undefined)
    return operation
  }

  async stopMicrophonePreview() {
    const preview = this.preview
    const hadPreview = Boolean(preview || this.previewStartOperation)
    this.preview = null
    this.previewStartOperation = null
    ++this.previewGeneration
    if (preview) {
      await this.request(
        { type: 'stopPreview', sessionId: preview.sessionId, generation: preview.generation },
        STOP_TIMEOUT_MS,
      ).catch(() => undefined)
    }
    if (hadPreview) this.emit({ type: 'microphonePreviewState', event: { status: 'stopped' } })
  }

  async setRemoteVideoDemand(
    sessionId: string,
    generation: number,
    trackId: string,
    demanded: boolean,
  ) {
    if (!sessionId || !trackId) throw new Error('Remote video identity is required')
    const key = remoteVideoDemandKey(sessionId, generation, trackId)
    this.remoteVideoDemands.set(key, {
      demanded,
      revision: ++this.remoteVideoDemandRevision,
    })
    await this.request(
      { type: 'setRemoteVideoDemand', sessionId, generation, trackId, demanded },
      2_000,
    )
  }

  async recoverRemoteVideoDemand(
    sessionId: string,
    generation: number,
    trackId: string,
  ) {
    const key = remoteVideoDemandKey(sessionId, generation, trackId)
    const desired = this.remoteVideoDemands.get(key)
    if (!desired?.demanded) return false
    await this.request(
      { type: 'setRemoteVideoDemand', sessionId, generation, trackId, demanded: false },
      2_000,
    )
    const current = this.remoteVideoDemands.get(key)
    if (!current?.demanded || current.revision !== desired.revision) return false
    await this.request(
      { type: 'setRemoteVideoDemand', sessionId, generation, trackId, demanded: true },
      2_000,
    )
    return true
  }

  async setLocalScreenPreviewDemand(demand: LocalScreenPreviewDemand) {
    if (!demand || typeof demand.demanded !== 'boolean' ||
      !Number.isFinite(demand.width) || !Number.isFinite(demand.height) ||
      !Number.isFinite(demand.fps)) {
      throw new Error('Invalid local screen preview demand')
    }
    this.localScreenPreviewDemand = {
      demanded: Boolean(demand.demanded),
      width: Math.max(16, Math.min(3840, Math.trunc(demand.width))),
      height: Math.max(16, Math.min(2160, Math.trunc(demand.height))),
      fps: Math.max(1, Math.min(60, Math.trunc(demand.fps))),
    }
    const screen = this.activeScreen
    if (!screen) return
    await this.sendLocalScreenPreviewDemand(screen)
  }

  async dispose() {
    if (this.disposed) return
    await this.stopMicrophonePreview().catch(() => undefined)
    this.disposed = true
    this.remoteVideoDemands.clear()
    this.unsubscribeRuntimeEvent()
    this.unsubscribeRuntimeState()
    this.listeners.clear()
    await this.options.supervisor.shutdown().catch(() => undefined)
  }

  private async startMicrophonePreviewNow(generation: number) {
    await this.start()
    if (generation !== this.previewGeneration) throw new Error('Native microphone preview start cancelled')
    const preview: PreviewSessionState = {
      sessionId: crypto.randomUUID(),
      generation,
      status: 'starting',
    }
    this.preview = preview
    try {
      const result = await this.request<unknown>(
        { type: 'startPreview', sessionId: preview.sessionId, generation },
        SESSION_TIMEOUT_MS,
      )
      if (this.preview !== preview || generation !== this.previewGeneration) {
        await this.request(
          { type: 'stopPreview', sessionId: preview.sessionId, generation },
          STOP_TIMEOUT_MS,
        ).catch(() => undefined)
        throw new Error('Native microphone preview start cancelled')
      }
      readPreviewResult(result, preview.sessionId)
      preview.status = 'running'
      this.emit({ type: 'microphonePreviewState', event: { status: 'running' } })
    } catch (error) {
      if (this.preview === preview) this.preview = null
      throw error
    }
  }

  private request<T = unknown>(command: MediaRuntimeCommand, timeoutMs: number) {
    if (this.disposed) return Promise.reject(new Error('Native media controller is disposed'))
    if (!isNativeRuntimeCommand(command)) return Promise.reject(new Error('Invalid native runtime command'))
    return this.options.supervisor.request<T>(command, timeoutMs)
  }

  private handleRuntimeEvent(event: MediaRuntimeEvent) {
    if (event.type === 'microphoneMetrics') {
      this.emit({ type: 'microphoneMetrics', event: event.metrics })
      return
    }
    if (event.type === 'runtimeError') {
      const preview = this.preview
      if (
        !preview ||
        event.error.sessionId !== preview.sessionId ||
        event.error.generation !== preview.generation
      ) return
      this.preview = null
      this.previewStartOperation = null
      ++this.previewGeneration
      this.emit({
        type: 'microphonePreviewState',
        event: { status: 'error', message: event.error.message },
      })
      return
    }
    if (
      event.type === 'deviceList' ||
      event.type === 'displaySourceList' ||
      event.type === 'remoteVideoFrame' ||
      event.type === 'remoteVideoTrackRemoved' ||
      event.type === 'remoteVideoFailed' ||
      event.type === 'localScreenPreviewFrame' ||
      event.type === 'localScreenPreviewTrackRemoved' ||
      event.type === 'localScreenPreviewFailed'
    ) return
    if (event.type === 'sessionLifecycle' && event.kind === 'screen') {
      if (event.state.status === 'starting' || event.state.status === 'running') {
        const next = { sessionId: event.sessionId, generation: event.generation }
        const changed = this.activeScreen?.sessionId !== next.sessionId ||
          this.activeScreen.generation !== next.generation
        this.activeScreen = next
        if (changed) void this.sendLocalScreenPreviewDemand(next).catch(() => undefined)
      } else if (this.activeScreen?.sessionId === event.sessionId &&
        this.activeScreen.generation === event.generation) {
        this.activeScreen = null
      }
    }
    if (event.type === 'sessionStopped' && this.activeScreen?.sessionId === event.sessionId &&
      this.activeScreen.generation === event.generation) {
      this.activeScreen = null
    }
    const preview = this.preview
    if (!preview || event.sessionId !== preview.sessionId || event.generation !== preview.generation) return
    if (event.type === 'sessionStopped') {
      this.preview = null
      this.previewStartOperation = null
      ++this.previewGeneration
      this.emit({ type: 'microphonePreviewState', event: { status: 'stopped' } })
    }
  }

  private handleSupervisorState(snapshot: NativeRuntimeSupervisorSnapshot) {
    if (snapshot.status === 'degraded' || snapshot.status === 'recovering') {
      this.activeScreen = null
    }
    if (snapshot.status === 'degraded' && (this.preview || this.previewStartOperation)) {
      this.preview = null
      this.previewStartOperation = null
      ++this.previewGeneration
      this.emit({
        type: 'microphonePreviewState',
        event: { status: 'error', message: snapshot.degradedReason ?? 'Native media runtime is unavailable' },
      })
    }
    if (snapshot.status !== 'ready' || snapshot.restartCount <= this.lastRestoredRestartCount) return
    this.lastRestoredRestartCount = snapshot.restartCount
    const preview = this.preview
    if (!preview || preview.status !== 'running') return
    preview.generation = ++this.previewGeneration
    void this.request(
      { type: 'startPreview', sessionId: preview.sessionId, generation: preview.generation },
      SESSION_TIMEOUT_MS,
    )
      .catch((error) => {
        if (this.preview !== preview) return
        this.preview = null
        this.emit({
          type: 'microphonePreviewState',
          event: { status: 'error', message: error instanceof Error ? error.message : 'Native microphone preview recovery failed' },
        })
      })
  }

  private emit(event: NativeMediaControllerEvent) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Runtime behavior must not depend on observers. */ }
    }
  }

  private sendLocalScreenPreviewDemand(screen: { sessionId: string; generation: number }) {
    const demand = this.localScreenPreviewDemand
    return this.request(
      {
        type: 'setLocalScreenPreviewDemand',
        ...screen,
        demanded: demand.demanded,
        electronMainPid: this.options.processId ?? process.pid,
        options: { width: demand.width, height: demand.height, fps: demand.fps },
      },
      2_000,
    )
  }
}

function remoteVideoDemandKey(
  sessionId: string,
  generation: number,
  trackId: string,
) {
  return `${sessionId}:${generation}:${trackId}`
}

function unwrapResult(value: unknown) {
  return value && typeof value === 'object' && 'session' in value
    ? (value as { session: unknown }).session
    : value
}

function readPreviewResult(value: unknown, sessionId: string) {
  const result = unwrapResult(value)
  if (!result || typeof result !== 'object' || (result as { sessionId?: unknown }).sessionId !== sessionId) {
    throw new Error('Native runtime returned invalid preview metadata')
  }
}

function isNativeMediaDeviceInfo(value: unknown): value is NativeMediaDeviceInfo {
  if (!value || typeof value !== 'object') return false
  const device = value as Partial<NativeMediaDeviceInfo>
  return typeof device.deviceId === 'string' &&
    (device.kind === 'audioinput' || device.kind === 'audiooutput' || device.kind === 'videoinput') &&
    typeof device.label === 'string'
}

function isDesktopDisplayMediaSource(value: unknown): value is DesktopDisplayMediaSource {
  if (!value || typeof value !== 'object') return false
  const source = value as Partial<DesktopDisplayMediaSource>
  return typeof source.id === 'string' && typeof source.name === 'string' &&
    (source.type === 'screen' || source.type === 'window' || source.type === 'game')
}
