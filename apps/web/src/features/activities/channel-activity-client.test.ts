import { describe, expect, it, vi } from 'vitest'

import {
  ChannelActivityClient,
  type ChannelActivityGateway,
} from './channel-activity-client'
import type { ChannelActivityInstance } from './channel-activity-types'

class FakeGateway implements ChannelActivityGateway {
  state = 'connected'
  readonly sent: Record<string, unknown>[] = []
  readonly reliable: Array<{
    event: Record<string, unknown>
    key?: string
  }> = []
  readonly eventListeners = new Set<(event: Record<string, unknown>) => void>()
  readonly stateListeners = new Set<(state: string) => void>()

  send(event: Record<string, unknown>) {
    this.sent.push(event)
  }

  sendReliable(event: Record<string, unknown>, key?: string) {
    this.reliable.push({ event, key })
  }

  subscribeEvents(listener: (event: Record<string, unknown>) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  subscribeState(listener: (state: string) => void) {
    this.stateListeners.add(listener)
    listener(this.state)
    return () => this.stateListeners.delete(listener)
  }

  emit(event: Record<string, unknown>) {
    this.eventListeners.forEach((listener) => listener(event))
  }

  emitState(state: string) {
    this.state = state
    this.stateListeners.forEach((listener) => listener(state))
  }
}

function instance(revision: number): ChannelActivityInstance {
  return {
    id: 'activity-1',
    generation: 1,
    application_id: 'syrnike13.shared-counter',
    channel_id: 'channel-1',
    owner_id: 'user-a',
    participant_ids: ['user-a'],
    revision,
    state: { count: revision },
    created_at: 0,
    expires_at: 7_200_000,
  }
}

describe('ChannelActivityClient', () => {
  it('synchronizes a watched voice channel and applies ordered snapshots', () => {
    const gateway = new FakeGateway()
    const client = new ChannelActivityClient(gateway)
    const listener = vi.fn()
    const unsubscribe = client.subscribe('channel-1', listener)

    expect(gateway.reliable.at(-1)?.event).toMatchObject({
      type: 'ChannelActivity',
      channel_id: 'channel-1',
      request: { action: 'sync' },
    })
    expect(gateway.reliable).toHaveLength(1)

    gateway.emit({
      type: 'ChannelActivitySnapshot',
      instance: instance(2),
    })
    gateway.emit({
      type: 'ChannelActivitySnapshot',
      instance: instance(1),
    })

    expect(client.snapshot('channel-1').instance?.revision).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(client.snapshot('channel-1').transport).toBe('connected')
    unsubscribe()
    expect(gateway.eventListeners.size).toBe(0)
  })

  it('sends commands only while the realtime gateway is connected', () => {
    const gateway = new FakeGateway()
    const client = new ChannelActivityClient(gateway)

    expect(
      client.command('channel-1', 'activity-1', { type: 'increment' }),
    ).toBe(true)
    expect(gateway.sent[0]).toMatchObject({
      type: 'ChannelActivity',
      channel_id: 'channel-1',
      request: {
        action: 'command',
        instance_id: 'activity-1',
        command: { type: 'increment' },
      },
    })

    gateway.state = 'reconnecting'
    expect(
      client.command('channel-1', 'activity-1', { type: 'increment' }),
    ).toBe(false)
    expect(gateway.sent).toHaveLength(1)
  })

  it('does not let an older-generation empty erase an active instance', () => {
    const gateway = new FakeGateway()
    const client = new ChannelActivityClient(gateway)
    const unsubscribe = client.subscribe('channel-1', () => undefined)

    gateway.emit({
      type: 'ChannelActivitySnapshot',
      instance: instance(3),
    })
    gateway.emit({
      type: 'ChannelActivityEmpty',
      request_id: 'older-sync',
      channel_id: 'channel-1',
      generation: 0,
    })

    expect(client.snapshot('channel-1').instance?.revision).toBe(3)
    unsubscribe()
  })

  it('applies an authoritative tombstone for the current generation', () => {
    const gateway = new FakeGateway()
    const client = new ChannelActivityClient(gateway)
    const unsubscribe = client.subscribe('channel-1', () => undefined)

    gateway.emit({ type: 'ChannelActivitySnapshot', instance: instance(3) })
    gateway.emit({
      type: 'ChannelActivityEmpty',
      request_id: 'current-sync',
      channel_id: 'channel-1',
      generation: 1,
    })

    expect(client.snapshot('channel-1')).toMatchObject({
      instance: null,
      generation: 1,
    })
    unsubscribe()
  })

  it('applies a newer close even when its snapshot was missed', () => {
    const gateway = new FakeGateway()
    const client = new ChannelActivityClient(gateway)
    const unsubscribe = client.subscribe('channel-1', () => undefined)

    gateway.emit({ type: 'ChannelActivitySnapshot', instance: instance(3) })
    gateway.emit({
      type: 'ChannelActivityClosed',
      channel_id: 'channel-1',
      instance_id: 'activity-2',
      generation: 2,
    })

    expect(client.snapshot('channel-1')).toMatchObject({
      instance: null,
      generation: 2,
    })
    unsubscribe()
  })

  it('does not resurrect a closed generation from a delayed snapshot', () => {
    const gateway = new FakeGateway()
    const client = new ChannelActivityClient(gateway)
    const unsubscribe = client.subscribe('channel-1', () => undefined)

    gateway.emit({ type: 'ChannelActivitySnapshot', instance: instance(2) })
    gateway.emit({
      type: 'ChannelActivityClosed',
      channel_id: 'channel-1',
      instance_id: 'activity-1',
      generation: 1,
    })
    gateway.emit({ type: 'ChannelActivitySnapshot', instance: instance(3) })

    expect(client.snapshot('channel-1')).toMatchObject({
      instance: null,
      generation: 1,
    })
    unsubscribe()
  })

  it('exposes reconnect state and requests a fresh server snapshot', () => {
    const gateway = new FakeGateway()
    const client = new ChannelActivityClient(gateway)
    const unsubscribe = client.subscribe('channel-1', () => undefined)

    gateway.emitState('reconnecting')
    expect(client.snapshot('channel-1').transport).toBe('reconnecting')
    const requestsBeforeReconnect = gateway.reliable.length

    gateway.emitState('connected')
    expect(client.snapshot('channel-1').transport).toBe('connected')
    expect(gateway.reliable).toHaveLength(requestsBeforeReconnect + 1)
    expect(gateway.reliable.at(-1)?.event).toMatchObject({
      request: { action: 'sync' },
    })

    unsubscribe()
  })
})
