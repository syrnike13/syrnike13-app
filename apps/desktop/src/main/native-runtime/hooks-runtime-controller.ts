import type { NativeInputEvent } from '@syrnike13/platform'

import type { HooksRuntimeCommand, HooksRuntimeEvent, OverlayForegroundWindow } from './contract'
import { NativeRuntimeRequestError, NativeRuntimeSupervisor } from './runtime-supervisor'
import type { NativeRuntimeSupervisorSnapshot } from './runtime-supervisor'
import { createElectronUtilityAdapterFactory, nativeRuntimeAvailable } from './utility-adapter'
import { attachNativeRuntimeMetrics } from './anonymous-metrics'

const REQUEST_TIMEOUT_MS = 5_000

export class HooksRuntimeController {
  private readonly inputListeners = new Set<(event: NativeInputEvent) => void>()
  private readonly overlayListeners = new Set<(window: OverlayForegroundWindow | null) => void>()
  private readonly stateListeners = new Set<(snapshot: NativeRuntimeSupervisorSnapshot) => void>()
  private wantsHotkeys = false
  private wantsOverlay = false
  private hotkeyRestored = 0
  private overlayRestored = 0
  private disposed = false

  constructor(
    private readonly hotkeySupervisor: NativeRuntimeSupervisor,
    private readonly overlaySupervisor: NativeRuntimeSupervisor = hotkeySupervisor,
  ) {
    hotkeySupervisor.onEvent((event) => this.handleHotkeyEvent(event as HooksRuntimeEvent))
    overlaySupervisor.onEvent((event) => this.handleOverlayEvent(event as HooksRuntimeEvent))
    if (overlaySupervisor === hotkeySupervisor) this.observe(hotkeySupervisor, 'both')
    else { this.observe(hotkeySupervisor, 'hotkey'); this.observe(overlaySupervisor, 'overlay') }
  }

  private observe(supervisor: NativeRuntimeSupervisor, kind: 'hotkey' | 'overlay' | 'both') {
    supervisor.onStateChange((snapshot) => {
      for (const listener of this.stateListeners) listener(snapshot)
      if (snapshot.status === 'ready') {
        const restored = kind === 'overlay' ? this.overlayRestored : this.hotkeyRestored
        if (snapshot.restartCount > restored) {
          if (kind !== 'overlay') this.hotkeyRestored = snapshot.restartCount
          if (kind !== 'hotkey') this.overlayRestored = snapshot.restartCount
          if (kind === 'both') void Promise.all([this.restore('hotkey'), this.restore('overlay')])
          else void this.restore(kind)
        }
      }
      if (kind !== 'hotkey' && (snapshot.status === 'recovering' || snapshot.status === 'degraded')) {
        for (const listener of this.overlayListeners) listener(null)
      }
    })
  }

  isAvailable() { return nativeRuntimeAvailable('hotkey') && nativeRuntimeAvailable('overlay') }
  getStatus() {
    const hotkey = this.hotkeySupervisor.getSnapshot().status
    const overlay = this.overlaySupervisor.getSnapshot().status
    if (hotkey === 'degraded' || overlay === 'degraded') return 'degraded'
    if (hotkey === 'recovering' || overlay === 'recovering') return 'recovering'
    if (hotkey === 'starting' || overlay === 'starting') return 'starting'
    return hotkey === 'ready' && overlay === 'ready' ? 'ready' : 'stopped'
  }
  onStateChange(listener: (snapshot: NativeRuntimeSupervisorSnapshot) => void) {
    this.stateListeners.add(listener); return () => this.stateListeners.delete(listener)
  }

