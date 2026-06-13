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

export type VoiceStateUpdatePayload = {
  operation_id?: string
  channel_id: string | null
  self_mute: boolean
  self_deaf: boolean
  node?: string
  recipients?: string[]
  suppress_call_notifications?: boolean
  refresh_credentials?: boolean
}

const VOICE_SERVER_UPDATE_TIMEOUT_MS = 15_000
const VOICE_STATE_ACK_RETRY_MS = 5_000
const VOICE_STATE_RELIABLE_KEY = 'voice-state'

type PendingVoiceStateUpdate = {
  nonce: string
  event: Record<string, unknown>
  reliableKey: string
  retryTimer: ReturnType<typeof setTimeout> | undefined
}

let pendingVoiceStateUpdate: PendingVoiceStateUpdate | null = null
let voiceStateAckListenerInstalled = false

function createVoiceStateNonce() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function clearPendingVoiceStateUpdate() {
  if (pendingVoiceStateUpdate?.retryTimer !== undefined) {
    clearTimeout(pendingVoiceStateUpdate.retryTimer)
  }
  pendingVoiceStateUpdate = null
}

function scheduleVoiceStateAckRetry() {
  const pending = pendingVoiceStateUpdate
  if (!pending) return
  if (pending.retryTimer !== undefined) {
    clearTimeout(pending.retryTimer)
  }
  pending.retryTimer = setTimeout(() => {
    const current = pendingVoiceStateUpdate
    if (!current || current.nonce !== pending.nonce) return
    eventsGateway.sendReliable(current.event, current.reliableKey)
    scheduleVoiceStateAckRetry()
  }, VOICE_STATE_ACK_RETRY_MS)
}

function voiceStateReliableKey(event: Record<string, unknown>) {
  if (typeof event.operation_id === 'string') {
    return `voice-operation:${event.operation_id}`
  }
  if (event.channel_id === null) {
    return 'voice-leave'
  }
  if (
    typeof event.channel_id === 'string' &&
    event.suppress_call_notifications === true &&
    event.refresh_credentials !== true
  ) {
    return `voice-flags:${event.channel_id}`
  }
  return VOICE_STATE_RELIABLE_KEY
}

function voiceServerUpdateAcknowledgesPending(event: Record<string, unknown>) {
  const pending = pendingVoiceStateUpdate
  if (!pending) return false
  if (event.type !== 'VoiceServerUpdate') return false
  if (
    pending.event.operation_id &&
    event.operation_id !== pending.event.operation_id
  ) {
    return false
  }
  if (event.channel_id !== pending.event.channel_id) return false

  return (
    Boolean(pending.event.node) ||
    pending.event.refresh_credentials === true
  )
}

function ensureVoiceStateAckListener() {
  if (voiceStateAckListenerInstalled) return
  voiceStateAckListenerInstalled = true

  eventsGateway.subscribeEvents((event) => {
    if (event.type === 'VoiceStateAck') {
      if (event.nonce !== pendingVoiceStateUpdate?.nonce) return
      clearPendingVoiceStateUpdate()
      return
    }

    if (voiceServerUpdateAcknowledgesPending(event)) {
      clearPendingVoiceStateUpdate()
    }
  })

  eventsGateway.subscribeState((state) => {
    if (state !== 'idle') return
    clearPendingVoiceStateUpdate()
  })
}

export function sendVoiceStateUpdate(payload: VoiceStateUpdatePayload) {
  ensureVoiceStateAckListener()

  const event = {
    type: 'VoiceStateUpdate',
    nonce: createVoiceStateNonce(),
    ...(payload.operation_id ? { operation_id: payload.operation_id } : {}),
    channel_id: payload.channel_id,
    self_mute: payload.self_mute,
    self_deaf: payload.self_deaf,
    ...(payload.node ? { node: payload.node } : {}),
    ...(payload.recipients ? { recipients: payload.recipients } : {}),
    ...(payload.suppress_call_notifications
      ? { suppress_call_notifications: true }
      : {}),
    ...(payload.refresh_credentials ? { refresh_credentials: true } : {}),
  }

  const reliableKey = voiceStateReliableKey(event)
  clearPendingVoiceStateUpdate()
  pendingVoiceStateUpdate = {
    nonce: event.nonce,
    event,
    reliableKey,
    retryTimer: undefined,
  }
  eventsGateway.sendReliable(event, reliableKey)
  scheduleVoiceStateAckRetry()
}

export function waitForVoiceServerUpdate(
  channelId: string,
  operationId: string,
  timeoutMs = VOICE_SERVER_UPDATE_TIMEOUT_MS,
): Promise<VoiceServerUpdateEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Voice join timed out'))
    }, timeoutMs)

    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      if (event.type === 'VoiceServerUpdate') {
        if (event.channel_id !== channelId) return
        if (event.operation_id !== operationId) return
        clearTimeout(timer)
        unsubscribe()
        resolve(event as VoiceServerUpdateEvent)
        return
      }
      if (event.type === 'Error') {
        clearTimeout(timer)
        unsubscribe()
        const message =
          typeof event.data === 'object' &&
          event.data &&
          'message' in event.data &&
          typeof (event.data as { message?: unknown }).message === 'string'
            ? (event.data as { message: string }).message
            : 'Voice state update failed'
        reject(new Error(message))
      }
    })
  })
}

export async function requestVoiceJoin(
  channelId: string,
  selfMute: boolean,
  selfDeaf: boolean,
  options: {
    operationId: string
    recipients?: string[]
    suppress_call_notifications?: boolean
  },
): Promise<VoiceServerUpdateEvent> {
  const node = await resolveVoiceNodeName()
  const responsePromise = waitForVoiceServerUpdate(channelId, options.operationId)
  sendVoiceStateUpdate({
    operation_id: options.operationId,
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    node,
    recipients: options?.recipients,
    suppress_call_notifications: options?.suppress_call_notifications,
    refresh_credentials: true,
  })
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
    operation_id: operationId,
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    suppress_call_notifications: true,
    refresh_credentials: true,
  })
  return responsePromise
}

export function requestVoiceLeave() {
  sendVoiceStateUpdate({
    channel_id: null,
    self_mute: false,
    self_deaf: false,
  })
}

export function requestVoiceFlagsUpdate(
  channelId: string,
  selfMute: boolean,
  selfDeaf: boolean,
) {
  sendVoiceStateUpdate({
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    suppress_call_notifications: true,
  })
}
