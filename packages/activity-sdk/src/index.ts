import {
  LIMITS,
  PROTOCOL_TAG,
  PROTOCOL_VERSION,
  isProtocolMessage,
  type ActivityContext,
  type ActivityLayout,
  type ActivityParticipant,
  type ActivityTheme,
  type ActivityUser,
  type AuthorizationScope,
  type ConnectionStatus,
  type EndReason,
  type ErrorCode,
  type EventMap,
  type EventName,
  type HelloMessage,
  type JsonObject,
  type JsonValue,
  type Leaderboard,
  type PlayerData,
  type ProtocolError,
  type RequestMap,
  type RequestMethod,
  type Score,
  type ScoreMode,
  type SharedState,
} from './protocol'

export * from './protocol'

export class ActivityError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ActivityError'
    this.code = code
  }
}

export type ConnectOptions = {
  /** Handshake and per-request timeout in milliseconds. Default 10000. */
  readonly timeoutMs?: number
}

export type SetStateResult = { readonly ok: boolean; readonly state: SharedState }

export interface Activity {
  /** Context from the latest `ready` response. */
  readonly context: ActivityContext
  readonly user: ActivityUser
  readonly participants: readonly ActivityParticipant[]
  readonly hostId: string
  readonly isHost: boolean
  readonly state: SharedState
  readonly theme: ActivityTheme
  readonly locale: string
  readonly layout: ActivityLayout
  readonly connection: ConnectionStatus
  /** Set once the instance ended or the user left. */
  readonly endReason: EndReason | null

  on<E extends EventName>(event: E, listener: (data: EventMap[E]) => void): () => void
  send(payload: JsonValue, options?: { readonly to?: readonly string[] }): Promise<void>
  setState(data: JsonValue, expectedVersion?: number): Promise<SetStateResult>
  updateState<T extends JsonValue>(
    update: (current: T | null) => T,
    options?: { readonly maxAttempts?: number },
  ): Promise<SharedState>
  readonly playerData: {
    get(): Promise<PlayerData>
    set(data: JsonObject): Promise<PlayerData>
  }
  readonly scores: {
    submit(key: string, value: number, mode?: ScoreMode): Promise<Score>
    leaderboard(
      key: string,
      options?: { readonly limit?: number; readonly ascending?: boolean },
    ): Promise<Leaderboard>
  }
  authorize(scopes: readonly AuthorizationScope[]): Promise<{ code: string }>
  openExternalLink(url: string): Promise<boolean>
  leave(): Promise<void>
  end(): Promise<void>
  /**
   * Writes theme tokens as `--syrnike-<token>` CSS variables and
   * `color-scheme` on `target` (default `document.documentElement`) and keeps
   * them in sync with theme changes. Returns an unsubscribe function.
   */
  applyTheme(target?: HTMLElement): () => void
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_UPDATE_ATTEMPTS = 5
/** Requests that wait for the user and therefore have no timeout. */
const INTERACTIVE_METHODS: ReadonlySet<RequestMethod> = new Set(['authorize', 'openExternalLink'])

type Params<M extends RequestMethod> = RequestMap[M]['params']
type Result<M extends RequestMethod> = RequestMap[M]['result']

type Pending = {
  resolve(value: unknown): void
  reject(error: ActivityError): void
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Connects to the Activity Frame. Rejects with `unsupported` outside an iframe. */
export function connect(options: ConnectOptions = {}): Promise<Activity> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const win: Window | undefined = typeof window === 'undefined' ? undefined : window
  if (!win || !win.parent || win.parent === win) {
    return Promise.reject(new ActivityError('unsupported', 'Not running inside an Activity Frame'))
  }
  return new Client(win, timeoutMs).start()
}

class Client implements Activity {
  context!: ActivityContext
  participants: readonly ActivityParticipant[] = []
  hostId = ''
  state!: SharedState
  theme!: ActivityTheme
  locale = 'en'
  layout: ActivityLayout = 'grid'
  connection: ConnectionStatus = 'connected'
  endReason: EndReason | null = null

  private port: MessagePort | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<EventName, Set<(data: never) => void>>()
  private connected = false
  private settle: { resolve(a: Activity): void; reject(e: ActivityError): void } | null = null

  constructor(
    private readonly win: Window,
    private readonly timeoutMs: number,
  ) {}

  get user(): ActivityUser {
    return this.context.user
  }

  get isHost(): boolean {
    return this.hostId === this.context.user.id
  }

