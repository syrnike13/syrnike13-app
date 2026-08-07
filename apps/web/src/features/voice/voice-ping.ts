import { Effect, Option, Schema } from 'effect'

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

const CandidatePairRttSchema = Schema.Struct({
  type: Schema.Literal('candidate-pair'),
  nominated: Schema.optionalKey(Schema.Boolean),
  currentRoundTripTime: Schema.optionalKey(Schema.Number),
})

const RemoteInboundRttSchema = Schema.Struct({
  type: Schema.Literal('remote-inbound-rtp'),
  roundTripTime: Schema.optionalKey(Schema.Number),
})

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

const rttFromPeerConnection = Effect.fn('voice.measurePeerConnectionRtt')(
  function*(
    pc: VoicePeerConnection,
  ) {
    const getStats = pc.getStats
    if (!getStats) return null
    const stats = yield* Effect.tryPromise({
      try: () => getStats.call(pc),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(null)))
    if (!stats) return null

    const samples: number[] = []

    stats.forEach((report: unknown) => {
      const candidatePair =
        Schema.decodeUnknownOption(CandidatePairRttSchema)(report)
      if (Option.isSome(candidatePair)) {
        const pair = candidatePair.value
        if (pair.nominated && pair.currentRoundTripTime != null) {
          samples.push(Math.round(pair.currentRoundTripTime * 1000))
        }
      }

      const remoteInbound =
        Schema.decodeUnknownOption(RemoteInboundRttSchema)(report)
      if (Option.isSome(remoteInbound)) {
        const rtp = remoteInbound.value
        if (rtp.roundTripTime != null) {
          samples.push(Math.round(rtp.roundTripTime * 1000))
        }
      }
    })

    return samples.length === 0 ? null : Math.min(...samples)
  },
)

/** RTT до LiveKit (мс), как в Discord — с клиента через WebRTC stats. */
const measureVoicePingMsEffect = Effect.fn('voice.measurePing')(
  function*(room: VoicePingRoom) {
    const connections = getVoicePeerConnectionEntries(room)
    if (connections.length === 0) return null

    const samples = yield* Effect.all(
      connections.map(({ pc }) => rttFromPeerConnection(pc)),
      { concurrency: 'unbounded' },
    )
    const valid = samples.filter((value): value is number => value != null)
    if (valid.length === 0) return null

    return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length)
  },
)

export function measureVoicePingMs(room: VoicePingRoom) {
  return Effect.runPromise(measureVoicePingMsEffect(room))
}

export function formatVoicePingLabel(
  pingMs: number | null,
  connected: boolean,
) {
  if (!connected) return 'Пинг: …'
  if (pingMs == null) return 'Пинг: —'
  return `Пинг: ${pingMs} мс`
}
