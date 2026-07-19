import { eventsGateway } from '#/features/events/gateway'

import {
  isChannelActivityErrorCode,
  isChannelActivityInstance,
  type ChannelActivityInstance,
  type ChannelActivityViewState,
} from './channel-activity-types'

type GatewayEvent = Readonly<{
  type?: string
  [key: string]: unknown
}>

export type ChannelActivityGateway = Readonly<{
  state: string
  send(event: Record<string, unknown>): void
  sendReliable(event: Record<string, unknown>, key?: string): void
  subscribeEvents(listener: (event: GatewayEvent) => void): () => void
  subscribeState(listener: (state: string) => void): () => void
}>

const EMPTY_VIEW_STATE: ChannelActivityViewState = Object.freeze({
  instance: null,
  error: null,
  transport: 'disconnected',
})

export class ChannelActivityClient {
  readonly #gateway: ChannelActivityGateway
  readonly #state = new Map<string, ChannelActivityViewState>()
  readonly #listeners = new Map<string, Set<() => void>>()
  #unsubscribeEvents: (() => void) | null = null
  #unsubscribeGatewayState: (() => void) | null = null

  constructor(gateway: ChannelActivityGateway) {
    this.#gateway = gateway
  }

  snapshot(channelId: string) {
    return this.#state.get(channelId) ?? EMPTY_VIEW_STATE
  }

  subscribe(channelId: string, listener: () => void) {
    let channelListeners = this.#listeners.get(channelId)
    if (!channelListeners) {
      channelListeners = new Set()
      this.#listeners.set(channelId, channelListeners)
    }
    channelListeners.add(listener)
    this.#setTransport(channelId, gatewayTransport(this.#gateway.state))
    const gatewayAlreadyAttached = this.#unsubscribeEvents !== null
    this.#attachGateway()
    if (gatewayAlreadyAttached && this.#gateway.state === 'connected') {
      this.sync(channelId)
    }

    return () => {
      const current = this.#listeners.get(channelId)
      current?.delete(listener)
      if (current?.size === 0) this.#listeners.delete(channelId)
      if (this.#listeners.size === 0) this.#detachGateway()
    }
  }

  sync(channelId: string) {
    const requestId = this.#requestId(channelId)
    this.#gateway.sendReliable(
      activityRequest(requestId, channelId, { action: 'sync' }),
      `channel-activity:sync:${channelId}`,
    )
  }

  start(channelId: string, applicationId: string) {
    const requestId = this.#requestId(channelId)
    this.#setError(channelId, null)
    this.#gateway.sendReliable(
      activityRequest(requestId, channelId, {
        action: 'start',
        application_id: applicationId,
      }),
      `channel-activity:start:${channelId}`,
    )
  }

  join(channelId: string, instanceId: string) {
    const requestId = this.#requestId(channelId)
    this.#setError(channelId, null)
    this.#gateway.sendReliable(
      activityRequest(requestId, channelId, {
        action: 'join',
        instance_id: instanceId,
      }),
      `channel-activity:join:${channelId}:${instanceId}`,
    )
  }

  leave(channelId: string, instanceId: string) {
    const requestId = this.#requestId(channelId)
    this.#gateway.sendReliable(
      activityRequest(requestId, channelId, {
        action: 'leave',
        instance_id: instanceId,
      }),
      `channel-activity:leave:${channelId}:${instanceId}`,
    )
  }

  close(channelId: string, instanceId: string) {
    const requestId = this.#requestId(channelId)
    this.#gateway.sendReliable(
      activityRequest(requestId, channelId, {
        action: 'close',
        instance_id: instanceId,
      }),
      `channel-activity:close:${channelId}:${instanceId}`,
    )
  }

  command(channelId: string, instanceId: string, command: unknown) {
    if (this.#gateway.state !== 'connected') return false
    const requestId = this.#requestId(channelId)
    this.#gateway.send(
      activityRequest(requestId, channelId, {
        action: 'command',
        instance_id: instanceId,
        command,
      }),
    )
    return true
  }

  #attachGateway() {
    if (this.#unsubscribeEvents) return
    this.#unsubscribeEvents = this.#gateway.subscribeEvents((event) =>
      this.#handleEvent(event),
    )
    this.#unsubscribeGatewayState = this.#gateway.subscribeState((state) => {
      const transport = gatewayTransport(state)
      for (const channelId of this.#listeners.keys()) {
        this.#setTransport(channelId, transport)
        if (state === 'connected') this.sync(channelId)
      }
    })
  }

  #detachGateway() {
    this.#unsubscribeEvents?.()
    this.#unsubscribeGatewayState?.()
    this.#unsubscribeEvents = null
    this.#unsubscribeGatewayState = null
  }

  #handleEvent(event: GatewayEvent) {
    switch (event.type) {
      case 'ChannelActivitySnapshot': {
        if (!isChannelActivityInstance(event.instance)) return
        const instance = event.instance
        const current = this.snapshot(instance.channel_id).instance
        if (
          current?.id === instance.id &&
          current.revision > instance.revision
        ) {
          return
        }
        this.#setState(instance.channel_id, {
          instance,
          error: null,
          transport: this.snapshot(instance.channel_id).transport,
        })
        break
      }
      case 'ChannelActivityEmpty': {
        if (typeof event.channel_id !== 'string') return
        if (this.snapshot(event.channel_id).instance) return
        this.#setState(event.channel_id, {
          instance: null,
          error: null,
          transport: this.snapshot(event.channel_id).transport,
        })
        break
      }
      case 'ChannelActivityClosed': {
        if (
          typeof event.channel_id !== 'string' ||
          typeof event.instance_id !== 'string'
        ) {
          return
        }
        const current = this.snapshot(event.channel_id)
        if (current.instance?.id !== event.instance_id) return
        this.#setState(event.channel_id, {
          instance: null,
          error: null,
          transport: current.transport,
        })
        break
      }
      case 'ChannelActivityError': {
        if (
          typeof event.channel_id !== 'string' ||
          !isChannelActivityErrorCode(event.code)
        ) {
          return
        }
        this.#setError(event.channel_id, event.code)
        break
      }
    }
  }

  #requestId(channelId: string) {
    return `activity-request-${channelId}-${crypto.randomUUID()}`
  }

  #setError(channelId: string, error: ChannelActivityViewState['error']) {
    const current = this.snapshot(channelId)
    if (current.error === error) return
    this.#setState(channelId, { ...current, error })
  }

  #setTransport(
    channelId: string,
    transport: ChannelActivityViewState['transport'],
  ) {
    const current = this.snapshot(channelId)
    if (current.transport === transport) return
    this.#setState(channelId, { ...current, transport })
  }

  #setState(channelId: string, next: ChannelActivityViewState) {
    const current = this.snapshot(channelId)
    if (
      current.instance === next.instance &&
      current.error === next.error &&
      current.transport === next.transport
    )
      return
    this.#state.set(channelId, next)
    this.#listeners.get(channelId)?.forEach((listener) => listener())
  }
}

function activityRequest(
  requestId: string,
  channelId: string,
  request: Record<string, unknown>,
) {
  return {
    type: 'ChannelActivity',
    request_id: requestId,
    channel_id: channelId,
    request,
  }
}

export const channelActivityClient = new ChannelActivityClient(eventsGateway)

function gatewayTransport(
  state: string,
): ChannelActivityViewState['transport'] {
  if (state === 'connected') return 'connected'
  if (state === 'connecting' || state === 'reconnecting') return 'reconnecting'
  return 'disconnected'
}
