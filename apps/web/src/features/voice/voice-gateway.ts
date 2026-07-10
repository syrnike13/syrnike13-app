import { eventsGateway } from '#/features/events/gateway'
import { resolveVoiceNodeName } from '#/features/voice/voice-node'

export type VoiceServerUpdateEvent = {
  type: 'VoiceServerUpdate'
  operation_id: string
  channel_id: string
  node: string
  url: string
  token: string
  native_microphone: { token: string; identity: string }
  native_screen: { token: string; identity: string }
  native_camera: { token: string; identity: string }
}

export type VoiceStateUpdateRequest =
  | { mode: 'disconnect' }
  | { mode: 'join'; operation_id: string }
  | { mode: 'refresh_credentials'; operation_id: string }
  | {
      mode: 'replace_operation'
      operation_id: string
      expected_current_operation_id: string
    }
  | {
      mode: 'retain_finalized'
      operation_id: string
      expected_current_operation_id: string
    }

export type VoiceStateUpdatePayload = {
  request: VoiceStateUpdateRequest
  channel_id: string | null
  self_mute: boolean
  self_deaf: boolean
  node?: string
  recipients?: string[]
  suppress_call_notifications?: boolean
}

type GatewayErrorEvent = {
  type: 'Error'
  fatal?: boolean
  scope?: string
  request?: {
    kind?: string
    operation_id?: string
    channel_id?: string
    authoritative_operation_id?: string
    authoritative_channel_id?: string
  }
  data?: unknown
}

const VOICE_SERVER_UPDATE_TIMEOUT_MS = 15_000
const VOICE_STATE_ACK_RETRY_MS = 5_000
const VOICE_STATE_RELIABLE_KEY = 'voice-state'

export class VoiceGatewayRequestError extends Error {
  readonly authoritativeOperationId: string | null
  readonly authoritativeChannelId: string | null

  constructor(message: string, event: GatewayErrorEvent) {
    super(message)
    this.name = 'VoiceGatewayRequestError'
    this.authoritativeOperationId =
      event.request?.authoritative_operation_id ?? null
    this.authoritativeChannelId =
      event.request?.authoritative_channel_id ?? null
  }
}

function voiceRequestAbortedError() {
  const error = new Error('Voice operation was superseded')
  error.name = 'AbortError'
  return error
}

export function isVoiceRequestAborted(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

type PendingVoiceStateUpdate = {
  nonce: string
  event: Record<string, unknown>
  reliableKey: string
  retryTimer: ReturnType<typeof setTimeout> | undefined
}

const pendingVoiceStateUpdates = new Map<string, PendingVoiceStateUpdate>()
let voiceStateAckListenerInstalled = false

function createVoiceStateNonce() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function clearPendingVoiceStateUpdate(reliableKey: string) {
  const pending = pendingVoiceStateUpdates.get(reliableKey)
  if (pending?.retryTimer !== undefined) {
    clearTimeout(pending.retryTimer)
  }
  pendingVoiceStateUpdates.delete(reliableKey)
}

function clearPendingVoiceStateUpdates() {
  for (const reliableKey of pendingVoiceStateUpdates.keys()) {
    clearPendingVoiceStateUpdate(reliableKey)
  }
}

function scheduleVoiceStateAckRetry(pending: PendingVoiceStateUpdate) {
  if (pending.retryTimer !== undefined) {
    clearTimeout(pending.retryTimer)
  }
  pending.retryTimer = setTimeout(() => {
    const current = pendingVoiceStateUpdates.get(pending.reliableKey)
    if (!current || current.nonce !== pending.nonce) return
    eventsGateway.sendReliable(current.event, current.reliableKey)
    scheduleVoiceStateAckRetry(current)
  }, VOICE_STATE_ACK_RETRY_MS)
}

function voiceStateReliableKey(event: Record<string, unknown>) {
  const request = event.request as VoiceStateUpdateRequest | undefined
  if (request?.mode === 'disconnect') {
    return 'voice-leave'
  }
  if (
    typeof event.channel_id === 'string' &&
    event.suppress_call_notifications === true &&
    request?.mode === 'join'
  ) {
    return `voice-flags:${event.channel_id}`
  }
  if (request && 'operation_id' in request) {
    return `voice-operation:${request.operation_id}`
  }
  return VOICE_STATE_RELIABLE_KEY
}

function voiceServerUpdateAcknowledgesPending(
  event: Record<string, unknown>,
  pending: PendingVoiceStateUpdate,
) {
  if (event.type !== 'VoiceServerUpdate') return false
  const request = pending.event.request as VoiceStateUpdateRequest | undefined
  if (!request || !('operation_id' in request)) return false
  if (event.operation_id !== request.operation_id) {
    return false
  }
  if (event.channel_id !== pending.event.channel_id) return false

  if (
    request.mode === 'join' &&
    pending.event.suppress_call_notifications === true &&
    !pending.event.node
  ) {
    return false
  }

  return true
}

function voiceErrorMatchesOperation(
  event: Record<string, unknown>,
  channelId: string,
  operationId: string,
) {
  if (event.type !== 'Error') return false
  const error = event as GatewayErrorEvent
  if (error.fatal !== false) return true
  if (error.scope !== 'VoiceStateUpdate') return false
  if (error.request?.kind !== 'VoiceStateUpdate') return true
  if (typeof error.request.operation_id !== 'string') return true
  if (error.request.operation_id !== operationId) return false
  if (
    typeof error.request.channel_id === 'string' &&
    error.request.channel_id !== channelId
  ) {
    return false
  }
  return true
}

function gatewayErrorMessage(event: Record<string, unknown>) {
  const data = event.data
  if (
    typeof data === 'object' &&
    data &&
    'message' in data &&
    typeof (data as { message?: unknown }).message === 'string'
  ) {
    return (data as { message: string }).message
  }
  return 'Voice state update failed'
}

function ensureVoiceStateAckListener() {
  if (voiceStateAckListenerInstalled) return
  voiceStateAckListenerInstalled = true

  eventsGateway.subscribeEvents((event) => {
    if (event.type === 'VoiceStateAck') {
      const pending = [...pendingVoiceStateUpdates.values()].find(
        (candidate) => candidate.nonce === event.nonce,
      )
      if (!pending) return
      clearPendingVoiceStateUpdate(pending.reliableKey)
      return
    }

    for (const pending of pendingVoiceStateUpdates.values()) {
      if (voiceServerUpdateAcknowledgesPending(event, pending)) {
        clearPendingVoiceStateUpdate(pending.reliableKey)
      }
    }
  })

  eventsGateway.subscribeState((state) => {
    if (state !== 'idle') return
    clearPendingVoiceStateUpdates()
  })
}

export function sendVoiceStateUpdate(
  payload: VoiceStateUpdatePayload,
  onDispatched?: () => void,
) {
  ensureVoiceStateAckListener()

  const event = {
    type: 'VoiceStateUpdate',
    nonce: createVoiceStateNonce(),
    request: payload.request,
    channel_id: payload.channel_id,
    self_mute: payload.self_mute,
    self_deaf: payload.self_deaf,
    ...(payload.node ? { node: payload.node } : {}),
    ...(payload.recipients ? { recipients: payload.recipients } : {}),
    ...(payload.suppress_call_notifications
      ? { suppress_call_notifications: true }
      : {}),
  }

  const reliableKey = voiceStateReliableKey(event)
  clearPendingVoiceStateUpdate(reliableKey)
  const pending: PendingVoiceStateUpdate = {
    nonce: event.nonce,
    event,
    reliableKey,
    retryTimer: undefined,
  }
  pendingVoiceStateUpdates.set(reliableKey, pending)
  eventsGateway.sendReliable(event, reliableKey)
  onDispatched?.()
  scheduleVoiceStateAckRetry(pending)
}

export function waitForVoiceServerUpdate(
  channelId: string,
  operationId: string,
  timeoutMs = VOICE_SERVER_UPDATE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<VoiceServerUpdateEvent> {
  if (signal?.aborted) {
    return Promise.reject(voiceRequestAbortedError())
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const finish = (result: VoiceServerUpdateEvent | Error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    const onAbort = () => finish(voiceRequestAbortedError())

    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      if (event.type === 'VoiceServerUpdate') {
        if (event.channel_id !== channelId) return
        if (event.operation_id !== operationId) return
        finish(event as VoiceServerUpdateEvent)
        return
      }
      if (voiceErrorMatchesOperation(event, channelId, operationId)) {
        finish(new VoiceGatewayRequestError(
          gatewayErrorMessage(event),
          event as GatewayErrorEvent,
        ))
      }
    })

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    timer = setTimeout(() => finish(new Error('Voice join timed out')), timeoutMs)
  })
}

