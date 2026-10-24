import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ActivityError,
  LIMITS,
  PROTOCOL_TAG,
  PROTOCOL_VERSION,
  connect,
  type ActivityContext,
  type EventMap,
  type EventName,
  type ProtocolError,
  type RequestEnvelope,
  type SharedState,
} from './index'

const CONNECT = { tag: PROTOCOL_TAG, v: PROTOCOL_VERSION, type: 'connect' } as const

const alice = { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null }
const bob = { id: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null }

function makeContext(overrides: Partial<ActivityContext> = {}): ActivityContext {
  return {
    protocolVersion: PROTOCOL_VERSION,
    application: { id: 'app', name: 'App' },
    instance: { id: 'i1', channelId: 'c1', serverId: 's1' },
    user: alice,
    participants: [{ ...alice, joinedAt: '2026-01-01T00:00:00Z' }],
    hostId: alice.id,
    state: { version: 0, data: null, updatedBy: null },
    locale: 'en',
    theme: { mode: 'dark', tokens: { background: '#000', foreground: '#fff' } },
    layout: 'grid',
    ...overrides,
  }
}

type Handler = (request: RequestEnvelope) => { result: unknown } | { error: ProtocolError } | null

/** Fake Activity Frame: a parent window plus the frame end of each port. */
class FakeFrame {
  readonly parent = { postMessage: vi.fn() }
  readonly requests: RequestEnvelope[] = []
  readonly style = new Map<string, string>()
  handlers: Partial<Record<string, Handler>> = {}
  context = makeContext()
  private readonly windowListeners = new Set<(event: unknown) => void>()
  private ports: MessagePort[] = []
  framePort: MessagePort | null = null

  readonly window = {
    parent: this.parent,
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      this.windowListeners.add(listener),
    removeEventListener: (_type: string, listener: (event: unknown) => void) =>
      this.windowListeners.delete(listener),
    document: {
      documentElement: {
        style: { setProperty: (name: string, value: string) => this.style.set(name, value) },
      },
    },
  }

  dispatch(data: unknown, source: unknown, ports: MessagePort[] = []): void {
    for (const listener of [...this.windowListeners]) listener({ data, source, ports })
  }

  /** Opens a new port pair and hands one end to the SDK. */
  connect(source: unknown = this.parent): MessagePort {
    const channel = new MessageChannel()
    this.ports.push(channel.port1, channel.port2)
    this.framePort = channel.port1
    channel.port1.onmessage = (event: MessageEvent) => this.onRequest(channel.port1, event.data)
    this.dispatch(CONNECT, source, [channel.port2])
    return channel.port1
  }

  emit<E extends EventName>(event: E, data: EventMap[E]): void {
    this.framePort?.postMessage({ kind: 'event', event, data })
  }

  private onRequest(port: MessagePort, request: RequestEnvelope): void {
    this.requests.push(request)
    const handler =
      this.handlers[request.method] ??
      (request.method === 'ready' ? () => ({ result: this.context }) : null)
    const reply = handler?.(request)
    if (reply) port.postMessage({ kind: 'response', id: request.id, ...reply })
  }

  close(): void {
    for (const port of this.ports) port.close()
  }
}

let frame: FakeFrame

function install(): FakeFrame {
  frame = new FakeFrame()
  ;(globalThis as { window?: unknown }).window = frame.window
  return frame
}

async function connected(timeoutMs?: number) {
  const fake = install()
  const promise = connect({ timeoutMs })
  fake.connect()
  return { fake, activity: await promise }
}

function nextEvent<E extends EventName>(
  activity: Awaited<ReturnType<typeof connect>>,
  event: E,
): Promise<EventMap[E]> {
  return new Promise((resolve) => {
    const off = activity.on(event, (data) => {
      off()
      resolve(data)
    })
  })
}

afterEach(() => {
  frame?.close()
  delete (globalThis as { window?: unknown }).window
  vi.useRealTimers()
})

