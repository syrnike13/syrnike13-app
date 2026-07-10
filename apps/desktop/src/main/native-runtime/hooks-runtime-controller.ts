import type { NativeInputEvent } from '@syrnike13/platform'

import type {
  HooksRuntimeCommand,
  HooksRuntimeEvent,
  OverlayForegroundWindow,
} from './contract'
import {
  NativeRuntimeRequestError,
  NativeRuntimeSupervisor,
} from './runtime-supervisor'
import type { NativeRuntimeSupervisorSnapshot } from './runtime-supervisor'
import {
  createElectronUtilityAdapterFactory,
  nativeRuntimeAvailable,
} from './utility-adapter'
import { attachNativeRuntimeMetrics } from './anonymous-metrics'

const HOOKS_REQUEST_TIMEOUT_MS = 5_000

export class HooksRuntimeController {
  private readonly inputListeners = new Set<(event: NativeInputEvent) => void>()
  private readonly overlayListeners = new Set<
    (window: OverlayForegroundWindow | null) => void
  >()
  private readonly stateListeners = new Set<
    (snapshot: NativeRuntimeSupervisorSnapshot) => void
  >()
  private wantsHotkeys = false
  private wantsOverlay = false
  private lastRestoredRestartCount = 0
  private disposed = false

  constructor(private readonly supervisor: NativeRuntimeSupervisor) {
    supervisor.onEvent((event) => this.handleEvent(event as HooksRuntimeEvent))
    supervisor.onStateChange((snapshot) => {
      for (const listener of this.stateListeners) listener(snapshot)
      if (
        snapshot.status === 'ready' &&
        snapshot.restartCount > this.lastRestoredRestartCount
      ) {
        this.lastRestoredRestartCount = snapshot.restartCount
        void this.restoreDesiredState()
      }
      if (snapshot.status === 'recovering' || snapshot.status === 'degraded') {
        for (const listener of this.overlayListeners) listener(null)
      }
    })
  }

  isAvailable() {
    return nativeRuntimeAvailable('hooks')
  }

  getStatus() {
    return this.supervisor.getSnapshot().status
  }

  onStateChange(listener: (snapshot: NativeRuntimeSupervisorSnapshot) => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  async startHotkeys(listener: (event: NativeInputEvent) => void) {
    if (this.disposed) throw new Error('Native hooks controller is disposed')
    this.inputListeners.add(listener)
    if (this.wantsHotkeys) return
    this.wantsHotkeys = true
    try {
      await this.request({ type: 'startHotkeys' })
    } catch (error) {
      if (!isRetryableRuntimeLoss(error)) {
        this.wantsHotkeys = false
        this.inputListeners.delete(listener)
      }
      throw error
    }
  }

  async stopHotkeys(listener?: (event: NativeInputEvent) => void) {
    if (listener) this.inputListeners.delete(listener)
    else this.inputListeners.clear()
    if (this.inputListeners.size > 0 || !this.wantsHotkeys) return
    this.wantsHotkeys = false
    await this.request({ type: 'stopHotkeys' }).catch(() => undefined)
  }

  async startOverlay(
    listener: (window: OverlayForegroundWindow | null) => void,
  ) {
    if (this.disposed) throw new Error('Native hooks controller is disposed')
    this.overlayListeners.add(listener)
    if (this.wantsOverlay) return
    this.wantsOverlay = true
    try {
      await this.request({ type: 'startOverlay' })
    } catch (error) {
      if (!isRetryableRuntimeLoss(error)) {
        this.wantsOverlay = false
        this.overlayListeners.delete(listener)
      }
      throw error
    }
  }

  async stopOverlay(
    listener?: (window: OverlayForegroundWindow | null) => void,
  ) {
    if (listener) this.overlayListeners.delete(listener)
    else this.overlayListeners.clear()
    if (this.overlayListeners.size > 0 || !this.wantsOverlay) return
    this.wantsOverlay = false
    await this.request({ type: 'stopOverlay' }).catch(() => undefined)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.wantsHotkeys = false
    this.wantsOverlay = false
    this.inputListeners.clear()
    this.overlayListeners.clear()
    this.stateListeners.clear()
    await this.supervisor.shutdown()
  }

  private request(command: HooksRuntimeCommand) {
    if (this.disposed) {
      return Promise.reject(new Error('Native hooks controller is disposed'))
    }
    if (!this.isAvailable()) {
      return Promise.reject(new Error('Native hooks runtime is not available'))
    }
    return this.supervisor.request(command, HOOKS_REQUEST_TIMEOUT_MS)
  }

  private handleEvent(event: HooksRuntimeEvent) {
    switch (event.type) {
      case 'input':
        for (const listener of this.inputListeners) listener(event.input)
        return
      case 'foregroundWindow':
        for (const listener of this.overlayListeners) listener(event.window)
        return
      case 'runtimeError':
        console.warn('[native-hooks]', event.error.code, event.error.message)
        return
    }
  }

  private async restoreDesiredState() {
    const commands: HooksRuntimeCommand[] = []
    if (this.wantsHotkeys) commands.push({ type: 'startHotkeys' })
    if (this.wantsOverlay) commands.push({ type: 'startOverlay' })
    await Promise.all(commands.map((command) => this.request(command).catch(() => undefined)))
  }
}

const hooksSupervisor = new NativeRuntimeSupervisor({
  runtime: 'hooks',
  createAdapter: createElectronUtilityAdapterFactory('hooks'),
})

attachNativeRuntimeMetrics(hooksSupervisor, 'hooks')

export const hooksRuntimeController = new HooksRuntimeController(hooksSupervisor)

function isRetryableRuntimeLoss(error: unknown) {
  return (
    error instanceof NativeRuntimeRequestError &&
    error.detail.retryable &&
    (error.detail.code === 'runtime_lost' ||
      error.detail.code === 'request_timeout' ||
      error.detail.code === 'handshake_failed')
  )
}
