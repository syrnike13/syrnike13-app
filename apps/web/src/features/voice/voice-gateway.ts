import { eventsGateway } from '#/features/events/gateway'
import { resolveVoiceNodeName } from '#/features/voice/voice-node'

export type VoiceServerUpdateEvent = {
  type: 'VoiceServerUpdate'
  channel_id: string
  node: string
  url: string
  token: string
  native_microphone: { token: string; identity: string }
  native_screen: { token: string; identity: string }
  native_camera: { token: string; identity: string }
}

export type VoiceStateUpdatePayload = {
  channel_id: string | null
  self_mute: boolean
  self_deaf: boolean
  node?: string
  force_disconnect?: boolean
  recipients?: string[]
  refresh_credentials?: boolean
}

const VOICE_SERVER_UPDATE_TIMEOUT_MS = 15_000
const VOICE_STATE_ACK_RETRY_MS = 5_000
const VOICE_STATE_RELIABLE_KEY = 'voice-state'

type PendingVoiceStateUpdate = {
  nonce: string
  event: Record<string, unknown>
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
    eventsGateway.sendReliable(current.event, VOICE_STATE_RELIABLE_KEY)
    scheduleVoiceStateAckRetry()
  }, VOICE_STATE_ACK_RETRY_MS)
}

function voiceServerUpdateAcknowledgesPending(event: Record<string, unknown>) {
  const pending = pendingVoiceStateUpdate
  if (!pending) return false
  if (event.type !== 'VoiceServerUpdate') return false
  if (event.channel_id !== pending.event.channel_id) return false

  return (
    Boolean(pending.event.node) ||
    pending.event.refresh_credentials === true ||
    pending.event.force_disconnect === true
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
    channel_id: payload.channel_id,
    self_mute: payload.self_mute,
    self_deaf: payload.self_deaf,
    ...(payload.node ? { node: payload.node } : {}),
    ...(payload.force_disconnect !== undefined
      ? { force_disconnect: payload.force_disconnect }
      : {}),
    ...(payload.recipients ? { recipients: payload.recipients } : {}),
    ...(payload.refresh_credentials ? { refresh_credentials: true } : {}),
  }

  clearPendingVoiceStateUpdate()
  pendingVoiceStateUpdate = {
    nonce: event.nonce,
    event,
    retryTimer: undefined,
  }
  eventsGateway.sendReliable(event, VOICE_STATE_RELIABLE_KEY)
  scheduleVoiceStateAckRetry()
}

export function waitForVoiceServerUpdate(
  channelId: string,
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
  options?: { force_disconnect?: boolean; recipients?: string[] },
): Promise<VoiceServerUpdateEvent> {
  const node = await resolveVoiceNodeName()
  const responsePromise = waitForVoiceServerUpdate(channelId)
  sendVoiceStateUpdate({
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    node,
    force_disconnect: options?.force_disconnect ?? true,
    recipients: options?.recipients,
    refresh_credentials: true,
  })
  return responsePromise
}

export async function requestVoiceCredentialsRefresh(
  channelId: string,
  selfMute: boolean,
  selfDeaf: boolean,
): Promise<VoiceServerUpdateEvent> {
  const responsePromise = waitForVoiceServerUpdate(channelId)
  sendVoiceStateUpdate({
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    force_disconnect: false,
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
    force_disconnect: false,
  })
}
