import type { NativeInputEvent } from '@syrnike13/platform'
import { Effect } from 'effect'

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
    hotkeySupervisor.onEvent((event) => {
      if (
        event.type === 'input' ||
        event.type === 'foregroundWindow' ||
        event.type === 'runtimeError'
      ) {
        this.handleHotkeyEvent(event)
      }
    })
    overlaySupervisor.onEvent((event) => {
      if (
        event.type === 'input' ||
        event.type === 'foregroundWindow' ||
        event.type === 'runtimeError'
      ) {
        this.handleOverlayEvent(event)
      }
    })
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
          if (kind === 'both') {
            void Effect.runPromise(
              Effect.all(
                [this.restore('hotkey'), this.restore('overlay')],
                { concurrency: 'unbounded' },
              ),
            )
          } else {
            void Effect.runPromise(this.restore(kind))
          }
        }
      }
      if (kind !== 'hotkey' && (snapshot.status === 'recovering' || snapshot.status === 'degraded')) {
        for (const listener of this.overlayListeners) listener(null)
      }
    })
  }

  isAvailable(kind: 'hotkey' | 'overlay' | 'both' = 'both') {
    if (kind === 'hotkey') return nativeRuntimeAvailable('hotkey')
    if (kind === 'overlay') return nativeRuntimeAvailable('overlay')
    return nativeRuntimeAvailable('hotkey') && nativeRuntimeAvailable('overlay')
  }
  getStatus(kind: 'hotkey' | 'overlay' | 'both' = 'both') {
    const hotkey = this.hotkeySupervisor.getSnapshot().status
    const overlay = this.overlaySupervisor.getSnapshot().status
    if (kind === 'hotkey') return hotkey
    if (kind === 'overlay') return overlay
    if (hotkey === 'degraded' || overlay === 'degraded') return 'degraded'
    if (hotkey === 'recovering' || overlay === 'recovering') return 'recovering'
    if (hotkey === 'starting' || overlay === 'starting') return 'starting'
    return hotkey === 'ready' && overlay === 'ready' ? 'ready' : 'stopped'
  }
  onStateChange(listener: (snapshot: NativeRuntimeSupervisorSnapshot) => void) {
    this.stateListeners.add(listener); return () => this.stateListeners.delete(listener)
  }

  startHotkeys(listener: (event: NativeInputEvent) => void) {
    return Effect.runPromise(this.startHotkeysEffect(listener))
  }
  startHotkeysEffect(listener: (event: NativeInputEvent) => void) {
    return Effect.suspend(() => {
      if (this.disposed) {
        return Effect.fail(
          new Error('Native hooks controller is disposed'),
        )
      }
      this.inputListeners.add(listener)
      if (this.wantsHotkeys) return Effect.void
      this.wantsHotkeys = true
      return this.requestEffect('hotkey', { type: 'startHotkeys' }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (isRetryableRuntimeLoss(error)) return
            this.wantsHotkeys = false
            this.inputListeners.delete(listener)
          })
        ),
        Effect.asVoid,
      )
    })
  }
  stopHotkeys(listener?: (event: NativeInputEvent) => void) {
    if (listener) this.inputListeners.delete(listener); else this.inputListeners.clear()
    if (this.inputListeners.size || !this.wantsHotkeys) return Promise.resolve()
    this.wantsHotkeys = false
    return Effect.runPromise(
      this.requestEffect('hotkey', { type: 'stopHotkeys' }).pipe(
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      ),
    )
  }
  startOverlay(listener: (window: OverlayForegroundWindow | null) => void) {
    return Effect.runPromise(this.startOverlayEffect(listener))
  }
  startOverlayEffect(
    listener: (window: OverlayForegroundWindow | null) => void,
  ) {
    return Effect.suspend(() => {
      if (this.disposed) {
        return Effect.fail(
          new Error('Native hooks controller is disposed'),
        )
      }
      this.overlayListeners.add(listener)
      if (this.wantsOverlay) return Effect.void
      this.wantsOverlay = true
      return this.requestEffect('overlay', { type: 'startOverlay' }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (isRetryableRuntimeLoss(error)) return
            this.wantsOverlay = false
            this.overlayListeners.delete(listener)
          })
        ),
        Effect.asVoid,
      )
    })
  }
  stopOverlay(listener?: (window: OverlayForegroundWindow | null) => void) {
    if (listener) this.overlayListeners.delete(listener); else this.overlayListeners.clear()
    if (this.overlayListeners.size || !this.wantsOverlay) return Promise.resolve()
    this.wantsOverlay = false
    return Effect.runPromise(
      this.requestEffect('overlay', { type: 'stopOverlay' }).pipe(
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      ),
    )
  }
  dispose() {
    return Effect.runPromise(this.disposeEffect())
  }
  disposeEffect() {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.void
      this.disposed = true
      this.inputListeners.clear()
      this.overlayListeners.clear()
      this.stateListeners.clear()
      return Effect.all(
        [
          this.hotkeySupervisor.shutdownEffect(),
          this.overlaySupervisor === this.hotkeySupervisor
            ? Effect.void
            : this.overlaySupervisor.shutdownEffect(),
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.asVoid)
    })
  }
  private handleHotkeyEvent(event: HooksRuntimeEvent) {
    if (event.type === 'input') for (const listener of this.inputListeners) listener(event.input)
    else if (event.type === 'runtimeError') console.warn('[native-hotkey]', event.error.code, event.error.message)
  }
  private handleOverlayEvent(event: HooksRuntimeEvent) {
    if (event.type === 'foregroundWindow') for (const listener of this.overlayListeners) listener(event.window)
    else if (event.type === 'runtimeError') console.warn('[native-overlay]', event.error.code, event.error.message)
  }
  private requestEffect(kind: 'hotkey' | 'overlay', command: HooksRuntimeCommand) {
    return Effect.suspend(() => {
      if (this.disposed) {
        return Effect.fail(new Error('Native hooks controller is disposed'))
      }
      if (!this.isAvailable(kind)) {
        return Effect.fail(
          new Error(`Native ${kind} runtime is not available`),
        )
      }
      const supervisor =
        kind === 'hotkey' ? this.hotkeySupervisor : this.overlaySupervisor
      return supervisor.requestEffect(command, REQUEST_TIMEOUT_MS)
    })
  }

  private restore(kind: 'hotkey' | 'overlay') {
    if (kind === 'hotkey' && this.wantsHotkeys) {
      return this.requestEffect(kind, { type: 'startHotkeys' }).pipe(
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      )
    }
    if (kind === 'overlay' && this.wantsOverlay) {
      return this.requestEffect(kind, { type: 'startOverlay' }).pipe(
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      )
    }
    return Effect.void
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
