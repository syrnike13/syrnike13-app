import type {
  ActivityEndReason,
  ActivityInstance,
  ActivitySharedState,
  GatewayServerEvent,
} from '@syrnike13/api-types/gateway-schema'
import type {
  ConnectionStatus,
  ErrorCode,
  JsonValue,
} from '@syrnike13/activity-sdk/protocol'

import { randomUuid } from '@syrnike13/client/lib/random-uuid'

/** Gateway surface the store needs; `eventsGateway` satisfies it. */
export type ActivityGateway = Readonly<{
  state: string
  send(event: Record<string, unknown>): void
  sendReliable(event: Record<string, unknown>, key?: string): void
  subscribeServerEvents(listener: (event: GatewayServerEvent) => void): () => void
  subscribeState(listener: (state: string) => void): () => void
}>

type GatewayActivityResponse = Extract<
  GatewayServerEvent,
  { type: 'ActivityResponse' }
>

export type ActivityInstanceEvent =
  | Readonly<{ type: 'message'; from: string; payload: JsonValue }>
  | Readonly<{ type: 'state'; state: ActivitySharedState }>
  | Readonly<{ type: 'ended'; reason: ActivityEndReason }>

type InstanceListener = (event: ActivityInstanceEvent) => void

type PendingRequest = {
  resolve: (response: GatewayActivityResponse) => void
  reject: (error: ActivityRequestError) => void
  timer: ReturnType<typeof setTimeout>
}

type ActivityAction =
  | Readonly<{ action: 'start'; application_id: string }>
  | Readonly<{ action: 'join'; instance_id: string }>
  | Readonly<{ action: 'leave'; instance_id: string }>
  | Readonly<{ action: 'end'; instance_id: string }>
  | Readonly<{ action: 'sync'; instance_id: string }>
  | Readonly<{
      action: 'send'
      instance_id: string
      payload: JsonValue
      to?: readonly string[]
    }>
  | Readonly<{
      action: 'set_state'
      instance_id: string
      expected_version: number
      data: JsonValue
    }>

const REQUEST_TIMEOUT_MS = 15_000
const ENDED_INSTANCE_MEMORY = 256
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'invalid_request',
  'not_in_voice_channel',
  'missing_permission',
  'unknown_application',
  'already_running',
  'instance_not_found',
  'not_participant',
  'full',
  'not_allowed',
  'payload_too_large',
  'rate_limited',
  'version_conflict',
  'internal',
])
const LIFECYCLE_ACTIONS: ReadonlySet<ActivityAction['action']> = new Set([
  'start',
  'join',
  'leave',
  'end',
])

export class ActivityRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly response?: GatewayActivityResponse,
  ) {
    super(`Activity request failed: ${code}`)
    this.name = 'ActivityRequestError'
  }
}

function responseErrorCode(code: string): ErrorCode {
  return KNOWN_ERROR_CODES.has(code) ? (code as ErrorCode) : 'internal'
}

export function isActivityParticipant(
  instance: ActivityInstance | null | undefined,
  userId: string | null | undefined,
) {
  return Boolean(
    instance &&
      userId &&
      instance.participants.some((participant) => participant.user_id === userId),
  )
}

/**
 * Client projection of running Activity Instances (ADR-0011).
 *
 * Instances arrive with `Ready`, `ActivityInstanceUpdate` and
 * `ActivityInstanceEnd`; older revisions are dropped. Requests are correlated
 * with `ActivityResponse` by `request_id`. Messages and shared state go to
 * per-instance listeners (the Activity Frame).
 */
export class ActivityStore {
  #gateway: ActivityGateway | null = null
  #currentUserId: string | null = null
  #detach: (() => void) | null = null
  #instances = new Map<string, ActivityInstance>()
  #states = new Map<string, ActivitySharedState>()
  #ended = new Set<string>()
  #pending = new Map<string, PendingRequest>()
  #instanceListeners = new Map<string, Set<InstanceListener>>()
  #listeners = new Set<() => void>()
  #status: ConnectionStatus = 'reconnecting'
  #version = 0

