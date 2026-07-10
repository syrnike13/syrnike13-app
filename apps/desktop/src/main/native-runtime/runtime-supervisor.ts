import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NATIVE_RUNTIME_MAX_PENDING_REQUESTS,
  isNativeRuntimeMessage,
  nativeRuntimeError,
  redactSensitiveText,
  type NativeRuntimeCommand,
  type NativeRuntimeError,
  type NativeRuntimeEvent,
  type NativeRuntimeKind,
  type NativeRuntimeReady,
  type NativeRuntimeRequest,
} from './contract'
import type {
  NativeRuntimeAdapter,
  NativeRuntimeAdapterExit,
  NativeRuntimeAdapterFactory,
} from './utility-adapter'

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000
const RESTART_DELAYS_MS = [250, 1_000, 5_000] as const
const CRASH_WINDOW_MS = 60_000

export type NativeRuntimeSupervisorStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'recovering'
  | 'degraded'

export type NativeRuntimeSupervisorSnapshot = {
  runtime: NativeRuntimeKind
  status: NativeRuntimeSupervisorStatus
  pid?: number
  restartCount: number
  degradedReason?: string
  lastFailure?: string
  ready?: NativeRuntimeReady
}

export class NativeRuntimeRequestError extends Error {
  constructor(readonly detail: NativeRuntimeError) {
    super(detail.message)
    this.name = 'NativeRuntimeRequestError'
  }
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

export type NativeRuntimeSupervisorOptions = {
  runtime: NativeRuntimeKind
  createAdapter: NativeRuntimeAdapterFactory
  handshakeTimeoutMs?: number
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
}

export class NativeRuntimeSupervisor {
  private adapter: NativeRuntimeAdapter | null = null
  private snapshot: NativeRuntimeSupervisorSnapshot
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: NativeRuntimeEvent) => void>()
  private readonly stateListeners = new Set<
    (snapshot: NativeRuntimeSupervisorSnapshot) => void
  >()
  private startPromise: Promise<NativeRuntimeReady> | null = null
  private resolveStart: ((ready: NativeRuntimeReady) => void) | null = null
  private rejectStart: ((error: Error) => void) | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private crashTimes: number[] = []
  private expectedExit = false
  private requestSequence = 0

  constructor(private readonly options: NativeRuntimeSupervisorOptions) {
    this.snapshot = {
      runtime: options.runtime,
      status: 'stopped',
      restartCount: 0,
    }
  }

  getSnapshot() {
    return { ...this.snapshot }
  }

