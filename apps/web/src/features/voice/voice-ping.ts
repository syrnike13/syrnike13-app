import type { Translator } from '@syrnike13/ui/i18n'

type VoicePingRoom = {
  engine?: unknown
}

type VoicePeerConnection = Partial<Pick<
  RTCPeerConnection,
  'getSenders' | 'getStats'
>>

export type VoicePeerConnectionEntry = {
  role: 'publisher' | 'subscriber'
  pc: VoicePeerConnection
}

function isVoicePeerConnection(
  value: unknown,
): value is VoicePeerConnection {
  if (!value || typeof value !== 'object') return false
  const getStats = Reflect.get(value, 'getStats')
  const getSenders = Reflect.get(value, 'getSenders')
  return typeof getStats === 'function' || typeof getSenders === 'function'
}

function peerConnectionFromTransport(transport: unknown) {
  if (!transport || typeof transport !== 'object') return null
  const pc =
    'pc' in transport
      ? transport.pc
      : '_pc' in transport
        ? transport._pc
        : null
  return isVoicePeerConnection(pc) ? pc : null
}

export function getVoicePeerConnectionEntries(room: VoicePingRoom) {
  const engine = room.engine
  if (!engine || typeof engine !== 'object' || !('pcManager' in engine)) {
    return []
  }
  const manager = engine.pcManager
  if (!manager || typeof manager !== 'object') return []

  return [
    {
      role: 'publisher' as const,
      pc: peerConnectionFromTransport(
        'publisher' in manager ? manager.publisher : undefined,
      ),
    },
    {
      role: 'subscriber' as const,
      pc: peerConnectionFromTransport(
        'subscriber' in manager ? manager.subscriber : undefined,
      ),
    },
  ].filter(
    (entry): entry is VoicePeerConnectionEntry => entry.pc != null,
  )
}

export function formatVoicePingLabel(
  pingMs: number | null,
  connected: boolean,
  t: Translator,
) {
  if (!connected) return t('ping.connecting')
  if (pingMs == null) return t('ping.unavailable')
  return t('ping.value', { ms: pingMs })
}
