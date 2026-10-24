import type {
  ActivityInstance,
  GatewayServerEvent,
} from '@syrnike13/api-types/gateway-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ActivityRequestError,
  ActivityStore,
  type ActivityGateway,
  type ActivityInstanceEvent,
} from './activity-store'

class FakeGateway implements ActivityGateway {
  state = 'connected'
  sent: Array<Record<string, unknown>> = []
  reliable: Array<Record<string, unknown>> = []
  #events = new Set<(event: GatewayServerEvent) => void>()
  #states = new Set<(state: string) => void>()

  send(event: Record<string, unknown>) {
    this.sent.push(event)
  }

  sendReliable(event: Record<string, unknown>) {
    this.reliable.push(event)
  }

  subscribeServerEvents(listener: (event: GatewayServerEvent) => void) {
    this.#events.add(listener)
    return () => this.#events.delete(listener)
  }

  subscribeState(listener: (state: string) => void) {
    this.#states.add(listener)
    listener(this.state)
    return () => this.#states.delete(listener)
  }

  emit(event: GatewayServerEvent) {
    this.#events.forEach((listener) => listener(event))
  }

  setState(state: string) {
    this.state = state
    this.#states.forEach((listener) => listener(state))
  }

  lastRequestId(list: 'sent' | 'reliable' = 'sent') {
    const event = this[list].at(-1)
    return String(event?.request_id)
  }
}

function instance(overrides: Partial<ActivityInstance> = {}): ActivityInstance {
  return {
    id: 'instance-1',
    application_id: 'chess',
    channel_id: 'voice-a',
    server_id: 'server-1',
    revision: 1,
    host_id: 'alice',
    participants: [{ user_id: 'alice', joined_at: '2026-10-24T10:00:00Z' }],
    started_by: 'alice',
    started_at: '2026-10-24T10:00:00Z',
    ...overrides,
  }
}

describe('ActivityStore', () => {
  let gateway: FakeGateway
  let store: ActivityStore

  beforeEach(() => {
    gateway = new FakeGateway()
    store = new ActivityStore()
    store.setCurrentUserId('alice')
    store.attach(gateway)
  })

  afterEach(() => {
    store.detach()
    vi.useRealTimers()
  })

  it('drops instance updates older than the revision it holds', () => {
    gateway.emit({ type: 'ActivityInstanceUpdate', instance: instance({ revision: 3 }) })
    gateway.emit({
      type: 'ActivityInstanceUpdate',
      instance: instance({ revision: 2, host_id: 'bob' }),
    })
    expect(store.instanceForChannel('voice-a')?.revision).toBe(3)
    expect(store.instanceForChannel('voice-a')?.host_id).toBe('alice')

    gateway.emit({
      type: 'ActivityInstanceUpdate',
      instance: instance({ revision: 4, host_id: 'bob' }),
    })
    expect(store.instanceForChannel('voice-a')?.host_id).toBe('bob')
  })

  it('takes instances from Ready and inside Bulk', () => {
    gateway.emit({
      type: 'Bulk',
      v: [{ type: 'Ready', activities: [instance({ channel_id: 'voice-b' })] }],
    })
    expect(store.instanceForChannel('voice-b')?.id).toBe('instance-1')
    expect(store.instanceForChannel('voice-a')).toBeNull()
  })

  it('removes ended instances and ignores late updates for them', () => {
    const events: ActivityInstanceEvent[] = []
    store.subscribeInstance('instance-1', (event) => events.push(event))
    gateway.emit({ type: 'ActivityInstanceUpdate', instance: instance() })
    gateway.emit({
      type: 'ActivityInstanceEnd',
      channel_id: 'voice-a',
      instance_id: 'instance-1',
      reason: 'ended',
    })
    gateway.emit({
      type: 'ActivityInstanceUpdate',
      instance: instance({ revision: 9 }),
    })

    expect(store.instanceForChannel('voice-a')).toBeNull()
    expect(events).toEqual([{ type: 'ended', reason: 'ended' }])
  })

  it('correlates responses by request id and applies the returned instance', async () => {
    const started = store.start('voice-a', 'chess')
    expect(gateway.reliable.at(-1)).toMatchObject({
      type: 'Activity',
      request: { action: 'start', channel_id: 'voice-a', application_id: 'chess' },
    })
    gateway.emit({
      type: 'ActivityResponse',
      request_id: 'someone-else',
      instance: instance({ revision: 1 }),
    })
    gateway.emit({
      type: 'ActivityResponse',
      request_id: gateway.lastRequestId('reliable'),
      instance: instance({ revision: 2 }),
    })

    await expect(started).resolves.toMatchObject({ revision: 2 })
    expect(store.instanceForChannel('voice-a')?.revision).toBe(2)
  })

  it('rejects with the backend error code', async () => {
    const joined = store.join('voice-a', 'instance-1')
    gateway.emit({
      type: 'ActivityResponse',
      request_id: gateway.lastRequestId('reliable'),
      error: 'full',
    })
    await expect(joined).rejects.toMatchObject({ code: 'full' })
  })

  it('resolves a version conflict with the current state', async () => {
    const result = store.setState('voice-a', 'instance-1', 1, { turn: 2 })
    gateway.emit({
      type: 'ActivityResponse',
      request_id: gateway.lastRequestId(),
      error: 'version_conflict',
      state: { instance_id: 'instance-1', version: 5, data: { turn: 5 } },
    })
    await expect(result).resolves.toEqual({
      ok: false,
      state: { instance_id: 'instance-1', version: 5, data: { turn: 5 } },
    })
  })

  it('refuses realtime requests while disconnected and times out lifecycle ones', async () => {
    vi.useFakeTimers()
    gateway.setState('reconnecting')
    await expect(
      store.sendMessage('voice-a', 'instance-1', { hi: true }),
    ).rejects.toBeInstanceOf(ActivityRequestError)
    expect(gateway.sent).toHaveLength(0)

    const leaving = store.leave('voice-a', 'instance-1')
    expect(gateway.reliable).toHaveLength(1)
    const assertion = expect(leaving).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
  })

  it('dispatches messages and newer shared state to instance listeners', () => {
    const events: ActivityInstanceEvent[] = []
    store.subscribeInstance('instance-1', (event) => events.push(event))
    gateway.emit({
      type: 'ActivityMessage',
      instance_id: 'instance-1',
      from: 'bob',
      payload: { move: 'e4' },
    })
    gateway.emit({
      type: 'ActivityState',
      state: { instance_id: 'instance-1', version: 2, data: 'b' },
    })
    gateway.emit({
      type: 'ActivityState',
      state: { instance_id: 'instance-1', version: 1, data: 'a' },
    })

    expect(events).toEqual([
      { type: 'message', from: 'bob', payload: { move: 'e4' } },
      {
        type: 'state',
        state: { instance_id: 'instance-1', version: 2, data: 'b' },
      },
    ])
    expect(store.sharedState('instance-1')?.version).toBe(2)
  })

  it('re-syncs the joined instance after the gateway reconnects', () => {
    gateway.emit({ type: 'ActivityInstanceUpdate', instance: instance() })
    gateway.emit({
      type: 'ActivityInstanceUpdate',
      instance: instance({ id: 'other', channel_id: 'voice-b', participants: [] }),
    })
    gateway.setState('reconnecting')
    expect(store.status).toBe('reconnecting')
    gateway.setState('connected')

    expect(store.status).toBe('connected')
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]).toMatchObject({
      request: { action: 'sync', channel_id: 'voice-a', instance_id: 'instance-1' },
    })
  })
})