  start(): Promise<Activity> {
    return new Promise<Activity>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle = null
        this.win.removeEventListener('message', this.onWindowMessage)
        this.closePort()
        reject(new ActivityError('timeout', 'Activity Frame did not respond'))
      }, this.timeoutMs)
      this.settle = {
        resolve: (activity) => {
          clearTimeout(timer)
          resolve(activity)
        },
        reject: (error) => {
          clearTimeout(timer)
          this.win.removeEventListener('message', this.onWindowMessage)
          this.closePort()
          reject(error)
        },
      }
      this.win.addEventListener('message', this.onWindowMessage)
      const hello: HelloMessage = { tag: PROTOCOL_TAG, v: PROTOCOL_VERSION, type: 'hello' }
      this.win.parent.postMessage(hello, '*')
    })
  }

  // -------------------------------------------------------------------------
  // Transport

  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== this.win.parent) return
    if (!isProtocolMessage(event.data, 'connect')) return
    const port = event.ports?.[0]
    if (!port || this.endReason) return
    this.attachPort(port)
  }

  private attachPort(port: MessagePort): void {
    this.closePort()
    // Requests sent over the previous port will never be answered.
    this.rejectPending(new ActivityError('disconnected', 'Activity Frame reconnected'))
    this.port = port
    port.onmessage = (event) => this.onPortMessage(event.data)
    port.start()
    this.call('ready', undefined).then(
      (context) => this.applyContext(context),
      (error: ActivityError) => {
        if (this.port !== port) return
        if (this.settle) this.settle.reject(error)
      },
    )
  }

  private closePort(): void {
    if (!this.port) return
    this.port.onmessage = null
    this.port.close()
    this.port = null
  }

  private onPortMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const envelope = message as Record<string, unknown>
    if (envelope.kind === 'response' && typeof envelope.id === 'number') {
      const pending = this.pending.get(envelope.id)
      if (!pending) return
      this.pending.delete(envelope.id)
      clearTimeout(pending.timer)
      if ('error' in envelope) {
        const error = envelope.error as ProtocolError
        pending.reject(new ActivityError(error?.code ?? 'internal', error?.message))
      } else {
        pending.resolve(envelope.result)
      }
    } else if (envelope.kind === 'event' && typeof envelope.event === 'string') {
      this.onEvent(envelope.event as EventName, envelope.data as never)
    }
  }

  private call<M extends RequestMethod>(method: M, params: Params<M>): Promise<Result<M>> {
    if (this.endReason) {
      return Promise.reject(new ActivityError('instance_not_found', `Activity ${this.endReason}`))
    }
    const port = this.port
    if (!port) return Promise.reject(new ActivityError('disconnected'))
    const id = this.nextId++
    return new Promise<Result<M>>((resolve, reject) => {
      const timer = INTERACTIVE_METHODS.has(method)
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id)
            reject(new ActivityError('timeout', `Request ${method} timed out`))
          }, this.timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      port.postMessage({ kind: 'request', id, method, params })
    })
  }

  private rejectPending(error: ActivityError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  // -------------------------------------------------------------------------
  // Live state

  private applyContext(context: ActivityContext): void {
    const first = !this.connected
    const previous = first ? null : this
    const changed = {
      participants:
        !previous ||
        previous.hostId !== context.hostId ||
        !sameJson(previous.participants, context.participants),
      state: !previous || !sameJson(previous.state, context.state),
      theme: !previous || !sameJson(previous.theme, context.theme),
      locale: !previous || previous.locale !== context.locale,
      layout: !previous || previous.layout !== context.layout,
      connection: !previous || previous.connection !== 'connected',
    }
    this.context = context
    this.participants = context.participants
    this.hostId = context.hostId
    this.state = context.state
    this.theme = context.theme
    this.locale = context.locale
    this.layout = context.layout
    this.connection = 'connected'
    this.connected = true

    if (first) {
      const settle = this.settle
      this.settle = null
      settle?.resolve(this)
      return
    }
    if (changed.participants) {
      this.emit('participants', { participants: this.participants, hostId: this.hostId })
    }
    if (changed.state) this.emit('state', this.state)
    if (changed.theme) this.emit('theme', this.theme)
    if (changed.locale) this.emit('locale', { locale: this.locale })
    if (changed.layout) this.emit('layout', { layout: this.layout })
    if (changed.connection) this.emit('connection', { status: 'connected' })
  }

  private onEvent(event: EventName, data: never): void {
    if (!this.connected || this.endReason) return
    switch (event) {
      case 'participants': {
        const value = data as EventMap['participants']
        this.participants = value.participants
        this.hostId = value.hostId
        break
      }
      case 'state':
        // `advanceState` emits when the state actually moves forward.
        this.advanceState(data as EventMap['state'])
        return
      case 'theme':
        this.theme = data as EventMap['theme']
        break
      case 'locale':
        this.locale = (data as EventMap['locale']).locale
        break
      case 'layout':
        this.layout = (data as EventMap['layout']).layout
        break
      case 'connection':
        this.connection = (data as EventMap['connection']).status
        break
      case 'ended':
        // Later calls are rejected; in-flight ones still get their responses.
        this.endReason = (data as EventMap['ended']).reason
        break
      case 'message':
        break
      default:
        return
    }
    this.emit(event, data)
  }

  /** Updates the live state when `next` is newer and emits `state`. */
  private advanceState(next: SharedState): void {
    if (next.version <= this.state.version) return
    this.state = next
    this.emit('state', next)
  }

  private emit<E extends EventName>(event: E, data: EventMap[E]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      try {
        ;(listener as (data: EventMap[E]) => void)(data)
      } catch (error) {
        setTimeout(() => {
          throw error
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API

  on<E extends EventName>(event: E, listener: (data: EventMap[E]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as (data: never) => void)
    return () => {
      set.delete(listener as (data: never) => void)
    }
  }

  send(payload: JsonValue, options: { readonly to?: readonly string[] } = {}): Promise<void> {
    const sizeError = checkSize(payload, LIMITS.messageBytes, 'Message')
    if (sizeError) return Promise.reject(sizeError)
    return this.call('send', options.to ? { payload, to: options.to } : { payload })
  }

  async setState(data: JsonValue, expectedVersion?: number): Promise<SetStateResult> {
    const sizeError = checkSize(data, LIMITS.stateBytes, 'Shared state')
    if (sizeError) throw sizeError
    const result = await this.call('setState', {
      expectedVersion: expectedVersion ?? this.state.version,
      data,
    })
    this.advanceState(result.state)
    return result
  }

  async updateState<T extends JsonValue>(
    update: (current: T | null) => T,
    options: { readonly maxAttempts?: number } = {},
  ): Promise<SharedState> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_UPDATE_ATTEMPTS
    let current = this.state
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const next = update(current.version === 0 ? null : (current.data as T))
      const result = await this.setState(next, current.version)
      if (result.ok) return result.state
      current = result.state
    }
    throw new ActivityError('version_conflict', `State update failed after ${maxAttempts} attempts`)
  }

  readonly playerData = {
    get: (): Promise<PlayerData> => this.call('getPlayerData', undefined),
    set: (data: JsonObject): Promise<PlayerData> => {
      const sizeError = checkSize(data, LIMITS.playerDataBytes, 'Player data')
      if (sizeError) return Promise.reject(sizeError)
      return this.call('setPlayerData', { data })
    },
  }

  readonly scores = {
    submit: (key: string, value: number, mode: ScoreMode = 'max'): Promise<Score> => {
      if (!Number.isFinite(value)) {
        return Promise.reject(new ActivityError('invalid_request', 'Score must be a finite number'))
      }
      return this.call('submitScore', { key, value, mode })
    },
    leaderboard: (
      key: string,
      options: { readonly limit?: number; readonly ascending?: boolean } = {},
    ): Promise<Leaderboard> => this.call('getLeaderboard', { key, ...options }),
  }

  authorize(scopes: readonly AuthorizationScope[]): Promise<{ code: string }> {
    return this.call('authorize', { scopes }).then((result) => ({ code: result.code }))
  }

  openExternalLink(url: string): Promise<boolean> {
    return this.call('openExternalLink', { url }).then((result) => result.opened)
  }

  leave(): Promise<void> {
    return this.call('leave', undefined)
  }

  end(): Promise<void> {
    return this.call('end', undefined)
  }

  applyTheme(target?: HTMLElement): () => void {
    const element = target ?? this.win.document.documentElement
    const apply = (theme: ActivityTheme) => {
      for (const [token, value] of Object.entries(theme.tokens)) {
        element.style.setProperty(`--syrnike-${token}`, value)
      }
      element.style.setProperty('color-scheme', theme.mode)
    }
    apply(this.theme)
    return this.on('theme', apply)
  }
}

const encoder = new TextEncoder()

function checkSize(value: JsonValue, limit: number, label: string): ActivityError | null {
  const json = JSON.stringify(value)
  if (json === undefined) return new ActivityError('invalid_request', `${label} is not JSON`)
  const bytes = encoder.encode(json).length
  if (bytes <= limit) return null
  return new ActivityError('payload_too_large', `${label} is ${bytes} bytes, limit is ${limit}`)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