  setCurrentUserId(userId: string | null) {
    if (this.#currentUserId === userId) return
    this.#currentUserId = userId
    this.#emit()
  }

  attach(gateway: ActivityGateway) {
    if (this.#gateway === gateway) return
    this.detach()
    this.#gateway = gateway
    const unsubscribeEvents = gateway.subscribeServerEvents((event) =>
      this.handleGatewayEvent(event),
    )
    let previous = gateway.state
    const unsubscribeState = gateway.subscribeState((state) => {
      this.#setStatus(state === 'connected' ? 'connected' : 'reconnecting')
      if (state === 'connected' && previous !== 'connected') {
        this.#resyncJoined()
      }
      previous = state
    })
    this.#detach = () => {
      unsubscribeEvents()
      unsubscribeState()
    }
  }

  detach() {
    this.#detach?.()
    this.#detach = null
    this.#gateway = null
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new ActivityRequestError('disconnected'))
      this.#pending.delete(requestId)
    }
    this.#instances.clear()
    this.#states.clear()
    this.#setStatus('reconnecting')
    this.#emit()
  }

  // ---------------------------------------------------------------------------
  // Snapshot

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  get version() {
    return this.#version
  }

  get status() {
    return this.#status
  }

  get currentUserId() {
    return this.#currentUserId
  }

  instanceForChannel(channelId: string) {
    return this.#instances.get(channelId) ?? null
  }

  sharedState(instanceId: string) {
    return this.#states.get(instanceId) ?? null
  }

  subscribeInstance(instanceId: string, listener: InstanceListener) {
    let listeners = this.#instanceListeners.get(instanceId)
    if (!listeners) {
      listeners = new Set()
      this.#instanceListeners.set(instanceId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#instanceListeners.delete(instanceId)
    }
  }

  // ---------------------------------------------------------------------------
  // Requests

  async start(channelId: string, applicationId: string) {
    const response = await this.#request(channelId, {
      action: 'start',
      application_id: applicationId,
    })
    return response.instance ?? null
  }

  async join(channelId: string, instanceId: string) {
    const response = await this.#request(channelId, {
      action: 'join',
      instance_id: instanceId,
    })
    return response.instance ?? null
  }

  async leave(channelId: string, instanceId: string) {
    await this.#request(channelId, { action: 'leave', instance_id: instanceId })
  }

  async end(channelId: string, instanceId: string) {
    await this.#request(channelId, { action: 'end', instance_id: instanceId })
  }

  async sync(channelId: string, instanceId: string) {
    const response = await this.#request(channelId, {
      action: 'sync',
      instance_id: instanceId,
    })
    return response.state ?? null
  }

  async sendMessage(
    channelId: string,
    instanceId: string,
    payload: JsonValue,
    to?: readonly string[],
  ) {
    await this.#request(channelId, {
      action: 'send',
      instance_id: instanceId,
      payload,
      ...(to ? { to } : {}),
    })
  }

  /** Compare-and-set; a conflict resolves with `ok: false` and the current state. */
  async setState(
    channelId: string,
    instanceId: string,
    expectedVersion: number,
    data: JsonValue,
  ): Promise<{ ok: boolean; state: ActivitySharedState | null }> {
    try {
      const response = await this.#request(channelId, {
        action: 'set_state',
        instance_id: instanceId,
        expected_version: expectedVersion,
        data,
      })
      return { ok: true, state: response.state ?? null }
    } catch (error) {
      if (
        error instanceof ActivityRequestError &&
        error.code === 'version_conflict'
      ) {
        return { ok: false, state: error.response?.state ?? null }
      }
      throw error
    }
  }

  #request(
    channelId: string,
    request: ActivityAction,
  ): Promise<GatewayActivityResponse> {
    const gateway = this.#gateway
    if (!gateway) {
      return Promise.reject(new ActivityRequestError('disconnected'))
    }
    const lifecycle = LIFECYCLE_ACTIONS.has(request.action)
    if (!lifecycle && gateway.state !== 'connected') {
      return Promise.reject(new ActivityRequestError('disconnected'))
    }

    const requestId = randomUuid()
    const event = {
      type: 'Activity',
      request_id: requestId,
      request: { ...request, channel_id: channelId },
    }

    return new Promise<GatewayActivityResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(new ActivityRequestError('timeout'))
      }, REQUEST_TIMEOUT_MS)
      this.#pending.set(requestId, { resolve, reject, timer })
      if (lifecycle) {
        gateway.sendReliable(event, `activity:${requestId}`)
      } else {
        gateway.send(event)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Gateway events

  handleGatewayEvent(event: GatewayServerEvent) {
    switch (event.type) {
      case 'Bulk':
        for (const item of event.v) this.handleGatewayEvent(item)
        return
      case 'Ready':
        if (event.activities) this.#replaceInstances(event.activities)
        return
      case 'ActivityInstanceUpdate':
        this.#applyInstance(event.instance)
        return
      case 'ActivityInstanceEnd':
        this.#endInstance(event.channel_id, event.instance_id, event.reason)
        return
      case 'ActivityMessage':
        this.#dispatch(event.instance_id, {
          type: 'message',
          from: event.from,
          payload: event.payload as JsonValue,
        })
        return
      case 'ActivityState':
        this.#applyState(event.state)
        return
      case 'ActivityResponse':
        this.#resolveResponse(event)
        return
      default:
        return
    }
  }

  #resolveResponse(response: GatewayActivityResponse) {
    if (response.instance) this.#applyInstance(response.instance)
    if (response.state) this.#applyState(response.state)
    const pending = this.#pending.get(response.request_id)
    if (!pending) return
    this.#pending.delete(response.request_id)
    clearTimeout(pending.timer)
    if (response.error) {
      pending.reject(
        new ActivityRequestError(responseErrorCode(response.error), response),
      )
    } else {
      pending.resolve(response)
    }
  }

  #replaceInstances(instances: readonly ActivityInstance[]) {
    const next = new Map<string, ActivityInstance>()
    for (const instance of instances) {
      if (this.#ended.has(instance.id)) continue
      next.set(instance.channel_id, instance)
    }
    for (const [channelId, previous] of this.#instances) {
      if (next.get(channelId)?.id !== previous.id) {
        this.#states.delete(previous.id)
      }
    }
    this.#instances = next
    this.#emit()
  }

  #applyInstance(instance: ActivityInstance) {
    if (this.#ended.has(instance.id)) return
    const current = this.#instances.get(instance.channel_id)
    if (current?.id === instance.id && current.revision >= instance.revision) {
      return
    }
    if (current && current.id !== instance.id) {
      this.#states.delete(current.id)
    }
    this.#instances.set(instance.channel_id, instance)
    this.#emit()
  }

  #endInstance(channelId: string, instanceId: string, reason: ActivityEndReason) {
    this.#ended.add(instanceId)
    if (this.#ended.size > ENDED_INSTANCE_MEMORY) {
      const oldest = this.#ended.values().next().value
      if (oldest !== undefined) this.#ended.delete(oldest)
    }
    this.#states.delete(instanceId)
    if (this.#instances.get(channelId)?.id === instanceId) {
      this.#instances.delete(channelId)
      this.#emit()
    }
    this.#dispatch(instanceId, { type: 'ended', reason })
  }

  #applyState(state: ActivitySharedState) {
    const current = this.#states.get(state.instance_id)
    if (current && current.version > state.version) return
    this.#states.set(state.instance_id, state)
    this.#dispatch(state.instance_id, { type: 'state', state })
  }

  #dispatch(instanceId: string, event: ActivityInstanceEvent) {
    this.#instanceListeners.get(instanceId)?.forEach((listener) => listener(event))
  }

  /** After a reconnect the joined instance's shared state may be stale. */
  #resyncJoined() {
    for (const instance of this.#instances.values()) {
      if (!isActivityParticipant(instance, this.#currentUserId)) continue
      this.sync(instance.channel_id, instance.id).catch(() => undefined)
    }
  }

  #setStatus(status: ConnectionStatus) {
    if (this.#status === status) return
    this.#status = status
    this.#emit()
  }

  #emit() {
    this.#version += 1
    this.#listeners.forEach((listener) => listener())
  }
}

export const activityStore = new ActivityStore()
