import type { Room } from 'livekit-client'

type PCTransportLike = {
  pc?: RTCPeerConnection
  _pc?: RTCPeerConnection
}

type PCTransportManagerLike = {
  publisher?: PCTransportLike
  subscriber?: PCTransportLike
}

function peerConnectionFromTransport(transport?: PCTransportLike) {
  return transport?.pc ?? transport?._pc ?? null
}

function getRoomPeerConnections(room: Room) {
  const manager = (room.engine as { pcManager?: PCTransportManagerLike })
    .pcManager
  if (!manager) return []

  return [
    peerConnectionFromTransport(manager.publisher),
    peerConnectionFromTransport(manager.subscriber),
  ].filter((pc): pc is RTCPeerConnection => pc != null)
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
  const connections = getRoomPeerConnections(room)
  if (connections.length === 0) return null

  const samples = await Promise.all(
    connections.map((pc) => rttFromPeerConnection(pc)),
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
