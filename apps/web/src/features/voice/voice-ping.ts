import type { Room } from 'livekit-client'

type PCTransportLike = {
  pc?: RTCPeerConnection
  _pc?: RTCPeerConnection
}

type PCTransportManagerLike = {
  publisher?: PCTransportLike
  subscriber?: PCTransportLike
}

export type VoicePeerConnectionEntry = {
  role: 'publisher' | 'subscriber'
  pc: RTCPeerConnection
}

function peerConnectionFromTransport(transport?: PCTransportLike) {
  return transport?.pc ?? transport?._pc ?? null
}

export function getVoicePeerConnectionEntries(room: Room) {
  const manager = (room.engine as { pcManager?: PCTransportManagerLike })
    .pcManager
  if (!manager) return []

  return [
    {
      role: 'publisher' as const,
      pc: peerConnectionFromTransport(manager.publisher),
    },
    {
      role: 'subscriber' as const,
      pc: peerConnectionFromTransport(manager.subscriber),
    },
  ].filter(
    (entry): entry is VoicePeerConnectionEntry => entry.pc != null,
  )
}

async function rttFromPeerConnection(pc: RTCPeerConnection) {
  try {
    const stats = await pc.getStats()
    let best: number | null = null

    stats.forEach((report) => {
      if (report.type === 'candidate-pair') {
        const pair = report as RTCStatsReport & {
          nominated?: boolean
          currentRoundTripTime?: number
        }
        if (pair.nominated && pair.currentRoundTripTime != null) {
          const ms = Math.round(pair.currentRoundTripTime * 1000)
          if (best === null || ms < best) best = ms
        }
      }

      if (report.type === 'remote-inbound-rtp') {
        const rtp = report as RTCStatsReport & { roundTripTime?: number }
        if (rtp.roundTripTime != null) {
          const ms = Math.round(rtp.roundTripTime * 1000)
          if (best === null || ms < best) best = ms
        }
      }
    })

    return best
  } catch {
    return null
  }
}

/** RTT до LiveKit (мс), как в Discord — с клиента через WebRTC stats. */
export async function measureVoicePingMs(room: Room) {
  const connections = getVoicePeerConnectionEntries(room)
  if (connections.length === 0) return null

  const samples = await Promise.all(
    connections.map(({ pc }) => rttFromPeerConnection(pc)),
  )
  const valid = samples.filter((value) => value != null) as number[]
  if (valid.length === 0) return null

  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length)
}

export function formatVoicePingLabel(
  pingMs: number | null,
  connected: boolean,
) {
  if (!connected) return 'Пинг: …'
  if (pingMs == null) return 'Пинг: —'
  return `Пинг: ${pingMs} мс`
}