  onEvent(listener: (event: NativeRuntimeEvent) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: (snapshot: NativeRuntimeSupervisorSnapshot) => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  start() {
    if (this.snapshot.status === 'ready' && this.snapshot.ready) {
      return Promise.resolve(this.snapshot.ready)
    }
    if (this.startPromise) return this.startPromise
    if (this.snapshot.status === 'degraded') {
      return Promise.reject(
        new NativeRuntimeRequestError(
          nativeRuntimeError(
            'runtime_degraded',
            this.snapshot.degradedReason ?? 'Native runtime is degraded',
          ),
        ),
      )
    }

    this.expectedExit = false
    this.updateSnapshot({
      status: this.snapshot.restartCount > 0 ? 'recovering' : 'starting',
      degradedReason: undefined,
      lastFailure: undefined,
      ready: undefined,
    })
    const startPromise = new Promise<NativeRuntimeReady>((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
    })
    this.startPromise = startPromise

    let adapter: NativeRuntimeAdapter
    try {
      adapter = this.options.createAdapter()
      this.adapter = adapter
      this.handshakeTimer = setTimeout(
        () => this.failHandshake('Native runtime handshake timed out'),
        this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      )
      adapter.start({
        onMessage: (message) => this.handleMessage(adapter, message),
        onExit: (exit) => this.handleExit(adapter, exit),
      })
      this.updateSnapshot({ pid: adapter.pid })
    } catch (error) {
      this.failHandshake(
        error instanceof Error ? error.message : 'Native runtime failed to start',
      )
    }
    return startPromise
  }

  async request<T = unknown>(
    command: NativeRuntimeCommand,
    timeoutMs: number,
  ): Promise<T> {
    await this.start()
    if (!this.adapter || this.snapshot.status !== 'ready') {
      throw new NativeRuntimeRequestError(
        nativeRuntimeError('runtime_lost', 'Native runtime is not ready', {
          retryable: true,
        }),
      )
    }
    if (this.pending.size >= NATIVE_RUNTIME_MAX_PENDING_REQUESTS) {
      throw new NativeRuntimeRequestError(
        nativeRuntimeError('queue_full', 'Native runtime command queue is full', {
          retryable: true,
        }),
      )
    }

    const requestId = `${this.options.runtime}-${++this.requestSequence}-${crypto.randomUUID()}`
    const request: NativeRuntimeRequest = { type: 'request', requestId, command }
    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        const error = new NativeRuntimeRequestError(
          nativeRuntimeError('request_timeout', 'Native runtime request timed out', {
            retryable: true,
          }),
        )
        reject(error)
        this.recycleHungAdapter(error.message)
      }, timeoutMs)
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })
    })

    try {
      this.adapter.postMessage(request)
    } catch (error) {
      const message =
        error instanceof Error
          ? redactSensitiveText(error.message)
          : 'Native runtime is unavailable'
      this.rejectPending(
        requestId,
        new NativeRuntimeRequestError(
          nativeRuntimeError('runtime_lost', message, { retryable: true }),
        ),
      )
      // A failed structured-clone send means this transport can no longer be
      // trusted even if Electron has not delivered its exit event yet.
      this.recycleHungAdapter(message)
    }
    return result
  }

  retry() {
    if (this.snapshot.status !== 'degraded') return this.start()
    this.crashTimes = []
    this.updateSnapshot({
      status: 'stopped',
      // Keep this epoch monotonic so controllers can distinguish a manual
      // circuit reset from the host instance that just degraded.
      restartCount: this.snapshot.restartCount + 1,
      degradedReason: undefined,
      lastFailure: undefined,
    })
    return this.start()
  }

  async shutdown() {
    this.expectedExit = true
    this.clearRestartTimer()
    const adapter = this.adapter
    if (adapter && this.snapshot.status === 'ready') {
      let stopListening = () => {}
      let timeout: ReturnType<typeof setTimeout> | null = null
      const exited = new Promise<void>((resolve) => {
        stopListening = this.onStateChange((snapshot) => {
          if (snapshot.status !== 'stopped') return
          stopListening()
          resolve()
        })
      })
      try {
        await Promise.race([
          Promise.all([
            this.request({ type: 'shutdown' }, 2_000).catch(() => undefined),
            exited,
          ]),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 2_000)
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
        stopListening()
      }
    }
    if (adapter && this.adapter === adapter) {
      adapter.kill()
      this.adapter = null
    }
    this.rejectAllPending('runtime_stopped', 'Native runtime stopped')
    this.clearHandshake()
    this.rejectStart?.(
      new NativeRuntimeRequestError(
        nativeRuntimeError('runtime_stopped', 'Native runtime stopped'),
      ),
    )
    this.clearStartPromise()
    this.updateSnapshot({
      status: 'stopped',
      pid: undefined,
      ready: undefined,
      degradedReason: undefined,
    })
  }

  private handleMessage(adapter: NativeRuntimeAdapter, message: unknown) {
    if (this.adapter !== adapter || !isNativeRuntimeMessage(message)) return
    if (message.type === 'ready') {
      if (
        message.runtime !== this.options.runtime ||
        message.contractVersion !== NATIVE_RUNTIME_CONTRACT_VERSION
      ) {
        const reason =
          message.runtime !== this.options.runtime
            ? `Native runtime kind mismatch (expected ${this.options.runtime}, received ${message.runtime})`
            : `Native runtime contract mismatch (expected ${NATIVE_RUNTIME_CONTRACT_VERSION}, received ${message.contractVersion})`
        this.degrade(
          reason,
        )
        return
      }
      this.clearHandshake()
      this.updateSnapshot({
        status: 'ready',
        pid: adapter.pid,
        ready: message,
        degradedReason: undefined,
      })
      this.resolveStart?.(message)
      this.clearStartPromise()
      return
    }
    if (message.type === 'reply') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId)
      clearTimeout(pending.timeout)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new NativeRuntimeRequestError(message.error))
      return
    }
    for (const listener of this.eventListeners) listener(message.event)
  }

  private handleExit(adapter: NativeRuntimeAdapter, exit: NativeRuntimeAdapterExit) {
    if (this.adapter !== adapter) return
    this.adapter = null
    this.clearHandshake()
    const message = exit.error
      ? redactSensitiveText(exit.error.message)
      : `Native runtime exited (${exit.code ?? 'unknown'})`
    this.rejectStart?.(
      new NativeRuntimeRequestError(
        nativeRuntimeError('runtime_lost', message, { retryable: true }),
      ),
    )
    this.clearStartPromise()
    this.rejectAllPending('runtime_lost', message)
    if (this.expectedExit) {
      this.updateSnapshot({ status: 'stopped', pid: undefined, ready: undefined })
      return
    }
    this.scheduleRestart(message)
  }

  private scheduleRestart(reason: string) {
    const now = (this.options.now ?? Date.now)()
    this.crashTimes = this.crashTimes.filter((time) => now - time <= CRASH_WINDOW_MS)
    this.crashTimes.push(now)
    if (this.crashTimes.length >= 3) {
      this.degrade(reason)
      return
    }
    const restartCount = this.snapshot.restartCount + 1
    this.updateSnapshot({
      status: 'recovering',
      pid: undefined,
      ready: undefined,
      restartCount,
      lastFailure: redactSensitiveText(reason),
    })
    const delay = RESTART_DELAYS_MS[Math.min(restartCount - 1, RESTART_DELAYS_MS.length - 1)]
    const schedule = this.options.schedule ?? setTimeout
    this.restartTimer = schedule(() => {
      this.restartTimer = null
      void this.start().catch(() => {})
    }, delay)
  }

  private failHandshake(message: string) {
    const adapter = this.adapter
    this.adapter = null
    adapter?.kill()
    this.clearHandshake()
    const error = new NativeRuntimeRequestError(
      nativeRuntimeError('handshake_failed', redactSensitiveText(message), {
        retryable: true,
      }),
    )
    this.rejectStart?.(error)
    this.clearStartPromise()
    this.scheduleRestart(error.message)
  }

  private degrade(reason: string) {
    this.expectedExit = true
    this.adapter?.kill()
    this.adapter = null
    this.clearHandshake()
    this.clearRestartTimer()
    this.rejectStart?.(
      new NativeRuntimeRequestError(
        nativeRuntimeError('runtime_degraded', redactSensitiveText(reason)),
      ),
    )
    this.clearStartPromise()
    this.rejectAllPending('runtime_degraded', reason)
    this.updateSnapshot({
      status: 'degraded',
      pid: undefined,
      ready: undefined,
      degradedReason: redactSensitiveText(reason),
    })
  }

  private rejectPending(requestId: string, error: Error) {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    pending.reject(error)
  }

  private recycleHungAdapter(reason: string) {
    const adapter = this.adapter
    if (!adapter) return
    this.adapter = null
    adapter.kill()
    this.rejectAllPending('runtime_lost', reason)
    if (this.expectedExit) {
      this.updateSnapshot({
        status: 'stopped',
        pid: undefined,
        ready: undefined,
      })
      return
    }
    this.scheduleRestart(reason)
  }

  private rejectAllPending(code: string, message: string) {
    const error = new NativeRuntimeRequestError(
      nativeRuntimeError(code, redactSensitiveText(message), { retryable: true }),
    )
    for (const requestId of Array.from(this.pending.keys())) {
      this.rejectPending(requestId, error)
    }
  }

  private clearHandshake() {
    if (!this.handshakeTimer) return
    clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  private clearRestartTimer() {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private clearStartPromise() {
    this.startPromise = null
    this.resolveStart = null
    this.rejectStart = null
  }

  private updateSnapshot(patch: Partial<NativeRuntimeSupervisorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    const snapshot = this.getSnapshot()
    for (const listener of this.stateListeners) listener(snapshot)
  }
}