  async startHotkeys(listener: (event: NativeInputEvent) => void) {
    if (this.disposed) throw new Error('Native hooks controller is disposed')
    this.inputListeners.add(listener)
    if (this.wantsHotkeys) return
    this.wantsHotkeys = true
    try { await this.request('hotkey', { type: 'startHotkeys' }) }
    catch (error) { if (!isRetryableRuntimeLoss(error)) { this.wantsHotkeys = false; this.inputListeners.delete(listener) }; throw error }
  }
  async stopHotkeys(listener?: (event: NativeInputEvent) => void) {
    if (listener) this.inputListeners.delete(listener); else this.inputListeners.clear()
    if (this.inputListeners.size || !this.wantsHotkeys) return
    this.wantsHotkeys = false
    await this.request('hotkey', { type: 'stopHotkeys' }).catch(() => undefined)
  }
  async startOverlay(listener: (window: OverlayForegroundWindow | null) => void) {
    if (this.disposed) throw new Error('Native hooks controller is disposed')
    this.overlayListeners.add(listener)
    if (this.wantsOverlay) return
    this.wantsOverlay = true
    try { await this.request('overlay', { type: 'startOverlay' }) }
    catch (error) { if (!isRetryableRuntimeLoss(error)) { this.wantsOverlay = false; this.overlayListeners.delete(listener) }; throw error }
  }
  async stopOverlay(listener?: (window: OverlayForegroundWindow | null) => void) {
    if (listener) this.overlayListeners.delete(listener); else this.overlayListeners.clear()
    if (this.overlayListeners.size || !this.wantsOverlay) return
    this.wantsOverlay = false
    await this.request('overlay', { type: 'stopOverlay' }).catch(() => undefined)
  }
  async dispose() {
    if (this.disposed) return
    this.disposed = true; this.inputListeners.clear(); this.overlayListeners.clear(); this.stateListeners.clear()
    await Promise.all([this.hotkeySupervisor.shutdown(), this.overlaySupervisor === this.hotkeySupervisor ? undefined : this.overlaySupervisor.shutdown()])
  }
  private request(kind: 'hotkey' | 'overlay', command: HooksRuntimeCommand) {
    if (this.disposed) return Promise.reject(new Error('Native hooks controller is disposed'))
    if (!this.isAvailable()) return Promise.reject(new Error(`Native ${kind} runtime is not available`))
    return (kind === 'hotkey' ? this.hotkeySupervisor : this.overlaySupervisor).request(command, REQUEST_TIMEOUT_MS)
  }
  private handleHotkeyEvent(event: HooksRuntimeEvent) {
    if (event.type === 'input') for (const listener of this.inputListeners) listener(event.input)
    else if (event.type === 'runtimeError') console.warn('[native-hotkey]', event.error.code, event.error.message)
  }
  private handleOverlayEvent(event: HooksRuntimeEvent) {
    if (event.type === 'foregroundWindow') for (const listener of this.overlayListeners) listener(event.window)
    else if (event.type === 'runtimeError') console.warn('[native-overlay]', event.error.code, event.error.message)
  }
  private async restore(kind: 'hotkey' | 'overlay') {
    if (kind === 'hotkey' && this.wantsHotkeys) await this.request(kind, { type: 'startHotkeys' }).catch(() => undefined)
    if (kind === 'overlay' && this.wantsOverlay) await this.request(kind, { type: 'startOverlay' }).catch(() => undefined)
  }
}

const hotkeySupervisor = new NativeRuntimeSupervisor({ runtime: 'hotkey', createAdapter: createElectronUtilityAdapterFactory('hotkey') })
const overlaySupervisor = new NativeRuntimeSupervisor({ runtime: 'overlay', createAdapter: createElectronUtilityAdapterFactory('overlay') })
attachNativeRuntimeMetrics(hotkeySupervisor, 'hotkey')
attachNativeRuntimeMetrics(overlaySupervisor, 'overlay')
export const hooksRuntimeController = new HooksRuntimeController(hotkeySupervisor, overlaySupervisor)

function isRetryableRuntimeLoss(error: unknown) {
  return error instanceof NativeRuntimeRequestError && error.detail.retryable &&
    ['runtime_lost', 'request_timeout', 'handshake_failed'].includes(error.detail.code)
}