export async function requestVoiceJoin(
  channelId: string,
  selfMute: boolean,
  selfDeaf: boolean,
  options: {
    operationId: string
    expectedCurrentOperationId?: string
    recipients?: string[]
    suppress_call_notifications?: boolean
    retainFinalized?: boolean
    onDispatched?: () => void
    signal?: AbortSignal
  },
): Promise<VoiceServerUpdateEvent> {
  if (options.retainFinalized && !options.expectedCurrentOperationId) {
    throw new Error('Retaining finalized voice requires the expected current operation')
  }
  const request: VoiceStateUpdateRequest = options.retainFinalized
    ? {
        mode: 'retain_finalized',
        operation_id: options.operationId,
        expected_current_operation_id: options.expectedCurrentOperationId!,
      }
    : options.expectedCurrentOperationId
      ? {
        mode: 'replace_operation',
        operation_id: options.operationId,
        expected_current_operation_id: options.expectedCurrentOperationId,
      }
      : { mode: 'join', operation_id: options.operationId }
  const node = request.mode === 'join' ? await resolveVoiceNodeName() : undefined
  if (options.signal?.aborted) throw voiceRequestAbortedError()
  const responsePromise = waitForVoiceServerUpdate(
    channelId,
    options.operationId,
    VOICE_SERVER_UPDATE_TIMEOUT_MS,
  )
  sendVoiceStateUpdate({
    request,
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    node,
    recipients: options?.recipients,
    suppress_call_notifications: options?.suppress_call_notifications,
  }, options.onDispatched)
  return responsePromise
}

export async function requestVoiceCredentialsRefresh(
  channelId: string,
  selfMute: boolean,
  selfDeaf: boolean,
  operationId: string,
): Promise<VoiceServerUpdateEvent> {
  const responsePromise = waitForVoiceServerUpdate(channelId, operationId)
  sendVoiceStateUpdate({
    request: { mode: 'refresh_credentials', operation_id: operationId },
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    suppress_call_notifications: true,
  })
  return responsePromise
}

export function requestVoiceLeave() {
  sendVoiceStateUpdate({
    request: { mode: 'disconnect' },
    channel_id: null,
    self_mute: false,
    self_deaf: false,
  })
}

export function requestVoiceFlagsUpdate(
  channelId: string,
  selfMute: boolean,
  selfDeaf: boolean,
  operationId: string,
) {
  sendVoiceStateUpdate({
    request: { mode: 'join', operation_id: operationId },
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    suppress_call_notifications: true,
  })
}
