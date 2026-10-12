import { createRequire } from 'node:module'
import path from 'node:path'

import type { NativeInputEvent } from '@syrnike13/platform'
import { app } from 'electron'
import { Effect } from 'effect'

const REQUEST_TIMEOUT_MS = 5_000

export type NativeHooksError = {
  code: string
  message: string
  stage?: string
  retryable: boolean
}

export type OverlayForegroundWindow = {
  pid: number
  processName: string
  processPath: string | null
  title: string
  className: string
  visible: boolean
  fullscreenLike: boolean
  bounds: { x: number; y: number; width: number; height: number }
} | null

type HooksCommandType = 'startHotkeys' | 'stopHotkeys' | 'startOverlay' | 'stopOverlay'

export type NativeHooksEvent =
  | { type: 'reply'; requestId: string; ok: boolean; error?: NativeHooksError }
  | { type: 'input'; sequence: number; input: NativeInputEvent }
  | { type: 'foregroundWindow'; sequence: number; window: OverlayForegroundWindow }
  | { type: 'runtimeError'; sequence: number; error: NativeHooksError }

export type NativeHooksRuntime = {
  dispatch(command: { type: HooksCommandType; requestId: string }): void
  shutdown(): Promise<void>
}

export type NativeHooksAddon = {
  createHooksRuntime(emit: (event: NativeHooksEvent) => void): NativeHooksRuntime
}

/**
 * Global input and foreground-window hooks, loaded in the main process. The
 * hooks run on the addon's own message-loop thread, so a busy main thread does
 * not delay the low-level hook callbacks.
 */
export class HooksRuntimeController {
  private runtime: NativeHooksRuntime | null = null
  private unavailable = false
  private disposed = false
  private nextRequest = 0
  private readonly pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly inputListeners = new Set<(event: NativeInputEvent) => void>()
  private readonly overlayListeners = new Set<(window: OverlayForegroundWindow) => void>()
  private readonly errorListeners = new Set<(error: NativeHooksError) => void>()
  private wantsHotkeys = false
  private wantsOverlay = false

  constructor(
    private readonly loadAddon: () => NativeHooksAddon,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  isAvailable() {
    return this.ensureRuntime() !== null
  }

  isRunning(kind: 'hotkey' | 'overlay') {
    return this.runtime !== null && (kind === 'hotkey' ? this.wantsHotkeys : this.wantsOverlay)
  }

  onRuntimeError(listener: (error: NativeHooksError) => void) {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  startHotkeysEffect(listener: (event: NativeInputEvent) => void) {
    return this.startEffect(this.inputListeners, listener, 'hotkey')
  }

  stopHotkeys(listener?: (event: NativeInputEvent) => void) {
    return this.stop(this.inputListeners, listener, 'hotkey')
  }

  startOverlayEffect(listener: (window: OverlayForegroundWindow) => void) {
    return this.startEffect(this.overlayListeners, listener, 'overlay')
  }

  stopOverlay(listener?: (window: OverlayForegroundWindow) => void) {
    return this.stop(this.overlayListeners, listener, 'overlay')
  }

  disposeEffect() {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.void
      this.disposed = true
      this.inputListeners.clear()
      this.overlayListeners.clear()
      this.errorListeners.clear()
      for (const [requestId, request] of this.pending) {
        clearTimeout(request.timer)
        request.reject(new Error('Native hooks runtime is shutting down'))
        this.pending.delete(requestId)
      }
      const runtime = this.runtime
      this.runtime = null
      if (!runtime) return Effect.void
      return Effect.tryPromise(() => runtime.shutdown()).pipe(Effect.ignore)
    })
  }

  private startEffect<T>(listeners: Set<T>, listener: T, kind: 'hotkey' | 'overlay') {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.fail(new Error('Native hooks runtime is disposed'))
      listeners.add(listener)
      if (kind === 'hotkey' ? this.wantsHotkeys : this.wantsOverlay) return Effect.void
      this.setWanted(kind, true)
      return this.requestEffect(kind === 'hotkey' ? 'startHotkeys' : 'startOverlay').pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.setWanted(kind, false)
            listeners.delete(listener)
          })
        ),
      )
    })
  }

  private stop<T>(listeners: Set<T>, listener: T | undefined, kind: 'hotkey' | 'overlay') {
    if (listener) listeners.delete(listener)
    else listeners.clear()
    const wanted = kind === 'hotkey' ? this.wantsHotkeys : this.wantsOverlay
    if (listeners.size || !wanted) return Promise.resolve()
    this.setWanted(kind, false)
    return Effect.runPromise(
      this.requestEffect(kind === 'hotkey' ? 'stopHotkeys' : 'stopOverlay').pipe(Effect.ignore),
    )
  }

  private setWanted(kind: 'hotkey' | 'overlay', value: boolean) {
    if (kind === 'hotkey') this.wantsHotkeys = value
    else this.wantsOverlay = value
  }

  private requestEffect(type: HooksCommandType) {
    return Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const runtime = this.ensureRuntime()
          if (!runtime) {
            reject(new Error('Native hooks runtime is not available'))
            return
          }
          const requestId = String(++this.nextRequest)
          const timer = setTimeout(() => {
            this.pending.delete(requestId)
            reject(new Error(`Native hooks ${type} timed out`))
          }, REQUEST_TIMEOUT_MS)
          this.pending.set(requestId, { resolve, reject, timer })
          try {
            runtime.dispatch({ type, requestId })
          } catch (error) {
            clearTimeout(timer)
            this.pending.delete(requestId)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
  }

  private ensureRuntime() {
    if (this.runtime || this.unavailable || this.disposed) return this.runtime
    if (this.platform !== 'win32') {
      this.unavailable = true
      return null
    }
    try {
      this.runtime = this.loadAddon().createHooksRuntime((event) => this.handleEvent(event))
    } catch (error) {
      this.unavailable = true
      console.warn(
        '[native-hooks] unavailable',
        error instanceof Error ? error.message : 'unknown error',
      )
    }
    return this.runtime
  }

  private handleEvent(event: NativeHooksEvent) {
    switch (event.type) {
      case 'reply': {
        const request = this.pending.get(event.requestId)
        if (!request) return
        this.pending.delete(event.requestId)
        clearTimeout(request.timer)
        if (event.ok) request.resolve()
        else request.reject(new Error(event.error?.message ?? 'Native hooks command failed'))
        return
      }
      case 'input':
        for (const listener of this.inputListeners) listener(event.input)
        return
      case 'foregroundWindow':
        for (const listener of this.overlayListeners) listener(event.window)
        return
      case 'runtimeError':
        console.warn('[native-hooks]', event.error.code, event.error.message)
        for (const listener of this.errorListeners) listener(event.error)
        return
    }
  }
}

function nativeHooksModulePath() {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'win32-x64')
    : path.resolve(app.getAppPath(), 'out', 'native', 'win32-x64')
  return path.join(root, 'syrnike_hooks.node')
}

export const hooksRuntimeController = new HooksRuntimeController(() => {
  const filename = nativeHooksModulePath()
  return createRequire(filename)(filename) as NativeHooksAddon
})
