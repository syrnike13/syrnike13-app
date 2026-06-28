import type { GatewayServerEvent } from '#/features/sync/types'

export const VOICE_CANCELED_OPERATION_TOMBSTONE_MS = 30_000

let localUserId: string | null = null
const canceledOperationExpiresAt = new Map<string, number>()

export function setLocalVoiceEventUserId(userId: string | null | undefined) {
  localUserId = userId ?? null
}

export function rememberCanceledVoiceOperation(
  operationId: string | null | undefined,
  now = Date.now(),
) {
  if (!operationId) return
  canceledOperationExpiresAt.set(
    operationId,
    now + VOICE_CANCELED_OPERATION_TOMBSTONE_MS,
  )
}

export function resetLocalVoiceEventGuard() {
  localUserId = null
  canceledOperationExpiresAt.clear()
}

function pruneCanceledOperations(now: number) {
  for (const [operationId, expiresAt] of canceledOperationExpiresAt) {
    if (expiresAt <= now) {
      canceledOperationExpiresAt.delete(operationId)
    }
  }
}

function voiceEventUserId(event: GatewayServerEvent) {
  if (typeof event.user === 'string') return event.user
  if (typeof event.user_id === 'string') return event.user_id
  if (typeof event.state?.id === 'string') return event.state.id
  if (typeof event.state?.user === 'string') return event.state.user
  if (typeof event.state?.user_id === 'string') return event.state.user_id
  return null
}

function voiceEventOperationId(event: GatewayServerEvent) {
  if (typeof event.operation_id === 'string') return event.operation_id
  if (typeof event.operationId === 'string') return event.operationId
  return null
}

export function shouldIgnoreVoiceGatewayEvent(
  event: GatewayServerEvent,
  now = Date.now(),
) {
  if (event.type !== 'VoiceChannelJoin' && event.type !== 'VoiceChannelMove') {
    return false
  }
  if (!localUserId || voiceEventUserId(event) !== localUserId) return false

  const operationId = voiceEventOperationId(event)
  if (!operationId) return true

  pruneCanceledOperations(now)
  return (canceledOperationExpiresAt.get(operationId) ?? 0) > now
}