describe('connect', () => {
  it('rejects outside an iframe', async () => {
    const win: Record<string, unknown> = {}
    win.parent = win
    ;(globalThis as { window?: unknown }).window = win
    await expect(connect()).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('sends hello and resolves with the ready context', async () => {
    const { fake, activity } = await connected()
    expect(fake.parent.postMessage).toHaveBeenCalledWith(
      { tag: PROTOCOL_TAG, v: PROTOCOL_VERSION, type: 'hello' },
      '*',
    )
    expect(fake.requests[0]).toMatchObject({ kind: 'request', method: 'ready' })
    expect(activity.user).toEqual(alice)
    expect(activity.isHost).toBe(true)
    expect(activity.locale).toBe('en')
    expect(activity.connection).toBe('connected')
  })

  it('ignores connect messages that do not come from the parent', async () => {
    const fake = install()
    const promise = connect({ timeoutMs: 200 })
    fake.connect({ postMessage() {} })
    await expect(promise).rejects.toMatchObject({ code: 'timeout' })
    expect(fake.requests).toHaveLength(0)
  })

  it('times out without a frame', async () => {
    install()
    await expect(connect({ timeoutMs: 50 })).rejects.toBeInstanceOf(ActivityError)
  })
})

describe('requests', () => {
  it('resolves responses by id and maps error envelopes', async () => {
    const { fake, activity } = await connected()
    fake.handlers.submitScore = (request) => ({
      result: { user: alice, value: (request.params as { value: number }).value, trusted: false, updatedAt: 'now' },
    })
    fake.handlers.getPlayerData = () => ({ error: { code: 'rate_limited', message: 'slow down' } })

    await expect(activity.scores.submit('k', 42)).resolves.toMatchObject({ value: 42 })
    expect(fake.requests.at(-1)?.params).toEqual({ key: 'k', value: 42, mode: 'max' })

    const error = await activity.playerData.get().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ActivityError)
    expect(error).toMatchObject({ code: 'rate_limited', message: 'slow down' })
  })

  it('times out unanswered requests', async () => {
    const { fake, activity } = await connected(100)
    fake.handlers.send = () => null
    await expect(activity.send({ hi: 1 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects oversized payloads without sending', async () => {
    const { fake, activity } = await connected()
    const big = 'x'.repeat(LIMITS.messageBytes)
    await expect(activity.send(big)).rejects.toMatchObject({ code: 'payload_too_large' })
    await expect(activity.playerData.set({ big })).rejects.toMatchObject({
      code: 'payload_too_large',
    })
    expect(fake.requests.map((r) => r.method)).toEqual(['ready'])
  })

  it('rejects calls after ended', async () => {
    const { fake, activity } = await connected()
    const ended = nextEvent(activity, 'ended')
    fake.emit('ended', { reason: 'ended' })
    await ended
    expect(activity.endReason).toBe('ended')
    await expect(activity.send(1)).rejects.toMatchObject({ code: 'instance_not_found' })
  })
})

describe('events', () => {
  it('updates live state before listeners run', async () => {
    const { fake, activity } = await connected()
    const seen: unknown[] = []
    activity.on('participants', () => seen.push([activity.hostId, activity.isHost]))
    activity.on('layout', () => seen.push(activity.layout))
    const participants = [{ ...bob, joinedAt: '2026-01-01T00:00:01Z' }]
    fake.emit('participants', { participants, hostId: bob.id })
    fake.emit('layout', { layout: 'mini' })
    await nextEvent(activity, 'layout')
    expect(seen).toEqual([[bob.id, false], 'mini'])
    expect(activity.participants).toEqual(participants)
  })

  it('ignores stale state events', async () => {
    const { fake, activity } = await connected()
    const states: number[] = []
    activity.on('state', (state) => states.push(state.version))
    fake.emit('state', { version: 2, data: 'b', updatedBy: bob.id })
    fake.emit('state', { version: 1, data: 'a', updatedBy: bob.id })
    fake.emit('locale', { locale: 'ru' })
    await nextEvent(activity, 'locale')
    expect(states).toEqual([2])
    expect(activity.state.data).toBe('b')
  })

  it('applyTheme writes CSS variables and follows theme events', async () => {
    const { fake, activity } = await connected()
    const off = activity.applyTheme()
    expect(fake.style.get('--syrnike-background')).toBe('#000')
    expect(fake.style.get('color-scheme')).toBe('dark')
    fake.emit('theme', { mode: 'light', tokens: { background: '#fff' } })
    await nextEvent(activity, 'theme')
    expect(fake.style.get('--syrnike-background')).toBe('#fff')
    expect(fake.style.get('color-scheme')).toBe('light')
    off()
  })
})

describe('reconnect', () => {
  it('replaces the port, re-issues ready and emits changes', async () => {
    const { fake, activity } = await connected()
    const oldPort = fake.framePort!
    fake.handlers.leave = () => null
    const pendingLeave = activity.leave()

    fake.context = makeContext({
      hostId: bob.id,
      layout: 'focus',
      state: { version: 3, data: { n: 3 }, updatedBy: bob.id },
    })
    const stateEvent = nextEvent(activity, 'state')
    const layoutEvent = nextEvent(activity, 'layout')
    const localeSpy = vi.fn()
    activity.on('locale', localeSpy)
    fake.connect()

    await expect(pendingLeave).rejects.toMatchObject({ code: 'disconnected' })
    expect((await stateEvent).version).toBe(3)
    expect(await layoutEvent).toEqual({ layout: 'focus' })
    expect(localeSpy).not.toHaveBeenCalled()
    expect(activity.isHost).toBe(false)
    expect(fake.framePort).not.toBe(oldPort)
    expect(fake.requests.filter((r) => r.method === 'ready')).toHaveLength(2)
  })
})

describe('shared state', () => {
  it('setState defaults expectedVersion to the current version', async () => {
    const { fake, activity } = await connected()
    fake.handlers.setState = (request) => {
      const params = request.params as { expectedVersion: number; data: unknown }
      return {
        result: {
          ok: true,
          state: { version: params.expectedVersion + 1, data: params.data, updatedBy: alice.id },
        },
      }
    }
    const result = await activity.setState({ a: 1 })
    expect(fake.requests.at(-1)?.params).toEqual({ expectedVersion: 0, data: { a: 1 } })
    expect(result.ok).toBe(true)
    expect(activity.state.version).toBe(1)
  })

  it('updateState retries on conflict', async () => {
    const { fake, activity } = await connected()
    let server: SharedState = { version: 5, data: { count: 10 }, updatedBy: bob.id }
    let conflicts = 1
    fake.handlers.setState = (request) => {
      const params = request.params as { expectedVersion: number; data: never }
      if (conflicts > 0 || params.expectedVersion !== server.version) {
        conflicts--
        return { result: { ok: false, state: server } }
      }
      server = { version: server.version + 1, data: params.data, updatedBy: alice.id }
      return { result: { ok: true, state: server } }
    }
    const seen: (number | null)[] = []
    const state = await activity.updateState<{ count: number }>((current) => {
      seen.push(current?.count ?? null)
      return { count: (current?.count ?? 0) + 1 }
    })
    expect(seen).toEqual([null, 10])
    expect(state).toEqual({ version: 6, data: { count: 11 }, updatedBy: alice.id })
    expect(activity.state).toEqual(state)
  })

  it('updateState gives up after maxAttempts', async () => {
    const { fake, activity } = await connected()
    fake.handlers.setState = () => ({
      result: { ok: false, state: { version: 99, data: 1, updatedBy: bob.id } },
    })
    await expect(activity.updateState(() => 1, { maxAttempts: 2 })).rejects.toMatchObject({
      code: 'version_conflict',
    })
    expect(fake.requests.filter((r) => r.method === 'setState')).toHaveLength(2)
  })
})
